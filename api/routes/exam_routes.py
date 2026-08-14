"""
api/routes/exam_routes.py
Exam Portal API — Room management, questions, submissions, leaderboard.
Decomposed controller layer delegating to domain services.
"""

import sys
from pathlib import Path
from flask import Blueprint, request, jsonify

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.exam.room_service import RoomService
from services.submission.submission_service import SubmissionService
from services.proctoring.proctoring_service import ProctoringService
from services.leaderboard.leaderboard_service import LeaderboardService
from services.compiler.compiler_service import CompilerService

exam_bp = Blueprint("exam_bp", __name__)

# Expose run_piston_code helper for backwards compatibility
run_piston_code = CompilerService.run_piston_code


@exam_bp.route("/api/exam/room/create", methods=["POST"])
def api_exam_create_room():
    """Create a new exam room."""
    body = request.get_json(force=True, silent=True) or {}
    title = body.get("title", "Untitled Assessment").strip()
    mentor_id = body.get("mentorId", "")
    timed = bool(body.get("timed", False))
    duration = int(body.get("duration", 60))
    fullscreen_mode = bool(body.get("fullscreenMode", False))
    block_copypaste = bool(body.get("blockCopyPaste", False))
    max_exits = int(body.get("maxFullscreenExits", 5))

    if not title:
        return jsonify({"status": "error", "error": "Title is required"}), 400

    try:
        res = RoomService.create_room(title, mentor_id, timed, duration, fullscreen_mode, block_copypaste, max_exits)
        return jsonify({
            "status": "ok",
            "roomId": res["roomId"],
            "mentorId": res["mentorId"],
            "title": res["title"]
        })
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 503


@exam_bp.route("/api/exam/room/<room_id>", methods=["GET"])
def api_exam_get_room(room_id: str):
    """Fetch room metadata + questions + participants."""
    mentor_id = request.args.get("mentorId", "")
    try:
        res = RoomService.get_room(room_id, mentor_id)
        return jsonify({
            "status": "ok",
            "roomId": res["roomId"],
            "meta": res["meta"],
            "questions": res["questions"],
            "participants": res["participants"],
            "datasets": res["datasets"],
            "kicked": res["kicked"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/status", methods=["GET"])
def api_exam_get_room_status(room_id: str):
    """Lightweight status check for room metadata and kicked list."""
    try:
        res = RoomService.get_room_status(room_id)
        return jsonify({
            "status": "ok",
            "roomStatus": res["roomStatus"],
            "startedAt": res["startedAt"],
            "endedAt": res["endedAt"],
            "kicked": res["kicked"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/join", methods=["POST"])
def api_exam_join_room(room_id: str):
    """Student joins a room with strict credential validation."""
    body = request.get_json(force=True, silent=True) or {}
    name = body.get("name", "").strip()
    roll_no = body.get("rollNo", "").strip()
    branch = body.get("branch", "").strip()
    section = body.get("section", "A").strip()

    if not name or not roll_no or not branch:
        return jsonify({"status": "error", "error": "Name, Roll No, and Branch are required"}), 400

    try:
        res = RoomService.join_room(room_id, name, roll_no, branch, section)
        return jsonify({
            "status": "ok",
            "studentId": res["studentId"],
            "roomId": res["roomId"],
            "roomTitle": res["roomTitle"],
            "roomStatus": res["roomStatus"],
            "isLocked": res.get("isLocked", False)
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except ValueError as e:
        return jsonify({"status": "error", "error": str(e)}), 400
    except PermissionError as e:
        err_msg = str(e)
        if err_msg.startswith("kicked:"):
            return jsonify({"status": "error", "error": "kicked", "message": err_msg[7:]}), 403
        return jsonify({"status": "error", "error": err_msg}), 403
    except FileExistsError as e:
        return jsonify({
            "status": "error",
            "error": "already_submitted",
            "message": "Thanks for writing the test. Your test is already submitted."
        }), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/lock", methods=["POST"])
def api_exam_toggle_lock(room_id: str):
    """Mentor locks or unlocks the room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    lock_state = bool(body.get("isLocked", True))
    try:
        res = RoomService.toggle_room_lock(room_id, mentor_id, lock_state)
        return jsonify({"status": "ok", "isLocked": res})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/start", methods=["POST"])
def api_exam_start_room(room_id: str):
    """Mentor starts the exam."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    try:
        started_at = RoomService.start_room(room_id, mentor_id)
        return jsonify({"status": "ok", "startedAt": started_at})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/end", methods=["POST"])
def api_exam_end_room(room_id: str):
    """Mentor ends the exam."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    try:
        ended_at = RoomService.end_room(room_id, mentor_id)
        return jsonify({"status": "ok", "endedAt": ended_at})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/questions", methods=["POST"])
def api_exam_save_questions(room_id: str):
    """Save questions array for a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    questions = body.get("questions", [])
    try:
        count = RoomService.save_questions(room_id, mentor_id, questions)
        return jsonify({"status": "ok", "count": count})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/dataset", methods=["POST"])
def api_exam_upload_dataset(room_id: str):
    """Upload a dataset for a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    name = body.get("name", "dataset").strip()
    docs = body.get("docs", [])

    if not isinstance(docs, list):
        return jsonify({"status": "error", "error": "docs must be a JSON array"}), 400

    try:
        res = SubmissionService.upload_dataset(room_id, mentor_id, name, docs)
        return jsonify({
            "status": "ok",
            "datasetId": res["datasetId"],
            "name": res["name"],
            "collection": res["collection"],
            "docCount": res["docCount"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>", methods=["DELETE"])
def api_exam_delete_dataset(room_id: str, dataset_id: str):
    """Delete a dataset from a room."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    try:
        SubmissionService.delete_dataset(room_id, mentor_id, dataset_id)
        return jsonify({"status": "ok"})
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/dataset/<dataset_id>/schema", methods=["GET"])
def api_exam_dataset_schema(room_id: str, dataset_id: str):
    """Get schema for a room dataset."""
    try:
        res = SubmissionService.get_dataset_schema(room_id, dataset_id)
        return jsonify({
            "status": "ok",
            "schema": res["schema"],
            "collection": res["collection"],
            "docCount": res["docCount"],
            "sampleDocs": res["sampleDocs"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except ValueError as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/query", methods=["POST"])
def api_exam_run_query(room_id: str):
    """Execute a query against a room dataset."""
    body = request.get_json(force=True, silent=True) or {}
    dataset_ids = body.get("datasetIds", [])
    if not dataset_ids and body.get("datasetId"):
        dataset_ids = [body.get("datasetId")]
    query = body.get("query", "").strip()
    limit = int(body.get("limit", 100))

    if not dataset_ids or not query:
        return jsonify({"status": "error", "error": "datasetIds and query are required"}), 400

    result = SubmissionService.execute_room_query(room_id, dataset_ids, query, max_results=limit)
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

    if not question_id or not dataset_ids or not query:
        return jsonify({"status": "error", "error": "questionId, datasetIds, and query are required"}), 400

    try:
        res = SubmissionService.freeze_answer(room_id, mentor_id, question_id, dataset_ids, query)
        return jsonify({
            "status": "ok",
            "questionId": res["questionId"],
            "docCount": res["docCount"],
            "preview": res["preview"]
        })
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except ValueError as e:
        return jsonify({"status": "error", "error": str(e)}), 400
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/submit", methods=["POST"])
def api_exam_submit_answer(room_id: str):
    """Student submits an answer."""
    body = request.get_json(force=True, silent=True) or {}
    student_id = body.get("studentId", "")
    question_id = body.get("questionId", "")
    q_type = body.get("type", "query")
    marks = int(body.get("marks", 0))

    if not student_id or not question_id:
        return jsonify({"status": "error", "error": "studentId and questionId are required"}), 400

    try:
        res = SubmissionService.submit_answer(room_id, student_id, question_id, q_type, marks, body)
        
        # Check if it was an auto-save operation
        if res.get("autoSaved"):
            return jsonify({
                "status": "ok",
                "score": res["score"],
                "maxMarks": res["maxMarks"],
                "autoSaved": True
            })

        ret_data = {
            "status": "ok",
            "score": res["score"],
            "maxMarks": res["maxMarks"],
            "correct": res["correct"]
        }
        if q_type == "coding":
            ret_data["passedCount"] = res["passedCount"]
            ret_data["totalCount"] = res["totalCount"]

        return jsonify(ret_data)
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except ValueError as e:
        return jsonify({"status": "error", "error": str(e)}), 400
    except PermissionError as e:
        err_msg = str(e)
        if err_msg.startswith("kicked:"):
            return jsonify({"status": "error", "error": "kicked", "message": err_msg[7:]}), 403
        return jsonify({"status": "error", "error": err_msg}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/question/<question_id>/expected-preview", methods=["GET"])
def api_exam_expected_preview(room_id: str, question_id: str):
    """Retrieve frozen expected answer preview."""
    try:
        res = SubmissionService.get_expected_preview(room_id, question_id)
        return jsonify({
            "status": "ok",
            "docCount": res["docCount"],
            "preview": res["preview"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except ValueError as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/finish", methods=["POST"])
def api_exam_student_finish(room_id: str, student_id: str):
    """Submit the final exam for a student."""
    try:
        SubmissionService.finish_exam(room_id, student_id)
        return jsonify({"status": "ok"})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/self-kick", methods=["POST"])
def api_exam_student_self_kick(room_id: str, student_id: str):
    """Student is self-kicked due to proctoring violation."""
    try:
        req_data = request.get_json(silent=True) or {}
        reason = req_data.get("reason", "Terminated: Proctoring Rules Violation")
    except:
        reason = "Terminated: Proctoring Rules Violation"

    try:
        ProctoringService.self_kick(room_id, student_id, reason)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/leaderboard", methods=["GET"])
def api_exam_leaderboard(room_id: str):
    """Fetch leaderboard from room."""
    try:
        res = LeaderboardService.get_room_leaderboard(room_id)
        return jsonify({
            "status": "ok",
            "leaderboard": res["leaderboard"],
            "maxScore": res["maxScore"],
            "totalQuestions": res["totalQuestions"]
        })
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/cleanup", methods=["DELETE", "POST"])
def api_exam_cleanup_room(room_id: str):
    """Delete room from Redis."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    try:
        RoomService.cleanup_room(room_id, mentor_id)
        return jsonify({"status": "ok", "deletedKeys": 1})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/violation", methods=["POST"])
def api_exam_student_violation(room_id: str, student_id: str):
    """Student reports a proctoring violation."""
    body = request.get_json(force=True, silent=True) or {}
    violation_type = body.get("violationType", "")
    try:
        res = ProctoringService.record_violation(room_id, student_id, violation_type)
        return jsonify({
            "status": "ok",
            "fullscreenExits": res["fullscreenExits"],
            "copyPasteAttempts": res["copyPasteAttempts"],
            "lastFlaggedAt": res["lastFlaggedAt"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>", methods=["DELETE"])
def api_exam_remove_student(room_id: str, student_id: str):
    """Mentor removes/kicks a student from the exam room."""
    mentor_id = request.args.get("mentorId", "")
    keep_leaderboard = request.args.get("keepInLeaderboard", "0") == "1"
    try:
        ProctoringService.kick_student(room_id, student_id, mentor_id, keep_leaderboard)
        return jsonify({"status": "ok", "studentId": student_id})
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/reallow", methods=["POST"])
def api_exam_reallow_student(room_id: str, student_id: str):
    """Mentor re-allows a kicked student."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId", "")
    try:
        ProctoringService.reallow_student(room_id, student_id, mentor_id)
        return jsonify({"status": "ok"})
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/kicked", methods=["GET"])
def api_exam_kicked_list(room_id: str):
    """Mentor fetches the list of kicked students."""
    mentor_id = request.args.get("mentorId", "")
    try:
        kicked = ProctoringService.get_kicked_students(room_id, mentor_id)
        return jsonify({"status": "ok", "kicked": kicked})
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/student/<student_id>/submissions", methods=["GET"])
def api_exam_student_submissions(room_id: str, student_id: str):
    """Mentor fetches submissions for a student or student restores state."""
    mentor_id = request.args.get("mentorId", "")
    is_student_themselves = request.args.get("isStudent", "") == "1"
    try:
        submissions = LeaderboardService.get_student_submissions(room_id, student_id, mentor_id, is_student_themselves)
        return jsonify({"status": "ok", "submissions": submissions})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/archive", methods=["GET"])
def api_exam_room_archive(room_id: str):
    """Fetch all room data as a single JSON file."""
    mentor_id = request.args.get("mentorId", "")
    try:
        archive = LeaderboardService.get_room_archive(room_id, mentor_id)
        return jsonify({
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
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/paper", methods=["GET"])
def api_exam_get_paper(room_id: str):
    """Retrieve full question paper for export."""
    mentor_id = request.args.get("mentorId", "")
    try:
        paper = RoomService.get_paper(room_id, mentor_id)
        return jsonify({
            "status": "ok",
            "title": paper["title"],
            "timed": paper["timed"],
            "duration": paper["duration"],
            "fullscreenMode": paper["fullscreenMode"],
            "blockCopyPaste": paper["blockCopyPaste"],
            "maxFullscreenExits": paper["maxFullscreenExits"],
            "questions": paper["questions"],
            "datasets": paper["datasets"]
        })
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>/run", methods=["POST"])
def api_exam_run_code(room_id: str):
    """Run code using Piston sandbox."""
    try:
        body = request.get_json(force=True, silent=True) or {}
        question_id = body.get("questionId")
        language = body.get("language", "python")
        code = body.get("code", "")
        stdins = body.get("stdins")

        if isinstance(stdins, list):
            results = SubmissionService.run_piston_code(room_id, question_id, language, code, stdins)
            return jsonify({
                "status": "ok",
                "results": results
            })
        else:
            stdin = body.get("stdin", "")
            results = SubmissionService.run_piston_code(room_id, question_id, language, code, stdin)
            res = results[0]
            return jsonify({
                "status": "ok",
                "stdout": res["stdout"],
                "stderr": res["stderr"],
                "code": res["code"],
                "output": res["output"]
            })
    except Exception as e:
        return jsonify({
            "status": "error",
            "stdout": "",
            "stderr": f"Server error: {e}",
            "code": 1,
            "output": ""
        }), 500


@exam_bp.route("/api/exam/room/<room_id>/generate_test_cases", methods=["POST"])
def api_exam_generate_test_cases(room_id: str):
    try:
        body = request.get_json(force=True, silent=True) or {}
        language = body.get("language", "python")
        code = body.get("editorialCode", "")
        inputs = body.get("inputs", [])
        template_type = body.get("templateType", "scratch")
        outputs = SubmissionService.generate_test_cases(language, code, inputs, template_type, driver_code)
        return jsonify({
            "status": "ok",
            "outputs": outputs
        })
    except ValueError as e:
        return jsonify({
            "status": "error",
            "error": str(e)
        })
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@exam_bp.route("/api/exam/room/<room_id>", methods=["DELETE"])
def api_exam_delete_room(room_id: str):
    """Permanently delete room and all its data from MongoDB Atlas."""
    body = request.get_json(force=True, silent=True) or {}
    mentor_id = body.get("mentorId") or request.args.get("mentorId", "")
    try:
        RoomService.cleanup_room(room_id, mentor_id)
        return jsonify({"status": "ok", "message": "Room and all associated data permanently deleted"})
    except KeyError as e:
        return jsonify({"status": "error", "error": str(e)}), 404
    except PermissionError as e:
        return jsonify({"status": "error", "error": str(e)}), 403
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


