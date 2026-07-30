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
    return f"room:{room_id}:meta"


# ── Room ID generation ────────────────────────────────────────────────────────

def _gen_room_id() -> str:
    """Generate a unique 6-char alphanumeric Room ID (e.g. MNG-4X9)."""
    chars = string.ascii_uppercase + string.digits
    for _ in range(20):  # max 20 attempts
        part1 = "MNG"
        part2 = "".join(random.choices(chars, k=3))
        room_id = f"{part1}-{part2}"
        # Collision check
        exists = _redis_one(["EXISTS", _room_key(room_id)])
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

        loaded_count = 0
        for d_id in dataset_ids:
            if not d_id:
                continue
            docs_json = _redis_one(["GET", f"room:{room_id}:dataset:{d_id}:docs"])
            if not docs_json:
                continue
            try:
                docs = json.loads(docs_json)
            except Exception:
                continue

            meta = _hgetall(f"room:{room_id}:dataset:{d_id}:meta")
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
    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404

    # Questions
    questions_json = _redis_one(["GET", f"room:{room_id}:questions"])
    questions = []
    if questions_json:
        try:
            questions = json.loads(questions_json)
        except Exception:
            pass

    # Participants
    participants_raw = _hgetall(f"room:{room_id}:participants")
    participants = []
    for sid, p_json in participants_raw.items():
        try:
            p = json.loads(p_json)
            p["studentId"] = sid
            participants.append(p)
        except Exception:
            pass

    # Datasets
    datasets_raw = _hgetall(f"room:{room_id}:datasets")
    datasets = []
    for ds_id, ds_json in datasets_raw.items():
        try:
            ds = json.loads(ds_json)
            ds["datasetId"] = ds_id
            datasets.append(ds)
        except Exception:
            pass

    # Kicked participants
    kicked_raw = _redis_one(["SMEMBERS", f"room:{room_id}:kicked"])
    kicked = []
    if isinstance(kicked_raw, list):
        kicked = [str(k) for k in kicked_raw]

    return jsonify({
        "status": "ok",
        "roomId": room_id,
        "meta": meta,
        "questions": questions,
        "participants": participants,
        "datasets": datasets,
        "kicked": kicked,
    })


@exam_bp.route("/api/exam/room/<room_id>/join", methods=["POST"])
def api_exam_join_room(room_id: str):
    """Student joins a room."""
    meta = _hgetall(_room_key(room_id))
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

    student_id = str(uuid.uuid4())[:8]
    now = int(time.time())

    student_data = json.dumps({
        "name": name,
        "rollNo": roll_no,
        "branch": branch,
        "joinedAt": now,
    })

    pipeline = [
        ["HSET", f"room:{room_id}:participants", student_id, student_data],
        ["EXPIRE", f"room:{room_id}:participants", str(60 * 60 * 24 * 7)],
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
        ["HSET", _room_key(room_id), "status", "ended", "endedAt", str(now)],
    ])
    return jsonify({"status": "ok", "endedAt": now})


@exam_bp.route("/api/exam/room/<room_id>/questions", methods=["POST"])
def api_exam_save_questions(room_id: str):
    """Save questions array for a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    questions = body.get("questions", [])

    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    _redis_cmd([
        ["SET", f"room:{room_id}:questions", json.dumps(questions)],
        ["EXPIRE", f"room:{room_id}:questions", str(60 * 60 * 24 * 7)],
    ])
    return jsonify({"status": "ok", "count": len(questions)})


@exam_bp.route("/api/exam/room/<room_id>/dataset", methods=["POST"])
def api_exam_upload_dataset(room_id: str):
    """Upload a dataset (JSON array of documents) for a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    name = body.get("name", "dataset").strip()
    docs = body.get("docs", [])

    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    if not isinstance(docs, list):
        return jsonify({"status": "error", "error": "docs must be a JSON array"}), 400

    dataset_id = str(uuid.uuid4())[:8]
    safe_name = "".join(c for c in name.lower() if c.isalnum() or c == "_")
    collection_name = safe_name

    pipeline = [
        ["HSET", f"room:{room_id}:dataset:{dataset_id}:meta",
         "name", name,
         "collection", collection_name,
         "docCount", str(len(docs))],
        ["EXPIRE", f"room:{room_id}:dataset:{dataset_id}:meta", str(60 * 60 * 24 * 7)],
        ["SET", f"room:{room_id}:dataset:{dataset_id}:docs", json.dumps(docs)],
        ["EXPIRE", f"room:{room_id}:dataset:{dataset_id}:docs", str(60 * 60 * 24 * 7)],
        # Track dataset in room's dataset index
        ["HSET", f"room:{room_id}:datasets", dataset_id,
         json.dumps({"name": name, "collection": collection_name, "docCount": len(docs)})],
        ["EXPIRE", f"room:{room_id}:datasets", str(60 * 60 * 24 * 7)],
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

    meta = _hgetall(_room_key(room_id))
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    _redis_cmd([
        ["DEL", f"room:{room_id}:dataset:{dataset_id}:meta"],
        ["DEL", f"room:{room_id}:dataset:{dataset_id}:docs"],
        ["HDEL", f"room:{room_id}:datasets", dataset_id],
    ])
    return jsonify({"status": "ok"})


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>/schema", methods=["GET"])
def api_exam_dataset_schema(room_id: str, dataset_id: str):
    """Get schema (field names and types) for a room dataset."""
    docs_json = _redis_one(["GET", f"room:{room_id}:dataset:{dataset_id}:docs"])
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

    meta = _hgetall(f"room:{room_id}:dataset:{dataset_id}:meta")
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

    meta = _hgetall(_room_key(room_id))
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
        ["SET", f"room:{room_id}:question:{question_id}:answer", json.dumps(stored_docs)],
        ["EXPIRE", f"room:{room_id}:question:{question_id}:answer", str(60 * 60 * 24 * 7)],
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

    # Validate room is live
    meta = _hgetall(_room_key(room_id))
    if not meta:
        return jsonify({"status": "error", "error": "Room not found"}), 404
    if meta.get("status") != "live":
        return jsonify({"status": "error", "error": "Exam is not live"}), 400

    # Validate student is not kicked
    is_kicked = _redis_one(["SISMEMBER", f"room:{room_id}:kicked", student_id])
    if is_kicked:
        return jsonify({"status": "error", "error": "kicked", "message": "You have been removed by the mentor"}), 403

    score = 0
    now = int(time.time())

    if q_type == "mcq":
        selected_option = body.get("selectedOption", "")
        correct_option = body.get("correctOption", "")  # sent from client, verified server-side
        # Fetch correct option from questions stored in Redis (server-side verification)
        questions_json = _redis_one(["GET", f"room:{room_id}:questions"])
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
        frozen_json = _redis_one(["GET", f"room:{room_id}:question:{question_id}:answer"])
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
    prev_submission_json = _redis_one(["HGET", f"room:{room_id}:student:{student_id}:submissions", question_id])
    prev_score = 0
    if prev_submission_json:
        try:
            prev_score = json.loads(prev_submission_json).get("score", 0)
        except Exception:
            pass

    score_delta = score - prev_score

    # Store submission
    pipeline = [
        ["HSET", f"room:{room_id}:student:{student_id}:submissions", question_id, submission],
        ["EXPIRE", f"room:{room_id}:student:{student_id}:submissions", str(60 * 60 * 24 * 7)],
    ]

    # Update leaderboard sorted set only if score changed
    if score_delta != 0:
        pipeline.append(["ZINCRBY", f"room:{room_id}:leaderboard", str(score_delta), student_id])

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
    frozen_json = _redis_one(["GET", f"room:{room_id}:question:{question_id}:answer"])
    if not frozen_json:
        return jsonify({"status": "error", "error": "No frozen answer found"}), 404
    try:
        docs = json.loads(frozen_json)
    except Exception:
        return jsonify({"status": "error", "error": "Failed to parse frozen answer"}), 500

    return jsonify({
        "status": "ok",
        "docCount": len(docs),
        "preview": docs[:2],
    })


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/finish", methods=["POST"])
def api_exam_student_finish(room_id: str, student_id: str):
    """Submit the final exam for a student."""
    p_json = _redis_one(["HGET", f"room:{room_id}:participants", student_id])
    if not p_json:
        return jsonify({"status": "error", "error": "Student not found"}), 404
    try:
        p = json.loads(p_json)
    except Exception:
        p = {}

    p["finished"] = True
    p["finishedAt"] = int(time.time())

    _redis_cmd([
        ["HSET", f"room:{room_id}:participants", student_id, json.dumps(p)],
    ])
    return jsonify({"status": "ok"})


@exam_bp.route("/api/exam/room/<room_id>/leaderboard", methods=["GET"])
def api_exam_leaderboard(room_id: str):
    """Fetch leaderboard from Redis sorted set."""
    # ZREVRANGE with scores
    raw = _redis_one(["ZREVRANGE", f"room:{room_id}:leaderboard", "0", "-1", "WITHSCORES"])
    if not isinstance(raw, list):
        raw = []

    # raw is [studentId, score, studentId, score, ...]
    ranked = []
    for i in range(0, len(raw) - 1, 2):
        sid = raw[i]
        total_score = float(raw[i + 1]) if i + 1 < len(raw) else 0

        # Fetch student info
        p_json = _redis_one(["HGET", f"room:{room_id}:participants", sid])
        student_info = {"name": "Unknown", "rollNo": "-", "branch": "-", "joinedAt": 0}
        if p_json:
            try:
                student_info = json.loads(p_json)
            except Exception:
                pass

        # Fetch submissions for answered/accuracy counts
        subs_raw = _hgetall(f"room:{room_id}:student:{sid}:submissions")
        answered = len(subs_raw)
        correct = sum(
            1 for v in subs_raw.values()
            if isinstance(v, str) and json.loads(v).get("score", 0) > 0
        ) if subs_raw else 0

        last_sub_time = 0
        if subs_raw:
            for v in subs_raw.values():
                try:
                    t = json.loads(v).get("submittedAt", 0)
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

    # Fetch total possible score from questions
    questions_json = _redis_one(["GET", f"room:{room_id}:questions"])
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


@exam_bp.route("/api/exam/room/<room_id>/cleanup", methods=["DELETE"])
def api_exam_cleanup_room(room_id: str):
    """Delete all room:{roomId}:* keys from Redis after export."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _hgetall(_room_key(room_id))
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    # SCAN for all room:{roomId}:* keys and delete them
    # Upstash REST: SCAN 0 MATCH room:{roomId}:* COUNT 100
    prefix = f"room:{room_id}:"
    cursor = "0"
    all_keys = []
    for _ in range(20):  # max 20 scan iterations
        res = _redis_one(["SCAN", cursor, "MATCH", f"{prefix}*", "COUNT", "100"])
        if not isinstance(res, list) or len(res) < 2:
            break
        cursor = str(res[0])
        batch = res[1] if isinstance(res[1], list) else []
        all_keys.extend(batch)
        if cursor == "0":
            break

    if all_keys:
        _redis_cmd([["DEL"] + all_keys])

    return jsonify({"status": "ok", "deletedKeys": len(all_keys)})


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>", methods=["DELETE"])
def api_exam_remove_student(room_id: str, student_id: str):
    """Mentor removes/kicks a student from the exam room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")

    meta = _hgetall(_room_key(room_id))
    if not meta or meta.get("mentorId") != mentor_id:
        return jsonify({"status": "error", "error": "Unauthorized"}), 403

    pipeline = [
        ["HDEL", f"room:{room_id}:participants", student_id],
        ["ZREM", f"room:{room_id}:leaderboard", student_id],
        ["SADD", f"room:{room_id}:kicked", student_id],
        ["EXPIRE", f"room:{room_id}:kicked", str(60 * 60 * 24 * 7)],
        ["DEL", f"room:{room_id}:student:{student_id}:submissions"],
    ]
    _redis_cmd(pipeline)

    return jsonify({"status": "ok", "studentId": student_id})

