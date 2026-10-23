"""
api/routes/exam_routes.py
Exam Portal API — Room management, questions, submissions, leaderboard.
Decomposed controller layer delegating to domain services.
"""

import sys
import json
from pathlib import Path
from flask import Blueprint, request, jsonify, g, Response, stream_with_context

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.exam.room_service import RoomService
from services.submission.submission_service import SubmissionService
from services.proctoring.proctoring_service import ProctoringService
from services.leaderboard.leaderboard_service import LeaderboardService
from services.compiler.compiler_service import CompilerService
from services.sql.sql_service import SqlService
from services.exam.media_service import QuestionMediaService
from services.shared.redis_client import redis_one, get_room_participants
from services.execution.job_queue import execute as execute_job
from services.shared.idempotency import get_idempotency_key_from_request, get_persistent_idempotency_handler, serialize_idempotency_body
from services.shared.pagination import encode_cursor, decode_cursor
from services.shared.cache import get_cache_manager
from utils.logger import get_logger, bind_component

exam_bp = Blueprint("exam_bp", __name__)
log = bind_component(get_logger(__name__), "exam_api")

# Expose the worker execution helper for backwards compatibility.
run_piston_code = CompilerService.run_piston_code
_exam_idem = get_persistent_idempotency_handler(ttl_seconds=900)


def _exam_replay():
    key = get_idempotency_key_from_request(request)
    replay = _exam_idem.check_replay(key, method=request.method, path=request.path)
    return (jsonify(replay[1]), replay[0]) if replay else None


def _exam_record(payload, status=200):
    _exam_idem.record_response(
        get_idempotency_key_from_request(request), method=request.method,
        path=request.path, status_code=status, body=serialize_idempotency_body(payload),
    )


def _json_response(payload, status=200):
    return jsonify(payload), status


def _account_id(fallback=""):
    """Use the server session identity; fallback is only for local legacy mode."""
    return str((g.get("user") or {}).get("id") or fallback or "")


def _assert_student_account(room_id, student_id):
    """Prevent an authenticated student from submitting as another student."""
    account_id = str((g.get("user") or {}).get("id") or "")
    if not account_id:
        return
    raw = get_room_participants(room_id).get(student_id)
    participant = json.loads(raw) if isinstance(raw, str) else (raw or {})
    if str(participant.get("accountId") or "") != account_id:
        raise PermissionError("This student record belongs to another account")


@exam_bp.route("/api/exam/room/create", methods=["POST"])
def api_exam_create_room():
    """Create a new exam room."""
    log.info("room_create_requested", correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "Untitled Assessment").strip()
    # The authenticated account is the authority; never trust a mentor ID
    # supplied by the browser.
    mentor_id = _account_id(body.get("mentorId", ""))
    timed = bool(body.get("timed", False))
    duration = int(body.get("duration", 60))
    fullscreen_mode = bool(body.get("fullscreenMode", False))
    block_copypaste = bool(body.get("blockCopyPaste", False))
    max_exits = int(body.get("maxFullscreenExits", 5))
    max_copy_paste_attempts = int(body.get("maxCopyPasteAttempts", 3))

    if not title:
        return _json_response({"status": "error", "error": "Title is required"}, status=400)

    try:
        res = RoomService.create_room(title, mentor_id, timed, duration, fullscreen_mode, block_copypaste, max_exits, max_copy_paste_attempts)
        return _json_response({
            "status": "ok",
            "roomId": res["roomId"],
            "mentorId": res["mentorId"],
            "title": res["title"]
        })
    except Exception as e:
        log.error("room_create_failed", error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=503)


@exam_bp.route("/api/exam/room/<room_id>", methods=["GET"])
def api_exam_get_room(room_id: str):
    """Fetch room metadata + questions + participants."""
    mentor_id = _account_id(request.args.get("mentorId", ""))
    log.debug("room_get_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        res = RoomService.get_room(room_id, mentor_id)
        return _json_response({
            "status": "ok",
            "roomId": res["roomId"],
            "meta": res["meta"],
            "questions": res["questions"],
            "participants": res["participants"],
            "datasets": res["datasets"],
            "kicked": res["kicked"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("room_get_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/status", methods=["GET"])
def api_exam_get_room_status(room_id: str):
    """Lightweight status check for room metadata and kicked list."""
    log.debug("room_status_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        res = RoomService.get_room_status(room_id)
        return _json_response({
            "status": "ok",
            "roomStatus": res["roomStatus"],
            "startedAt": res["startedAt"],
            "endedAt": res["endedAt"],
            "kicked": res["kicked"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("room_status_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/join", methods=["POST"])
def api_exam_join_room(room_id: str):
    """Student joins a room with strict credential validation."""
    log.info("room_join_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    name = body.get("name", "").strip()
    roll_no = body.get("rollNo", "").strip()
    branch = body.get("branch", "").strip()
    section = body.get("section", "A").strip()

    if not name or not roll_no or not branch:
        return _json_response({"status": "error", "error": "Name, Roll No, and Branch are required"}, status=400)

    try:
        res = RoomService.join_room(
            room_id, name, roll_no, branch, section,
            account_id=str((g.get("user") or {}).get("id") or ""),
        )
        return _json_response({
            "status": "ok",
            "studentId": res["studentId"],
            "roomId": res["roomId"],
            "roomTitle": res["roomTitle"],
            "roomStatus": res["roomStatus"],
            "isLocked": res.get("isLocked", False)
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except PermissionError as e:
        err_msg = str(e)
        if err_msg.startswith("kicked:"):
            return _json_response({"status": "error", "error": "kicked", "message": err_msg[7:]}, status=403)
        return _json_response({"status": "error", "error": err_msg}, status=403)
    except FileExistsError as e:
        return _json_response({
            "status": "error",
            "error": "already_submitted",
            "message": "Thanks for writing the test. Your test is already submitted."
        }, status=403)
    except Exception as e:
        log.error("room_join_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/lock", methods=["POST"])
def api_exam_toggle_lock(room_id: str):
    """Mentor locks or unlocks the room."""
    log.info("room_lock_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    lock_state = bool(body.get("isLocked", True))
    try:
        res = RoomService.toggle_room_lock(room_id, mentor_id, lock_state)
        return _json_response({"status": "ok", "isLocked": res})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_lock_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/start", methods=["POST"])
def api_exam_start_room(room_id: str):
    """Mentor starts the exam."""
    log.info("room_start_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        started_at = RoomService.start_room(room_id, mentor_id)
        return _json_response({"status": "ok", "startedAt": started_at})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_start_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/end", methods=["POST"])
def api_exam_end_room(room_id: str):
    """Mentor ends the exam."""
    log.info("room_end_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        ended_at = RoomService.end_room(room_id, mentor_id)
        return _json_response({"status": "ok", "endedAt": ended_at})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_end_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/questions", methods=["POST"])
def api_exam_save_questions(room_id: str):
    """Save questions array for a room."""
    log.info("room_questions_save_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    questions = body.get("questions", [])
    try:
        count = RoomService.save_questions(room_id, mentor_id, questions)
        return _json_response({"status": "ok", "count": count})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_questions_save_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/media", methods=["POST"])
def api_exam_upload_question_media(room_id: str, question_id: str):
    """Upload a question image/video to GridFS (mentor-only, max 30 MB)."""
    mentor_id = _account_id(request.form.get("mentorId", "").strip())
    file_storage = request.files.get("file")
    room_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
    if not room_mentor:
        return _json_response({"status": "error", "error": "Room not found"}, status=404)
    if room_mentor != mentor_id:
        return _json_response({"status": "error", "error": "Unauthorized"}, status=403)
    try:
        media = QuestionMediaService.upload(room_id, question_id, file_storage)
        return _json_response({"status": "ok", "media": media})
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except Exception as e:
        log.error("question_media_upload_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to store media right now"}, status=503)


@exam_bp.route("/api/exam/room/<room_id>/media/<media_id>", methods=["GET"])
def api_exam_get_question_media(room_id: str, media_id: str):
    """Stream a room's question media from GridFS."""
    try:
        meta, stream = QuestionMediaService.get(room_id, media_id)
        def chunks():
            try:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                stream.close()
        response = Response(stream_with_context(chunks()), mimetype=meta.get("contentType", "application/octet-stream"))
        response.headers["Content-Length"] = str(meta.get("size", 0))
        response.headers["Content-Disposition"] = f'inline; filename="{meta.get("filename", "media").replace(chr(34), "")}"'
        response.headers["Cache-Control"] = "private, max-age=3600"
        return response
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("question_media_read_failed", room_id=room_id, media_id=media_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to read media"}, status=503)


def _media_mentor_guard(room_id: str, mentor_id: str):
    """Return an error response when the caller is not this room's mentor."""
    room_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
    if not room_mentor:
        return _json_response({"status": "error", "error": "Room not found"}, status=404)
    if room_mentor != mentor_id:
        return _json_response({"status": "error", "error": "Unauthorized"}, status=403)
    return None


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/media/chunk", methods=["POST"])
def api_exam_upload_question_media_chunk(room_id: str, question_id: str):
    """Buffer one slice of a chunked question-media upload."""
    mentor_id = _account_id((body.get("mentorId") or "").strip())
    guard = _media_mentor_guard(room_id, mentor_id)
    if guard is not None:
        return guard

    upload_id = request.form.get("uploadId", "").strip()
    seq = request.form.get("seq", "").strip()
    file_storage = request.files.get("file")
    try:
        chunk = QuestionMediaService.store_chunk(room_id, question_id, upload_id, seq, file_storage)
        return _json_response({"status": "ok", "chunk": chunk})
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except Exception as e:
        log.error("question_media_chunk_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to store media chunk"}, status=503)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/media/complete", methods=["POST"])
def api_exam_complete_question_media(room_id: str, question_id: str):
    """Assemble buffered chunks into one stored media file."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id((body.get("mentorId") or "").strip())
    guard = _media_mentor_guard(room_id, mentor_id)
    if guard is not None:
        return guard

    try:
        media = QuestionMediaService.finalize_upload(
            room_id,
            question_id,
            (body.get("uploadId") or "").strip(),
            body.get("filename") or "media",
            body.get("contentType") or "application/octet-stream",
            body.get("totalChunks"),
        )
        return _json_response({"status": "ok", "media": media})
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except Exception as e:
        log.error("question_media_complete_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to finalize media upload"}, status=503)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/media/abort", methods=["POST"])
def api_exam_abort_question_media(room_id: str, question_id: str):
    """Discard buffered chunks for an abandoned upload."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(request.form.get("mentorId", "").strip())
    guard = _media_mentor_guard(room_id, mentor_id)
    if guard is not None:
        return guard

    try:
        removed = QuestionMediaService.abort_upload(room_id, (body.get("uploadId") or "").strip())
        return _json_response({"status": "ok", "removed": removed})
    except Exception as e:
        log.error("question_media_abort_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to abort media upload"}, status=503)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/media/<media_id>", methods=["DELETE"])
def api_exam_delete_question_media(room_id: str, question_id: str, media_id: str):
    """Delete a question's media file from GridFS (mentor-only)."""
    mentor_id = _account_id(request.args.get("mentorId", ""))
    room_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
    if not room_mentor:
        return _json_response({"status": "error", "error": "Room not found"}, status=404)
    if room_mentor != mentor_id:
        return _json_response({"status": "error", "error": "Unauthorized"}, status=403)
    try:
        media = QuestionMediaService.delete(room_id, media_id)
        return _json_response({"status": "ok", "media": media})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("question_media_delete_failed", room_id=room_id, question_id=question_id, media_id=media_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to delete media"}, status=503)


@exam_bp.route("/api/exam/room/<room_id>/dataset", methods=["POST"])
def api_exam_upload_dataset(room_id: str):
    """Upload a dataset for a room."""
    log.info("dataset_upload_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    name = body.get("name", "dataset").strip()
    docs = body.get("docs", [])

    if not isinstance(docs, list):
        return _json_response({"status": "error", "error": "docs must be a JSON array"}, status=400)

    try:
        res = SubmissionService.upload_dataset(room_id, mentor_id, name, docs)
        return _json_response({
            "status": "ok",
            "datasetId": res["datasetId"],
            "name": res["name"],
            "collection": res["collection"],
            "docCount": res["docCount"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("dataset_upload_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>", methods=["DELETE"])
def api_exam_delete_dataset(room_id: str, dataset_id: str):
    """Delete a dataset from a room."""
    log.info("dataset_delete_requested", room_id=room_id, dataset_id=dataset_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        SubmissionService.delete_dataset(room_id, mentor_id, dataset_id)
        return _json_response({"status": "ok"})
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("dataset_delete_failed", room_id=room_id, dataset_id=dataset_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>/schema", methods=["GET"])
def api_exam_dataset_schema(room_id: str, dataset_id: str):
    """Get schema for a room dataset."""
    log.debug("dataset_schema_requested", room_id=room_id, dataset_id=dataset_id, correlation_id=g.get("correlation_id"))
    try:
        res = SubmissionService.get_dataset_schema(room_id, dataset_id)
        return _json_response({
            "status": "ok",
            "schema": res["schema"],
            "collection": res["collection"],
            "docCount": res["docCount"],
            "sampleDocs": res["sampleDocs"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=500)
    except Exception as e:
        log.error("dataset_schema_failed", room_id=room_id, dataset_id=dataset_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/query", methods=["POST"])
def api_exam_run_query(room_id: str):
    """Execute a query against a room dataset."""
    log.info("room_query_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    dataset_ids = body.get("datasetIds", [])
    if not dataset_ids and body.get("datasetId"):
        dataset_ids = [body.get("datasetId")]
    query = body.get("query", "").strip()
    limit = int(body.get("limit", 100))
    limit = max(1, min(limit, 100000))

    if not dataset_ids or not query:
        return _json_response({"status": "error", "error": "datasetIds and query are required"}, status=400)

    if body.get("queryType") == "sql" or body.get("type") == "sql":
        result = execute_job(
            "exam_sql",
            {"roomId": room_id, "datasetIds": dataset_ids, "query": query, "limit": limit},
            lambda: SqlService.execute_room_query(room_id, dataset_ids, query, limit=limit),
            idempotency_key=get_idempotency_key_from_request(request),
        )
    else:
        result = execute_job(
            "exam_mongodb",
            {"roomId": room_id, "datasetIds": dataset_ids, "query": query, "limit": limit},
            lambda: SubmissionService.execute_room_query(room_id, dataset_ids, query, max_results=limit),
            idempotency_key=get_idempotency_key_from_request(request),
        )
    return _json_response(result)


@exam_bp.route("/api/exam/room/<room_id>/freeze", methods=["POST"])
def api_exam_freeze_answer(room_id: str):
    """Mentor: run query and freeze the answer for a question."""
    log.info("freeze_answer_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    question_id = body.get("questionId", "")
    dataset_ids = body.get("datasetIds", [])
    if not dataset_ids and body.get("datasetId"):
        dataset_ids = [body.get("datasetId")]
    query = body.get("query", "").strip()

    if not question_id or not dataset_ids or not query:
        return _json_response({"status": "error", "error": "questionId, datasetIds, and query are required"}, status=400)

    try:
        if body.get("queryType") == "sql" or body.get("type") == "sql":
            result = execute_job(
                "exam_sql",
                {"roomId": room_id, "datasetIds": dataset_ids, "query": query, "limit": 10000},
                lambda: SqlService.execute_room_query(room_id, dataset_ids, query, limit=10000),
                idempotency_key=get_idempotency_key_from_request(request),
            )
            if result.get("status") != "ok":
                raise ValueError(result.get("error", "SQL execution failed"))
            res = SubmissionService.freeze_answer(room_id, mentor_id, question_id, dataset_ids, query, query_type="sql", result=result)
        else:
            result = execute_job(
                "exam_mongodb",
                {"roomId": room_id, "datasetIds": dataset_ids, "query": query, "limit": 100000},
                lambda: SubmissionService.execute_room_query(room_id, dataset_ids, query, max_results=100000),
                idempotency_key=get_idempotency_key_from_request(request),
            )
            if result.get("status") != "ok":
                raise ValueError(result.get("error", "MongoDB execution failed"))
            res = SubmissionService.freeze_answer(room_id, mentor_id, question_id, dataset_ids, query, result=result)
        return _json_response({
            "status": "ok",
            "questionId": res["questionId"],
            "docCount": res["docCount"],
            "preview": res["preview"]
        })
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except Exception as e:
        log.error("freeze_answer_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/submit", methods=["POST"])
def api_exam_submit_answer(room_id: str):
    """Student submits an answer."""
    log.info("submission_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    replay = _exam_replay()
    if replay:
        return replay
    body = request.get_json(force=True, silent=True) or {}
    student_id = body.get("studentId", "")
    question_id = body.get("questionId", "")
    q_type = body.get("type", "query")
    marks = int(body.get("marks", 0))

    if not student_id or not question_id:
        return _json_response({"status": "error", "error": "studentId and questionId are required"}, status=400)

    try:
        _assert_student_account(room_id, student_id)
        res = SubmissionService.submit_answer(room_id, student_id, question_id, q_type, marks, body)
        
        # Check if it was an auto-save operation
        if res.get("autoSaved"):
            payload = {
                "status": "ok",
                "score": res["score"],
                "maxMarks": res["maxMarks"],
                "autoSaved": True
            }
            _exam_record(payload)
            return _json_response(payload)

        ret_data = {
            "status": "ok",
            "score": res["score"],
            "maxMarks": res["maxMarks"],
            "correct": res["correct"]
        }
        if res.get("dryRun"):
            ret_data["dryRun"] = True
        if q_type == "coding":
            ret_data["passedCount"] = res["passedCount"]
            ret_data["totalCount"] = res["totalCount"]

        _exam_record(ret_data)
        return _json_response(ret_data)
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except PermissionError as e:
        err_msg = str(e)
        if err_msg.startswith("kicked:"):
            return _json_response({"status": "error", "error": "kicked", "message": err_msg[7:]}, status=403)
        return _json_response({"status": "error", "error": err_msg}, status=403)
    except Exception as e:
        log.error("submission_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/expected-preview", methods=["GET"])
def api_exam_expected_preview(room_id: str, question_id: str):
    """Retrieve frozen expected answer preview."""
    log.debug("expected_preview_requested", room_id=room_id, question_id=question_id, correlation_id=g.get("correlation_id"))
    try:
        res = SubmissionService.get_expected_preview(room_id, question_id)
        return _json_response({
            "status": "ok",
            "docCount": res["docCount"],
            "preview": res["preview"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=500)
    except Exception as e:
        log.error("expected_preview_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/finish", methods=["POST"])
def api_exam_student_finish(room_id: str, student_id: str):
    """Submit the final exam for a student."""
    log.info("student_finish_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    replay = _exam_replay()
    if replay:
        return replay
    try:
        _assert_student_account(room_id, student_id)
        SubmissionService.finish_exam(room_id, student_id)
        payload = {"status": "ok"}
        _exam_record(payload)
        return _json_response(payload)
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("student_finish_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/self-kick", methods=["POST"])
def api_exam_student_self_kick(room_id: str, student_id: str):
    """Student is self-kicked due to proctoring violation."""
    log.info("student_self_kick_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    try:
        req_data = request.get_json(silent=True) or {}
        reason = req_data.get("reason", "Terminated: Proctoring Rules Violation")
    except:
        reason = "Terminated: Proctoring Rules Violation"

    try:
        _assert_student_account(room_id, student_id)
        ProctoringService.self_kick(room_id, student_id, reason)
        return _json_response({"status": "ok"})
    except Exception as e:
        log.error("student_self_kick_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/leaderboard", methods=["GET"])
def api_exam_leaderboard(room_id: str):
    """Fetch leaderboard from room."""
    log.debug("leaderboard_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        limit = max(1, min(int(request.args.get("limit", 100)), 100))
        cursor = request.args.get("cursor")
        cache = get_cache_manager(default_ttl_seconds=2)
        res = cache.get_or_load(
            f"exam:leaderboard:{room_id}",
            lambda: LeaderboardService.get_room_leaderboard(room_id),
            ttl_seconds=2,
        )
        rows = list(res["leaderboard"])
        if cursor:
            try:
                after = str(decode_cursor(cursor).get("studentId", ""))
                index = next((i for i, row in enumerate(rows) if row.get("studentId") == after), None)
                if index is None:
                    return _json_response({"status": "error", "error": "Invalid leaderboard cursor"}, status=400)
                rows = rows[index + 1:]
            except ValueError:
                return _json_response({"status": "error", "error": "Invalid leaderboard cursor"}, status=400)
        page = rows[:limit]
        has_more = len(rows) > limit
        next_cursor = encode_cursor({"studentId": page[-1]["studentId"]}) if has_more and page else None
        return _json_response({
            "status": "ok",
            "leaderboard": page,
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "maxScore": res["maxScore"],
            "totalQuestions": res["totalQuestions"]
        })
    except Exception as e:
        log.error("leaderboard_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/cleanup", methods=["DELETE", "POST"])
def api_exam_cleanup_room(room_id: str):
    """Delete room from Redis."""
    log.info("room_cleanup_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        RoomService.cleanup_room(room_id, mentor_id)
        return _json_response({"status": "ok", "deletedKeys": 1})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_cleanup_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/violation", methods=["POST"])
def api_exam_student_violation(room_id: str, student_id: str):
    """Student reports a proctoring violation."""
    log.info("violation_record_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    violation_type = body.get("violationType", "")
    try:
        _assert_student_account(room_id, student_id)
        res = ProctoringService.record_violation(room_id, student_id, violation_type)
        return _json_response({
            "status": "ok",
            "fullscreenExits": res["fullscreenExits"],
            "copyPasteAttempts": res["copyPasteAttempts"],
            "lastFlaggedAt": res["lastFlaggedAt"],
            "blocked": res.get("blocked", False),
            "copyPasteLimit": res.get("copyPasteLimit", 3),
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("violation_record_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>", methods=["DELETE"])
def api_exam_remove_student(room_id: str, student_id: str):
    """Mentor removes/kicks a student from the exam room."""
    log.info("student_remove_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    mentor_id = _account_id(request.args.get("mentorId", ""))
    keep_leaderboard = request.args.get("keepInLeaderboard", "0") == "1"
    try:
        ProctoringService.kick_student(room_id, student_id, mentor_id, keep_leaderboard)
        return _json_response({"status": "ok", "studentId": student_id})
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("student_remove_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/reallow", methods=["POST"])
def api_exam_reallow_student(room_id: str, student_id: str):
    """Mentor re-allows a kicked student."""
    log.info("student_reallow_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        ProctoringService.reallow_student(room_id, student_id, mentor_id)
        return _json_response({"status": "ok"})
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("student_reallow_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/kicked", methods=["GET"])
def api_exam_kicked_list(room_id: str):
    """Mentor fetches the list of kicked students."""
    log.debug("kicked_list_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    mentor_id = _account_id(request.args.get("mentorId", ""))
    try:
        kicked = ProctoringService.get_kicked_students(room_id, mentor_id)
        return _json_response({"status": "ok", "kicked": kicked})
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("kicked_list_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/submissions", methods=["GET"])
def api_exam_student_submissions(room_id: str, student_id: str):
    """Mentor fetches submissions for a student or student restores state."""
    log.debug("student_submissions_requested", room_id=room_id, student_id=student_id, correlation_id=g.get("correlation_id"))
    mentor_id = _account_id(request.args.get("mentorId", ""))
    is_student_themselves = request.args.get("isStudent", "") == "1"
    try:
        if is_student_themselves:
            _assert_student_account(room_id, student_id)
        submissions = LeaderboardService.get_student_submissions(room_id, student_id, mentor_id, is_student_themselves)
        return _json_response({"status": "ok", "submissions": submissions})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("student_submissions_failed", room_id=room_id, student_id=student_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/archive", methods=["GET"])
def api_exam_room_archive(room_id: str):
    """Fetch all room data as a single JSON file."""
    log.debug("room_archive_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    mentor_id = _account_id(request.args.get("mentorId", ""))
    try:
        archive = LeaderboardService.get_room_archive(room_id, mentor_id)
        return _json_response({
            "status": "ok",
            "roomId": archive["roomId"],
            "meta": archive["meta"],
            "questions": archive["questions"],
            "datasets": archive["datasets"],
            "participants": archive["participants"],
            "kicked": archive["kicked"],
            "leaderboard": archive["leaderboard"],
            "submissions": archive["submissions"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_archive_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/paper", methods=["GET"])
def api_exam_get_paper(room_id: str):
    """Retrieve full question paper for export."""
    log.debug("paper_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    mentor_id = _account_id(request.args.get("mentorId", ""))
    try:
        paper = RoomService.get_paper(room_id, mentor_id)
        return _json_response({
            "status": "ok",
            "title": paper["title"],
            "timed": paper["timed"],
            "duration": paper["duration"],
            "fullscreenMode": paper["fullscreenMode"],
            "blockCopyPaste": paper["blockCopyPaste"],
            "maxFullscreenExits": paper["maxFullscreenExits"],
            "maxCopyPasteAttempts": paper["maxCopyPasteAttempts"],
            "questions": paper["questions"],
            "datasets": paper["datasets"]
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("paper_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/run", methods=["POST"])
def api_exam_run_code(room_id: str):
    """Run code through the CloudAMQP execution worker."""
    log.info("run_code_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        body = request.get_json(force=True, silent=True) or {}
        question_id = body.get("questionId")
        student_id = str(body.get("studentId") or "")
        language = body.get("language", "python")
        code = body.get("code", "")
        stdins = body.get("stdins")

        if not student_id:
            return _json_response({"status": "error", "error": "studentId is required"}, status=400)
        _assert_student_account(room_id, student_id)
        if RoomService.get_room_status(room_id).get("roomStatus") != "live":
            return _json_response({"status": "error", "error": "Exam is not live"}, status=403)
        if isinstance(stdins, list) and len(stdins) > 20:
            return _json_response({"status": "error", "error": "Too many execution inputs"}, status=400)

        if isinstance(stdins, list):
            queued_result = execute_job(
                "exam_code",
                {"roomId": room_id, "questionId": question_id, "language": language, "code": code, "stdins": stdins},
                lambda: {"results": SubmissionService.run_piston_code(room_id, question_id, language, code, stdins)},
                idempotency_key=get_idempotency_key_from_request(request),
            )
            if queued_result.get("status") == "error":
                return _json_response(queued_result, status=503)
            results = queued_result.get("results", [])
            return _json_response({
                "status": "ok",
                "results": results
            })
        else:
            stdin = body.get("stdin", "")
            queued_result = execute_job(
                "exam_code",
                {"roomId": room_id, "questionId": question_id, "language": language, "code": code, "stdins": stdin},
                lambda: {"results": SubmissionService.run_piston_code(room_id, question_id, language, code, stdin)},
                idempotency_key=get_idempotency_key_from_request(request),
            )
            if queued_result.get("status") == "error":
                return _json_response(queued_result, status=503)
            results = queued_result.get("results", [])
            res = results[0] if results else {"stdout": "", "stderr": "Execution returned no result", "code": 1, "output": ""}
            return _json_response({
                "status": "ok",
                "stdout": res["stdout"],
                "stderr": res["stderr"],
                "code": res["code"],
                "output": res["output"]
            })
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("run_code_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({
            "status": "error",
            "stdout": "",
            "stderr": f"Server error: {e}",
            "code": 1,
            "output": ""
        }, status=500)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/grading-inputs", methods=["POST"])
def api_exam_grading_inputs(room_id: str, question_id: str):
    """Issue coding stdin fixtures for a student's local submission run.

    This endpoint never returns expected outputs, editorial code, or the
    answer key. It is intentionally separate from the room bootstrap so
    hidden inputs are disclosed only when the student submits a coding answer.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
        student_id = str(body.get("studentId") or "")
        if not student_id:
            return _json_response({"status": "error", "error": "studentId is required"}, status=400)
        _assert_student_account(room_id, student_id)
        if RoomService.get_room_status(room_id).get("roomStatus") != "live":
            return _json_response({"status": "error", "error": "Exam is not live"}, status=403)
        cases = RoomService.get_coding_grading_inputs(room_id, question_id)
        return _json_response({"status": "ok", "cases": cases})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("grading_inputs_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Unable to prepare local grading inputs"}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/custom-verify", methods=["POST"])
def api_exam_custom_verify(room_id: str, question_id: str):
    """Use the remote worker only to compare a non-empty custom input."""
    try:
        body = request.get_json(force=True, silent=True) or {}
        student_id = str(body.get("studentId") or "")
        stdin = str(body.get("stdin") or "")
        if not student_id:
            return _json_response({"status": "error", "error": "studentId is required"}, status=400)
        if not stdin.strip():
            return _json_response({"status": "error", "error": "Custom input is empty"}, status=400)
        if len(stdin) > 64 * 1024:
            return _json_response({"status": "error", "error": "Custom input is too large"}, status=400)
        _assert_student_account(room_id, student_id)
        if RoomService.get_room_status(room_id).get("roomStatus") != "live":
            return _json_response({"status": "error", "error": "Exam is not live"}, status=403)
        language = str(body.get("language") or "python")
        code = str(body.get("code") or "")
        result = execute_job(
            "exam_custom_verify",
            {"roomId": room_id, "questionId": question_id, "language": language, "code": code, "stdin": stdin},
            lambda: SubmissionService.verify_custom_input(room_id, question_id, language, code, stdin),
            idempotency_key=get_idempotency_key_from_request(request),
        )
        if result.get("status") == "error" and result.get("code"):
            return _json_response(result, status=503)
        return _json_response({
            "status": "ok",
            "results": [result["student"]],
            "verdict": result["verdict"],
            "expectedOutput": result["expectedOutput"],
            "executionOrigin": "remote",
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("custom_verify_failed", room_id=room_id, question_id=question_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": "Custom verification failed"}, status=500)


@exam_bp.route("/api/exam/room/<room_id>/generate_test_cases", methods=["POST"])
def api_exam_generate_test_cases(room_id: str):
    log.info("generate_test_cases_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        body = request.get_json(force=True, silent=True) or {}
        language = body.get("language", "python")
        code = body.get("editorialCode", "")
        inputs = body.get("inputs", [])
        template_type = body.get("templateType", "scratch")
        driver_code = body.get("driverCode", "") or ""
        queued_result = execute_job(
            "exam_generate_cases",
            {"language": language, "code": code, "inputs": inputs, "templateType": template_type, "driverCode": driver_code},
            lambda: {"outputs": SubmissionService.generate_test_cases(language, code, inputs, template_type, driver_code)},
            idempotency_key=get_idempotency_key_from_request(request),
        )
        if queued_result.get("status") == "error":
            return _json_response(queued_result, status=503)
        outputs = queued_result.get("outputs", [])
        return _json_response({
            "status": "ok",
            "outputs": outputs
        })
    except ValueError as e:
        return _json_response({
            "status": "error",
            "error": str(e)
        }, status=400)
    except Exception as e:
        log.error("generate_test_cases_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@exam_bp.route("/api/exam/room/<room_id>", methods=["DELETE"])
def api_exam_delete_room(room_id: str):
    """Permanently delete room and all its data from MongoDB Atlas."""
    log.info("room_delete_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = _account_id(body.get("mentorId", ""))
    try:
        RoomService.cleanup_room(room_id, mentor_id)
        return _json_response({"status": "ok", "message": "Room and all associated data permanently deleted"})
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except PermissionError as e:
        return _json_response({"status": "error", "error": str(e)}, status=403)
    except Exception as e:
        log.error("room_delete_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


