"""
api/routes/exam_routes.py
Exam Portal API — Room management, questions, submissions, leaderboard.
Uses Upstash Redis REST API (same pattern as analytics_routes.py).
"""

import sys
import json
import string
import random
import time
import uuid
from pathlib import Path
from flask import Blueprint, request, jsonify

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from utils.analytics import analytics_tracker
from core.web_executor import execute as web_execute

exam_bp = Blueprint("exam_bp", __name__)

# ── Redis helpers (re-use same Upstash instance) ─────────────────────────────

def _redis_cmd(commands: list) -> list | None:
    """Execute Redis pipeline via Upstash REST."""
    return analytics_tracker._redis_pipeline(commands)


def _redis_one(command: list):
    """Execute a single Redis command and return its result."""
    res = _redis_cmd([command])
    if res and len(res) >= 1:
        return res[0]
    return None


def _hgetall(key: str) -> dict:
    """Fetch a Redis Hash as a Python dict."""
    raw = _redis_one(["HGETALL", key])
    if not isinstance(raw, list):
        return {}
    result = {}
    for i in range(0, len(raw) - 1, 2):
        result[raw[i]] = raw[i + 1]
    return result


def _room_key(room_id: str) -> str:
    return f"room:{room_id}"


def _get_room_meta(room_id: str) -> dict:
    """Fetch metadata of the room from its single Redis Hash key."""
    fields = ["title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt"]
    raw = _redis_one(["HMGET", f"room:{room_id}"] + fields)
    if not isinstance(raw, list) or len(raw) != len(fields):
        return {}
    result = {}
    for k, v in zip(fields, raw):
        if v is not None:
            result[k] = v
    return result


# ── Room ID generation ────────────────────────────────────────────────────────

def _gen_room_id() -> str:
    """Generate a unique 6-char alphanumeric Room ID (e.g. MNG-4X9)."""
    chars = string.ascii_uppercase + string.digits
    for _ in range(20):  # max 20 attempts
        part1 = "MNG"
        part2 = "".join(random.choices(chars, k=3))
        room_id = f"{part1}-{part2}"
        # Collision check
        exists = _redis_one(["EXISTS", f"room:{room_id}"])
        if not exists:
            return room_id
    # Fallback: longer random id
    return "MNG-" + "".join(random.choices(chars, k=4))


# ── Grading Engine (server-side) ──────────────────────────────────────────────

def _normalize_doc(doc: dict) -> dict:
    """Strip _id and ObjectId wrappers for comparison."""
    if not isinstance(doc, dict):
        return doc
    return {
        k: v for k, v in doc.items()
        if k != "_id" and not (isinstance(k, str) and k.startswith("$"))
    }


def _sort_key(doc) -> str:
    """Deterministic sort key for a document."""
    if not isinstance(doc, dict):
        return str(doc)
    # Try first string field
    for v in doc.values():
        if isinstance(v, str):
            return v
    return json.dumps(doc, sort_keys=True, default=str)


def grade_query_answer(student_output: list, frozen_answer: list) -> dict:
    """
    Server-side grading: order-insensitive document-level equality.
    Returns { match: bool, score: int }
    """
    if not isinstance(student_output, list) or not isinstance(frozen_answer, list):
        return {"match": False, "score": 0}
    if len(student_output) != len(frozen_answer):
        return {"match": False, "score": 0}
    try:
        norm_student = sorted([_normalize_doc(d) for d in student_output], key=_sort_key)
        norm_answer = sorted([_normalize_doc(d) for d in frozen_answer], key=_sort_key)
        match = json.dumps(norm_student, sort_keys=True, default=str) == \
                json.dumps(norm_answer, sort_keys=True, default=str)
        return {"match": match, "score": 1 if match else 0}
    except Exception:
        return {"match": False, "score": 0}


# ── Execute query against room dataset ────────────────────────────────────────

def _execute_room_query(room_id: str, dataset_ids, query: str, max_results: int = 100000):
    """Load datasets from Redis and execute query against them."""
    import json as _json
    import mongomock
    from bson import json_util
    import traceback

    try:
        if not isinstance(dataset_ids, list):
            if dataset_ids:
                dataset_ids = [dataset_ids]
            else:
                dataset_ids = []

        # Build temp mongomock DB
        temp_client = mongomock.MongoClient()
        temp_db = temp_client["exam_db"]

        # Batch HMGET for all dataset docs and metadata to optimize DB roundtrips
        hmget_fields = []
        for d_id in dataset_ids:
            if d_id:
                hmget_fields.extend([f"dataset_docs:{d_id}", f"dataset_meta:{d_id}"])
        
        raw_data = []
        if hmget_fields:
            raw_data = _redis_one(["HMGET", f"room:{room_id}"] + hmget_fields) or []

        loaded_count = 0
        idx = 0
        for d_id in dataset_ids:
            if not d_id:
                continue
            docs_json = raw_data[idx] if idx < len(raw_data) else None
            meta_json = raw_data[idx+1] if idx+1 < len(raw_data) else None
            idx += 2

            if not docs_json:
                continue
            try:
                docs = json.loads(docs_json)
            except Exception:
                continue

            meta = {}
            if meta_json:
                try:
                    meta = json.loads(meta_json)
                except Exception:
                    pass
            raw_name = meta.get("name", "")
            raw_coll = meta.get("collection", "")

            names_to_register = set()
            if raw_name:
                names_to_register.add(raw_name)
                names_to_register.add(raw_name.lower())
                names_to_register.add("".join(c for c in raw_name.lower() if c.isalnum() or c == "_"))
            if raw_coll:
                names_to_register.add(raw_coll)
                names_to_register.add(raw_coll.lower())
            names_to_register.add(d_id)

            if docs:
                for coll in names_to_register:
                    if coll:
                        try:
                            parsed_docs = json_util.loads(_json.dumps(docs))
                            for d in parsed_docs:
                                if isinstance(d, dict):
                                    d.pop("_id", None)
                            if parsed_docs:
                                temp_db[coll].insert_many(parsed_docs)
                        except Exception:
                            pass
                loaded_count += 1

        if loaded_count == 0:
            return {"status": "error", "error": "No datasets found/loaded in room"}

        result = web_execute(query, max_results=max_results, db=temp_db)
        res_dict = result.to_dict()
        res_dict["results"] = res_dict.get("data") if res_dict.get("data") is not None else []
        return res_dict
    except Exception as e:
        return {"status": "error", "error": f"Execution error: {str(e)}", "traceback": traceback.format_exc()}


# ── API Routes ────────────────────────────────────────────────────────────────

@exam_bp.route("/api/exam/room/create", methods=["POST"])
def api_exam_create_room():
    """Create a new exam room in Redis."""
    body = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "Untitled Assessment").strip()
    mentor_id = body.get("mentorId", str(uuid.uuid4()))
    timed = bool(body.get("timed", False))
    duration = int(body.get("duration", 60))

    if not title:
        return jsonify({"status": "error", "error": "Title is required"}), 400

    room_id = _gen_room_id()
    now = int(time.time())

    pipeline = [
        ["HSET", _room_key(room_id),
         "title", title,
         "mentorId", mentor_id,
         "timed", "1" if timed else "0",
         "duration", str(duration),
         "status", "waiting",
         "createdAt", str(now)],
        ["EXPIRE", _room_key(room_id), str(60 * 60 * 24 * 7)],  # 7-day TTL
    ]
    res = _redis_cmd(pipeline)
    if res is None:
        return jsonify({"status": "error", "error": "Redis unavailable"}), 503

    return jsonify({
        "status": "ok",
        "roomId": room_id,
        "mentorId": mentor_id,
        "title": title,
    })


@exam_bp.route("/api/exam/room/<room_id>", methods=["GET"])
def api_exam_get_room(room_id: str):
    """Fetch room metadata + questions + participants."""
    fields = [
        "title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt",
        "questions", "participants", "datasets", "kicked"
    ]
    raw = _redis_one(["HMGET", f"room:{room_id}"] + fields)
    if not raw or all(v is None for v in raw):
        return jsonify({"status": "error", "error": "Room not found"}), 404

    # Extract metadata fields
    meta_keys = ["title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt"]
    meta = {}
    for k, v in zip(meta_keys, raw[:8]):
        if v is not None:
            meta[k] = v

    questions_json = raw[8]
    participants_json = raw[9]
    datasets_json = raw[10]
    kicked_json = raw[11]

    # Questions
    questions = []
    if questions_json:
        try:
            questions = json.loads(questions_json)
        except Exception:
            pass

    # Strip correctOption from questions if not requested by the mentor
    is_mentor = request.args.get("mentorId", "") == meta.get("mentorId", "")
    if not is_mentor:
        for q in questions:
            if q.get("type") == "mcq":
                q.pop("correctOption", None)

    # Participants
    participants_raw = json.loads(participants_json) if participants_json else {}
    participants = []
    for sid, p_val in participants_raw.items():
        try:
            p = json.loads(p_val) if isinstance(p_val, str) else p_val
            p["studentId"] = sid
            participants.append(p)
        except Exception:
            pass

    # Datasets
    datasets_raw = json.loads(datasets_json) if datasets_json else {}
    datasets = []
    for ds_id, ds_val in datasets_raw.items():
        try:
            ds = json.loads(ds_val) if isinstance(ds_val, str) else ds_val
            ds["datasetId"] = ds_id
            datasets.append(ds)
        except Exception:
            pass

    # Kicked participants
    kicked = json.loads(kicked_json) if kicked_json else []

    return jsonify({
        "status": "ok",
        "roomId": room_id,
        "meta": meta,
        "questions": questions,
        "participants": participants,
        "datasets": datasets,
        "kicked": kicked,
    })


@exam_bp.route("/api/exam/room/<room_id>/status", methods=["GET"])
def api_exam_get_room_status(room_id: str):
    """Lightweight status check for room metadata and kicked list."""
    fields = ["status", "startedAt", "endedAt", "kicked"]
    raw = _redis_one(["HMGET", f"room:{room_id}"] + fields)
    if not raw or all(v is None for v in raw):
        return jsonify({"status": "error", "error": "Room not found"}), 404

    status = raw[0]
    started_at = raw[1]
    ended_at = raw[2]
    kicked_json = raw[3]
    kicked = json.loads(kicked_json) if kicked_json else []

    return jsonify({
        "status": "ok",
        "roomStatus": status,
        "startedAt": started_at,
        "endedAt": ended_at,
        "kicked": kicked
    })


@exam_bp.route("/api/exam/room/<room_id>/join", methods=["POST"])
def api_exam_join_room(room_id: str):
    """Student joins a room."""
    meta = _get_room_meta(room_id)
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404

    status = meta.get("status", "")
    if status not in ("waiting", "live"):
        return jsonify({"status": "error", "error": f"Room is {status or 'closed'}"}), 400

    body = request.get_json(force=True, silent=True) or {}
    name = body.get("name", "").strip()
    roll_no = body.get("rollNo", "").strip()
    branch = body.get("branch", "").strip()

    if not name or not roll_no or not branch:
        return jsonify({"status": "error", "error": "Name, Roll No, and Branch are required"}), 400

    participants_json = _redis_one(["HGET", f"room:{room_id}", "participants"])
    participants_raw = json.loads(participants_json) if participants_json else {}
    existing_student_id = None
    
    if participants_raw:
        for sid, p_val in participants_raw.items():
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
                if p.get("rollNo") == roll_no:
                    # Same roll number found. Does name match?
                    if p.get("name", "").lower() == name.lower():
                        existing_student_id = sid
                    else:
                        return jsonify({"status": "error", "error": "Roll number already in use by another name"}), 403
            except Exception:
                pass
                
    if existing_student_id:
        student_id = existing_student_id
        # Check if they are kicked
        kicked_json = _redis_one(["HGET", f"room:{room_id}", "kicked"])
        kicked = json.loads(kicked_json) if kicked_json else []
        if student_id in kicked:
            return jsonify({"status": "error", "error": "kicked", "message": "You have been removed by the mentor"}), 403
    else:
        student_id = str(uuid.uuid4())[:8]

    now = int(time.time())

    student_data = {
        "name": name,
        "rollNo": roll_no,
        "branch": branch,
        "joinedAt": now,
    }

    participants_raw[student_id] = student_data

    # Update leaderboard
    leaderboard_json = _redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
    if student_id not in leaderboard_raw:
        leaderboard_raw[student_id] = 0

    pipeline = [
        ["HSET", f"room:{room_id}",
         "participants", json.dumps(participants_raw),
         "leaderboard", json.dumps(leaderboard_raw)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]
    _redis_cmd(pipeline)

    return jsonify({
        "status": "ok",
        "studentId": student_id,
        "roomId": room_id,
        "roomTitle": meta.get("title", ""),
        "roomStatus": meta.get("status", "waiting"),
    })


@exam_bp.route("/api/exam/room/<room_id>/start", methods=["POST"])
def api_exam_start_room(room_id: str):
    """Mentor starts the exam."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    now = int(time.time())
    _redis_cmd([
        ["HSET", _room_key(room_id), "status", "live", "startedAt", str(now)],
    ])
    return jsonify({"status": "ok", "startedAt": now})


@exam_bp.route("/api/exam/room/<room_id>/end", methods=["POST"])
def api_exam_end_room(room_id: str):
    """Mentor ends the exam."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    now = int(time.time())
    _redis_cmd([
        ["HSET", f"room:{room_id}", "status", "ended", "endedAt", str(now)],
    ])
    return jsonify({"status": "ok", "endedAt": now})


@exam_bp.route("/api/exam/room/<room_id>/questions", methods=["POST"])
def api_exam_save_questions(room_id: str):
    """Save questions array for a room and clean up stale data for deleted questions."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    questions = body.get("questions", [])

    meta = _get_room_meta(room_id)
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # Fetch existing questions to find deleted ones
    old_questions_json = _redis_one(["HGET", f"room:{room_id}", "questions"])
    old_questions = []
    if old_questions_json:
        try:
            old_questions = json.loads(old_questions_json)
        except Exception:
            pass

    # Find deleted question IDs
    old_ids = {q.get("id") for q in old_questions if q.get("id")}
    new_ids = {q.get("id") for q in questions if q.get("id")}
    deleted_ids = old_ids - new_ids

    pipeline = [
        ["HSET", f"room:{room_id}", "questions", json.dumps(questions)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]

    # Auto-freeze query expected answers if missing (e.g. during template imports)
    for q in questions:
        q_id = q.get("id")
        q_type = q.get("type", "query")
        if q_type == "query" and q_id:
            exists = _redis_one(["HEXISTS", f"room:{room_id}", f"q_answer:{q_id}"])
            if not exists or str(exists) in ("0", "None"):
                query = q.get("expectedQuery", "").strip()
                dataset_ids = q.get("datasetIds", [])
                if not dataset_ids and q.get("datasetId"):
                    dataset_ids = [q.get("datasetId")]
                if query and dataset_ids:
                    res = _execute_room_query(room_id, dataset_ids, query, max_results=100000)
                    if res.get("status") == "ok":
                        docs = res.get("results", [])
                        stored_docs = docs[:2000]
                        pipeline.append(["HSET", f"room:{room_id}", f"q_answer:{q_id}", json.dumps(stored_docs)])

    # Delete frozen answers for deleted questions from the room Hash
    if deleted_ids:
        hdel_cmd = ["HDEL", f"room:{room_id}"]
        for q_id in deleted_ids:
            hdel_cmd.append(f"q_answer:{q_id}")
        pipeline.append(hdel_cmd)

    _redis_cmd(pipeline)
    return jsonify({"status": "ok", "count": len(questions)})


@exam_bp.route("/api/exam/room/<room_id>/dataset", methods=["POST"])
def api_exam_upload_dataset(room_id: str):
    """Upload a dataset (JSON array of documents) for a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    name = body.get("name", "dataset").strip()
    docs = body.get("docs", [])

    meta = _get_room_meta(room_id)
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    if not isinstance(docs, list):
        return jsonify({"status": "error", "error": "docs must be a JSON array"}), 400

    dataset_id = str(uuid.uuid4())[:8]
    safe_name = "".join(c for c in name.lower() if c.isalnum() or c == "_")
    collection_name = safe_name

    datasets_json = _redis_one(["HGET", f"room:{room_id}", "datasets"])
    datasets_dict = json.loads(datasets_json) if datasets_json else {}
    datasets_dict[dataset_id] = {
        "name": name,
        "collection": collection_name,
        "docCount": len(docs)
    }

    pipeline = [
        ["HSET", f"room:{room_id}",
         f"dataset_meta:{dataset_id}", json.dumps({"name": name, "collection": collection_name, "docCount": len(docs)}),
         f"dataset_docs:{dataset_id}", json.dumps(docs),
         "datasets", json.dumps(datasets_dict)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]
    _redis_cmd(pipeline)

    return jsonify({
        "status": "ok",
        "datasetId": dataset_id,
        "name": name,
        "collection": collection_name,
        "docCount": len(docs),
    })


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>", methods=["DELETE"])
def api_exam_delete_dataset(room_id: str, dataset_id: str):
    """Delete a dataset from a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    datasets_json = _redis_one(["HGET", f"room:{room_id}", "datasets"])
    datasets_dict = json.loads(datasets_json) if datasets_json else {}
    datasets_dict.pop(dataset_id, None)

    _redis_cmd([
        ["HDEL", f"room:{room_id}", f"dataset_meta:{dataset_id}", f"dataset_docs:{dataset_id}"],
        ["HSET", f"room:{room_id}", "datasets", json.dumps(datasets_dict)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)]
    ])
    return jsonify({"status": "ok"})


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>/schema", methods=["GET"])
def api_exam_dataset_schema(room_id: str, dataset_id: str):
    """Get schema (field names and types) for a room dataset."""
    docs_json = _redis_one(["HGET", f"room:{room_id}", f"dataset_docs:{dataset_id}"])
    if not docs_json:
        return jsonify({"status": "error", "error": "Dataset not found"}), 404

    try:
        docs = json.loads(docs_json)
    except Exception:
        return jsonify({"status": "error", "error": "Parse error"}), 500

    # Infer schema from first 50 docs
    schema = {}
    sample = docs[:50]
    for doc in sample:
        if isinstance(doc, dict):
            for k, v in doc.items():
                if k not in schema:
                    schema[k] = type(v).__name__

    meta_json = _redis_one(["HGET", f"room:{room_id}", f"dataset_meta:{dataset_id}"])
    meta = json.loads(meta_json) if meta_json else {}
    return jsonify({
        "status": "ok",
        "schema": schema,
        "collection": meta.get("collection", ""),
        "docCount": len(docs),
        "sampleDocs": docs[:5],
    })


@exam_bp.route("/api/exam/room/<room_id>/query", methods=["POST"])
def api_exam_run_query(room_id: str):
    """Execute a query against a room dataset. Used by mentor (freeze answer) and student (submit)."""
    body = request.get_json(force=True, silent=True) or {}
    dataset_ids = body.get("datasetIds", [])
    if not dataset_ids and body.get("datasetId"):
        dataset_ids = [body.get("datasetId")]
    query = body.get("query", "").strip()
    limit = int(body.get("limit", 100))

    if not dataset_ids or not query:
        return jsonify({"status": "error", "error": "datasetIds and query are required"}), 400

    result = _execute_room_query(room_id, dataset_ids, query, max_results=limit)
    return jsonify(result)


@exam_bp.route("/api/exam/room/<room_id>/freeze", methods=["POST"])
def api_exam_freeze_answer(room_id: str):
    """Mentor: run query and freeze the answer for a question."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    question_id = body.get("questionId", "")
    dataset_ids = body.get("datasetIds", [])
    if not dataset_ids and body.get("datasetId"):
        dataset_ids = [body.get("datasetId")]
    query = body.get("query", "").strip()

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    if not question_id or not dataset_ids or not query:
        return jsonify({"status": "error", "error": "questionId, datasetIds, and query are required"}), 400

    result = _execute_room_query(room_id, dataset_ids, query, max_results=100000)
    if result.get("status") == "error":
        return jsonify(result), 400

    docs = result.get("results", [])
    stored_docs = docs[:2000]

    # Freeze the answer safely
    _redis_cmd([
        ["HSET", f"room:{room_id}", f"q_answer:{question_id}", json.dumps(stored_docs)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ])

    return jsonify({
        "status": "ok",
        "questionId": question_id,
        "docCount": len(docs),
        "preview": docs[:3],
    })


@exam_bp.route("/api/exam/room/<room_id>/submit", methods=["POST"])
def api_exam_submit_answer(room_id: str):
    """Student submits an answer. Server grades it and updates leaderboard."""
    body = request.get_json(force=True, silent=True) or {}
    student_id = body.get("studentId", "")
    question_id = body.get("questionId", "")
    q_type = body.get("type", "query")  # 'query' or 'mcq'
    marks = int(body.get("marks", 0))

    if not student_id or not question_id:
        return jsonify({"status": "error", "error": "studentId and questionId are required"}), 400

    # Batch retrieve all validation data from Redis Hash in 1 single roundtrip
    fields = [
        "status", "kicked", "questions",
        f"q_answer:{question_id}", f"submissions:{student_id}", "leaderboard"
    ]
    raw = _redis_one(["HMGET", f"room:{room_id}"] + fields)
    if not raw or all(v is None for v in raw):
        return jsonify({"status": "error", "error": "Room not found"}), 404

    status = raw[0]
    kicked_json = raw[1]
    questions_json = raw[2]
    frozen_json = raw[3]
    subs_json = raw[4]
    leaderboard_json = raw[5]

    # Validate room is live
    if status != "live":
        return jsonify({"status": "error", "error": "Exam is not live"}), 400

    # Validate student is not kicked
    kicked = json.loads(kicked_json) if kicked_json else []
    if student_id in kicked:
        return jsonify({"status": "error", "error": "kicked", "message": "You have been removed by the mentor"}), 403

    score = 0
    now = int(time.time())

    if q_type == "mcq":
        selected_option = body.get("selectedOption", "")
        correct_option = body.get("correctOption", "")  # sent from client, verified server-side
        # Fetch correct option from questions stored in Redis (server-side verification)
        if questions_json:
            try:
                questions = json.loads(questions_json)
                for q in questions:
                    if q.get("id") == question_id:
                        correct_option = q.get("correctOption", "")
                        break
            except Exception:
                pass
        score = marks if selected_option == correct_option else 0
        submission = json.dumps({
            "type": "mcq",
            "selectedOption": selected_option,
            "score": score,
            "submittedAt": now,
        })

    elif q_type == "coding":
        code = body.get("code", "")
        language = body.get("language", "python")

        test_cases = []
        if questions_json:
            try:
                questions = json.loads(questions_json)
                for q in questions:
                    if q.get("id") == question_id:
                        test_cases = q.get("testCases", [])
                        break
            except Exception:
                pass

        all_passed = True
        for tc in test_cases:
            tc_input = tc.get("input", "")
            tc_expected = tc.get("expectedOutput", "")

            run_res = run_piston_code(language, code, tc_input)
            actual_out = run_res.get("stdout", "")
            if run_res.get("stderr"):
                actual_out += "\n" + run_res.get("stderr")

            actual_lines = [line.strip() for line in actual_out.strip().splitlines() if line.strip()]
            expected_lines = [line.strip() for line in tc_expected.strip().splitlines() if line.strip()]

            try:
                res_code = int(run_res.get("code", 0))
            except (ValueError, TypeError):
                res_code = 0

            matched = (actual_lines == expected_lines) and (res_code == 0)
            if not matched:
                all_passed = False

        score = marks if all_passed else 0
        submission = json.dumps({
            "type": "coding",
            "code": code,
            "language": language,
            "score": score,
            "allPassed": all_passed,
            "submittedAt": now,
        })

    else:  # query question
        query = body.get("query", "").strip()
        dataset_ids = body.get("datasetIds", [])
        if not dataset_ids and body.get("datasetId"):
            dataset_ids = [body.get("datasetId")]
        student_output = body.get("studentOutput", [])

        # Run student query server-side for grading
        if query and dataset_ids:
            result = _execute_room_query(room_id, dataset_ids, query, max_results=100000)
            if result.get("status") == "ok":
                student_output = result.get("results", [])

        # Fetch frozen answer
        frozen_answer = []
        if frozen_json:
            try:
                frozen_answer = json.loads(frozen_json)
            except Exception:
                pass

        grade = grade_query_answer(student_output, frozen_answer)
        score = marks if grade["match"] else 0

        submission = json.dumps({
            "type": "query",
            "query": query,
            "score": score,
            "submittedAt": now,
        })

    # Fetch previous submission score for this question
    submissions = json.loads(subs_json) if subs_json else {}
    prev_submission_json = submissions.get(question_id)
    prev_score = 0
    if prev_submission_json:
        try:
            prev_score = json.loads(prev_submission_json).get("score", 0) if isinstance(prev_submission_json, str) else prev_submission_json.get("score", 0)
        except Exception:
            pass

    score_delta = score - prev_score

    # Update leaderboard
    leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
    leaderboard_raw[student_id] = leaderboard_raw.get(student_id, 0) + score_delta

    # Store submission and update leaderboard in Hash
    submissions[question_id] = submission
    pipeline = [
        ["HSET", f"room:{room_id}",
         f"submissions:{student_id}", json.dumps(submissions),
         "leaderboard", json.dumps(leaderboard_raw)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]

    _redis_cmd(pipeline)

    return jsonify({
        "status": "ok",
        "score": score,
        "maxMarks": marks,
        "correct": score > 0,
    })


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/expected-preview", methods=["GET"])
def api_exam_expected_preview(room_id: str, question_id: str):
    """Retrieve first 5 documents of the frozen answer for a question as a preview."""
    frozen_json = _redis_one(["HGET", f"room:{room_id}", f"q_answer:{question_id}"])
    if not frozen_json:
        return jsonify({"status": "error", "error": "No frozen answer found"}), 404
    try:
        docs = json.loads(frozen_json)
    except Exception:
        return jsonify({"status": "error", "error": "Failed to parse frozen answer"}), 500

    return jsonify({
        "status": "ok",
        "docCount": len(docs),
        "preview": docs[:5],
    })


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/finish", methods=["POST"])
def api_exam_student_finish(room_id: str, student_id: str):
    """Submit the final exam for a student."""
    participants_json = _redis_one(["HGET", f"room:{room_id}", "participants"])
    participants_raw = json.loads(participants_json) if participants_json else {}
    p_val = participants_raw.get(student_id)
    if not p_val:
        return jsonify({"status": "error", "error": "Student not found"}), 404
    try:
        p = json.loads(p_val) if isinstance(p_val, str) else p_val
    except Exception:
        p = {}

    p["finished"] = True
    p["finishedAt"] = int(time.time())
    participants_raw[student_id] = p

    _redis_cmd([
        ["HSET", f"room:{room_id}", "participants", json.dumps(participants_raw)],
    ])
    return jsonify({"status": "ok"})


@exam_bp.route("/api/exam/room/<room_id>/leaderboard", methods=["GET"])
def api_exam_leaderboard(room_id: str):
    """Fetch leaderboard from room Hash key."""
    leaderboard_json = _redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}

    participants_json = _redis_one(["HGET", f"room:{room_id}", "participants"])
    participants_raw = json.loads(participants_json) if participants_json else {}

    ranked = []
    for sid, score in leaderboard_raw.items():
        total_score = float(score)
        p_val = participants_raw.get(sid)
        student_info = {"name": "Unknown", "rollNo": "-", "branch": "-", "joinedAt": 0}
        if p_val:
            try:
                student_info = json.loads(p_val) if isinstance(p_val, str) else p_val
            except Exception:
                pass

        # Fetch submissions for answered/accuracy counts
        subs_json = _redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
        subs_raw = json.loads(subs_json) if subs_json else {}
        answered = len(subs_raw)
        correct = sum(
            1 for v in subs_raw.values()
            if (json.loads(v) if isinstance(v, str) else v).get("score", 0) > 0
        ) if subs_raw else 0

        last_sub_time = 0
        if subs_raw:
            for v in subs_raw.values():
                try:
                    t = (json.loads(v) if isinstance(v, str) else v).get("submittedAt", 0)
                    if t > last_sub_time:
                        last_sub_time = t
                except Exception:
                    pass

        ranked.append({
            "studentId": sid,
            "name": student_info.get("name", "Unknown"),
            "rollNo": student_info.get("rollNo", "-"),
            "branch": student_info.get("branch", "-"),
            "totalScore": int(total_score),
            "answered": answered,
            "correct": correct,
            "lastSubmission": last_sub_time,
        })

    # Include any participants not yet in sorted set
    for sid, p_val in participants_raw.items():
        if not any(r["studentId"] == sid for r in ranked):
            student_info = {"name": "Unknown", "rollNo": "-", "branch": "-", "joinedAt": 0}
            if p_val:
                try:
                    student_info = json.loads(p_val) if isinstance(p_val, str) else p_val
                except Exception:
                    pass
            subs_json = _redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
            subs_raw = json.loads(subs_json) if subs_json else {}
            answered = len(subs_raw)
            correct = sum(
                1 for v in subs_raw.values()
                if (json.loads(v) if isinstance(v, str) else v).get("score", 0) > 0
            ) if subs_raw else 0
            last_sub_time = 0
            if subs_raw:
                for v in subs_raw.values():
                    try:
                        t = (json.loads(v) if isinstance(v, str) else v).get("submittedAt", 0)
                        if t > last_sub_time:
                            last_sub_time = t
                    except Exception:
                        pass
            ranked.append({
                "studentId": sid,
                "name": student_info.get("name", "Unknown"),
                "rollNo": student_info.get("rollNo", "-"),
                "branch": student_info.get("branch", "-"),
                "totalScore": 0,
                "answered": answered,
                "correct": correct,
                "lastSubmission": last_sub_time,
            })

    # Sort in memory: totalScore desc, studentId asc
    ranked.sort(key=lambda r: (-r["totalScore"], r["studentId"]))

    # Fetch total possible score from questions
    questions_json = _redis_one(["HGET", f"room:{room_id}", "questions"])
    max_score = 0
    total_questions = 0
    if questions_json:
        try:
            questions = json.loads(questions_json)
            total_questions = len(questions)
            max_score = sum(int(q.get("marks", 0)) for q in questions)
        except Exception:
            pass

    return jsonify({
        "status": "ok",
        "leaderboard": ranked,
        "maxScore": max_score,
        "totalQuestions": total_questions,
    })


@exam_bp.route("/api/exam/room/<room_id>/cleanup", methods=["DELETE", "POST"])
def api_exam_cleanup_room(room_id: str):
    """Delete the single room Hash key from Redis."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # Delete the single room Hash key
    _redis_one(["DEL", f"room:{room_id}"])

    return jsonify({"status": "ok", "deletedKeys": 1})


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>", methods=["DELETE"])
def api_exam_remove_student(room_id: str, student_id: str):
    """Mentor removes/kicks a student from the exam room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    leaderboard_json = _redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
    leaderboard_raw.pop(student_id, None)

    kicked_json = _redis_one(["HGET", f"room:{room_id}", "kicked"])
    kicked_raw = json.loads(kicked_json) if kicked_json else []
    if student_id not in kicked_raw:
        kicked_raw.append(student_id)

    pipeline = [
        ["HSET", f"room:{room_id}",
         "leaderboard", json.dumps(leaderboard_raw),
         "kicked", json.dumps(kicked_raw)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]
    _redis_cmd(pipeline)

    return jsonify({"status": "ok", "studentId": student_id})


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/reallow", methods=["POST"])
def api_exam_reallow_student(room_id: str, student_id: str):
    """Mentor re-allows a kicked student."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # Calculate their total score from submissions
    subs_json = _redis_one(["HGET", f"room:{room_id}", f"submissions:{student_id}"])
    submissions = json.loads(subs_json) if subs_json else {}
    total_score = 0
    if submissions:
        for sub_val in submissions.values():
            try:
                sub = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
                total_score += sub.get("score", 0)
            except Exception:
                pass

    leaderboard_json = _redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
    leaderboard_raw[student_id] = total_score

    kicked_json = _redis_one(["HGET", f"room:{room_id}", "kicked"])
    kicked_raw = json.loads(kicked_json) if kicked_json else []
    if student_id in kicked_raw:
        kicked_raw.remove(student_id)

    pipeline = [
        ["HSET", f"room:{room_id}",
         "leaderboard", json.dumps(leaderboard_raw),
         "kicked", json.dumps(kicked_raw)],
        ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
    ]
    _redis_cmd(pipeline)
    return jsonify({"status": "ok"})


@exam_bp.route("/api/exam/room/<room_id>/kicked", methods=["GET"])
def api_exam_kicked_list(room_id: str):
    """Mentor fetches the list of kicked students."""
    mentor_id = request.args.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    kicked_json = _redis_one(["HGET", f"room:{room_id}", "kicked"])
    kicked_raw = json.loads(kicked_json) if kicked_json else []
    kicked_students = []

    participants_json = _redis_one(["HGET", f"room:{room_id}", "participants"])
    participants_raw = json.loads(participants_json) if participants_json else {}

    for sid in kicked_raw:
        p_val = participants_raw.get(sid)
        if p_val:
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
                p["studentId"] = sid
                kicked_students.append(p)
            except Exception:
                pass
        else:
            kicked_students.append({"studentId": sid, "name": "Unknown", "rollNo": "Unknown"})

    return jsonify({"status": "ok", "kicked": kicked_students})


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/submissions", methods=["GET"])
def api_exam_student_submissions(room_id: str, student_id: str):
    """Mentor fetches all submissions for a specific student or student restores their own state."""
    mentor_id = request.args.get("mentorId", "")
    is_student_themselves = request.args.get("isStudent", "") == "1"

    meta = _get_room_meta(room_id)
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404

    if not is_student_themselves and meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    subs_json = _redis_one(["HGET", f"room:{room_id}", f"submissions:{student_id}"])
    submissions_raw = json.loads(subs_json) if subs_json else {}
    submissions = {}
    if submissions_raw:
        for q_id, sub_val in submissions_raw.items():
            try:
                submissions[q_id] = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
            except Exception:
                pass

    return jsonify({"status": "ok", "submissions": submissions})


@exam_bp.route("/api/exam/room/<room_id>/archive", methods=["GET"])
def api_exam_room_archive(room_id: str):
    """Fetch all room data (meta, questions, participants, leaderboard, and submissions) as a single JSON file for offline playback."""
    mentor_id = request.args.get("mentorId", "")

    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # Questions
    questions_json = _redis_one(["HGET", f"room:{room_id}", "questions"])
    questions = json.loads(questions_json) if questions_json else []

    # Participants
    participants_json = _redis_one(["HGET", f"room:{room_id}", "participants"])
    participants_raw = json.loads(participants_json) if participants_json else {}

    # Datasets
    datasets_json = _redis_one(["HGET", f"room:{room_id}", "datasets"])
    datasets_raw = json.loads(datasets_json) if datasets_json else {}

    # Kicked
    kicked_json = _redis_one(["HGET", f"room:{room_id}", "kicked"])
    kicked = json.loads(kicked_json) if kicked_json else []

    # Leaderboard
    leaderboard_json = _redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    leaderboard = json.loads(leaderboard_json) if leaderboard_json else {}

    # Submissions (Fetch for all participants)
    submissions = {}
    for sid in participants_raw.keys():
        subs_json = _redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
        if subs_json:
            try:
                raw_subs = json.loads(subs_json)
                parsed_subs = {}
                for qid, sub_val in raw_subs.items():
                    try:
                        parsed_subs[qid] = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
                    except Exception:
                        parsed_subs[qid] = sub_val
                submissions[sid] = parsed_subs
            except Exception:
                pass

    return jsonify({
        "status": "ok",
        "roomId": room_id,
        "meta": meta,
        "questions": questions,
        "datasets": datasets_raw,
        "participants": participants_raw,
        "kicked": kicked,
        "leaderboard": leaderboard,
        "submissions": submissions,
    })


@exam_bp.route("/api/exam/room/<room_id>/paper", methods=["GET"])
def api_exam_get_paper(room_id: str):
    """Retrieve the full question paper (metadata, questions, and datasets docs) for export."""
    mentor_id = request.args.get("mentorId", "")
    meta = _get_room_meta(room_id)
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # Questions
    questions_json = _redis_one(["HGET", f"room:{room_id}", "questions"])
    questions = json.loads(questions_json) if questions_json else []

    # Datasets
    datasets_json = _redis_one(["HGET", f"room:{room_id}", "datasets"])
    datasets_dict = json.loads(datasets_json) if datasets_json else {}

    datasets_list = []
    for d_id, d_meta in datasets_dict.items():
        docs_json = _redis_one(["HGET", f"room:{room_id}", f"dataset_docs:{d_id}"])
        docs = json.loads(docs_json) if docs_json else []
        datasets_list.append({
            "datasetId": d_id,
            "name": d_meta.get("name", ""),
            "collection": d_meta.get("collection", ""),
            "docs": docs
        })

    return jsonify({
        "status": "ok",
        "title": meta.get("title", "Quiz"),
        "timed": meta.get("timed", "0"),
        "duration": meta.get("duration", "60"),
        "questions": questions,
        "datasets": datasets_list
    })


def run_piston_code(language: str, code: str, stdin: str = ""):
    import requests
    import time

    lang_map = {
        "python": "python3",
        "cpp": "cpp",
        "c": "c",
        "java": "java"
    }
    paiza_lang = lang_map.get(language, "python3")

    payload = {
        "source_code": code,
        "language": paiza_lang,
        "input": stdin,
        "api_key": "guest"
    }

    try:
        r_create = requests.post("https://api.paiza.io/runners/create", json=payload, timeout=8)
        if r_create.status_code != 200:
            return {"error": "Failed to create runtime session", "stdout": "", "stderr": f"HTTP status: {r_create.status_code}", "code": 1, "output": ""}
            
        create_res = r_create.json()
        run_id = create_res.get("id")
        if not run_id:
            return {"error": "Failed to obtain runner ID", "stdout": "", "stderr": str(create_res), "code": 1, "output": ""}
            
        for _ in range(10):
            time.sleep(1)
            r_details = requests.get(f"https://api.paiza.io/runners/get_details?id={run_id}&api_key=guest", timeout=8)
            if r_details.status_code == 200:
                res = r_details.json()
                status = res.get("status")
                if status == "completed":
                    return {
                        "stdout": res.get("stdout", ""),
                        "stderr": res.get("stderr", ""),
                        "code": res.get("exit_code", 0),
                        "output": res.get("stdout", "") or res.get("stderr", "")
                    }
                elif status == "running":
                    continue
                else:
                    return {
                        "stdout": "",
                        "stderr": f"Execution status: {status}",
                        "code": 1,
                        "output": ""
                    }
        
        return {"error": "Execution timeout", "stdout": "", "stderr": "Program compilation or execution timed out.", "code": 1, "output": ""}
        
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": f"Execution failed: {e}", "code": 1, "output": ""}


@exam_bp.route("/api/exam/room/<room_id>/run", methods=["POST"])
def api_exam_run_code(room_id: str):
    """Run code using Paiza API sandbox for custom student inputs."""
    try:
        body = request.get_json(force=True, silent=True) or {}
        language = body.get("language", "python")
        code = body.get("code", "")
        stdin = body.get("stdin", "")

        res = run_piston_code(language, code, stdin)
        
        try:
            code_val = int(res.get("code", 0))
        except (ValueError, TypeError):
            code_val = 0

        return jsonify({
            "status": "ok",
            "stdout": res.get("stdout", ""),
            "stderr": res.get("stderr", ""),
            "code": code_val,
            "output": res.get("output", "")
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "stdout": "",
            "stderr": f"Server error: {e}",
            "code": 1,
            "output": ""
        }), 500
