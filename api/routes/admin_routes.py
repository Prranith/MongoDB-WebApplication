"""Secure operational admin APIs for CodeLeaf.

The admin identity is deliberately separate from application users. Credentials
are supplied through server-only environment variables and the authenticated
admin session is persisted server-side in the auth database. These endpoints
never return password hashes, session tokens, queue payloads, or private exam
answers.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import hmac
from datetime import datetime, timezone
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import Blueprint, jsonify, request, session, g
from werkzeug.security import check_password_hash

from services.shared.redis_client import get_auth_db, get_exam_db
from services.shared.pagination import encode_cursor, decode_cursor
from services.shared.rate_limit import make_rate_limiter
from services.execution.job_queue import (
    QUEUE_NAMES,
    QUEUE_URL,
    active_workers,
    enabled as queue_enabled,
)
from services.meeting.meeting_service import MeetingService
from services.exam.media_service import QuestionMediaService
from utils.logger import get_logger, bind_component


admin_bp = Blueprint("admin_bp", __name__)
log = bind_component(get_logger(__name__), "admin_api")
_login_limiter = make_rate_limiter()
_ADMIN_SESSION_TTL = max(900, int(os.getenv("ADMIN_SESSION_TTL_SECONDS", "28800")))


def _now():
    return datetime.now(timezone.utc)


def _json(value):
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json(v) for k, v in value.items() if k not in {"passwordHash", "token", "tokenHash", "hostToken"}}
    if isinstance(value, list):
        return [_json(v) for v in value]
    if isinstance(value, set):
        return [_json(v) for v in value]
    return value


def _admin_configured():
    return bool(os.getenv("ADMIN_EMAIL", "").strip() and os.getenv("ADMIN_PASSWORD_HASH", "").strip())


def _session_digest(token):
    return hashlib.sha256(str(token).encode()).hexdigest()


def _audit(action, target="", outcome="success", metadata=None):
    db = get_auth_db()
    if db is None:
        return
    admin = session.get("admin_identity") or {}
    try:
        db.admin_audit_events.insert_one({
            "adminEmail": admin.get("email", "unknown"),
            "role": admin.get("role", "unknown"),
            "action": action,
            "target": str(target or "")[:200],
            "outcome": outcome,
            "metadata": _json(metadata or {}),
            "correlationId": g.get("correlation_id"),
            "createdAt": _now(),
        })
    except Exception as exc:
        log.warning("admin_audit_write_failed", error=str(exc), action=action)


def _current_admin():
    raw = session.get("admin_session")
    if not raw:
        return None
    db = get_auth_db()
    if db is None:
        return None
    record = db.admin_sessions.find_one({"_id": _session_digest(raw), "expiresAt": {"$gt": _now()}})
    if not record:
        session.pop("admin_session", None)
        session.pop("admin_identity", None)
        return None
    identity = session.get("admin_identity") or {"email": record.get("email"), "role": record.get("role", "super_admin")}
    db.admin_sessions.update_one({"_id": record["_id"]}, {"$set": {"lastSeenAt": _now()}})
    return identity


def _require_admin(*roles):
    allowed = set(roles or ("super_admin", "operations_admin", "support_admin", "auditor"))

    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            admin = _current_admin()
            if not admin:
                return jsonify({"error": "Administrator authentication required", "code": "ADMIN_AUTH_REQUIRED"}), 401
            if admin.get("role") not in allowed:
                return jsonify({"error": "Administrator permission denied", "code": "ADMIN_FORBIDDEN"}), 403
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                expected = session.get("admin_csrf") or ""
                supplied = request.headers.get("X-CSRF-Token", "")
                if not expected or not supplied or not hmac.compare_digest(str(expected), str(supplied)):
                    return jsonify({"error": "Administrator CSRF validation failed", "code": "ADMIN_CSRF_FAILED"}), 403
            g.admin = admin
            return fn(*args, **kwargs)
        return wrapped
    return decorator


def _limit():
    try:
        return max(1, min(int(request.args.get("limit", 25)), 100))
    except (TypeError, ValueError):
        return 25


def _page(rows, limit, cursor_field="id"):
    items = list(rows)
    has_more = len(items) > limit
    items = items[:limit]
    next_cursor = encode_cursor({cursor_field: items[-1].get(cursor_field)}) if has_more and items else None
    return {"items": items, "meta": {"limit": limit, "hasMore": has_more, "nextCursor": next_cursor}}


def _rooms_collection():
    db = get_exam_db()
    return db[os.getenv("EXAM_ROOM_COLLECTION", "rooms")] if db is not None else None


def _jobs_collection():
    db = get_exam_db()
    return db[os.getenv("EXECUTION_JOB_COLLECTION", "execution_jobs")] if db is not None else None


@admin_bp.post("/api/admin/auth/login")
def admin_login():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    allowed, _, retry = _login_limiter.check(f"admin-login:{ip}:{email}", max_requests=6, window_seconds=300)
    if not allowed:
        response = jsonify({"error": "Too many administrator login attempts. Try again later."})
        response.status_code = 429
        response.headers["Retry-After"] = str(retry)
        return response
    if not _admin_configured():
        return jsonify({"error": "Admin credentials are not configured on the server."}), 503
    configured_email = os.getenv("ADMIN_EMAIL", "").strip().lower()
    password_hash = os.getenv("ADMIN_PASSWORD_HASH", "").strip()
    if email != configured_email or not check_password_hash(password_hash, password):
        _audit("admin_login", email, "failed")
        return jsonify({"error": "Invalid administrator credentials."}), 401
    db = get_auth_db()
    if db is None:
        return jsonify({"error": "Authentication database is unavailable."}), 503
    token = secrets.token_urlsafe(48)
    role = os.getenv("ADMIN_ROLE", "super_admin").strip().lower() or "super_admin"
    now = _now()
    db.admin_sessions.create_index("expiresAt", expireAfterSeconds=0)
    db.admin_audit_events.create_index("createdAt")
    db.admin_sessions.insert_one({"_id": _session_digest(token), "email": configured_email, "role": role,
                                  "createdAt": now, "lastSeenAt": now,
                                  "expiresAt": now.fromtimestamp(now.timestamp() + _ADMIN_SESSION_TTL, tz=timezone.utc)})
    # Keep the ordinary CodeLeaf auth session intact. Admin authentication is
    # a separate identity and must not sign the user out of the workspace.
    session.pop("admin_session", None)
    session.pop("admin_identity", None)
    session.pop("admin_csrf", None)
    session["admin_session"] = token
    session["admin_identity"] = {"email": configured_email, "role": role}
    session["admin_csrf"] = secrets.token_urlsafe(32)
    session.permanent = True
    _audit("admin_login", configured_email)
    return jsonify({"authenticated": True, "admin": {"email": configured_email, "role": role}, "csrfToken": session["admin_csrf"]})


@admin_bp.get("/api/admin/auth/me")
@_require_admin()
def admin_me():
    return jsonify({"authenticated": True, "admin": g.admin, "csrfToken": session.get("admin_csrf")})


@admin_bp.post("/api/admin/auth/logout")
@_require_admin()
def admin_logout():
    raw = session.pop("admin_session", None)
    if raw:
        db = get_auth_db()
        if db is not None:
            db.admin_sessions.delete_one({"_id": _session_digest(raw)})
    _audit("admin_logout")
    # Do not clear the normal student/mentor auth session when the admin
    # console is signed out.
    session.pop("admin_identity", None)
    session.pop("admin_csrf", None)
    return jsonify({"authenticated": False})


@admin_bp.get("/api/admin/overview")
@_require_admin("super_admin", "operations_admin", "support_admin", "auditor")
def admin_overview():
    auth = get_auth_db()
    exam = get_exam_db()
    users = auth.users if auth is not None else None
    rooms = _rooms_collection()
    jobs = _jobs_collection()
    now = _now()
    active_sessions = auth.sessions.count_documents({"expiresAt": {"$gt": now}}) if auth is not None else None
    workers = active_workers()
    exam_count = rooms.count_documents({}) if rooms is not None else None
    active_exams = rooms.count_documents({"status": {"$in": ["live", "started", "running"]}}) if rooms is not None else None
    meetings = exam["meeting_rooms"] if exam is not None else None
    active_meetings = meetings.count_documents({"isOpen": True}) if meetings is not None else None
    job_counts = {}
    if jobs is not None:
        for status in ("queued", "running", "completed", "failed"):
            job_counts[status] = jobs.count_documents({"status": status})
    exam_status_counts = {}
    if rooms is not None:
        for status in ("waiting", "live", "ended"):
            exam_status_counts[status] = rooms.count_documents({"status": status})
    meeting_status_counts = {}
    if meetings is not None:
        meeting_status_counts = {
            "open": meetings.count_documents({"isOpen": True}),
            "closed": meetings.count_documents({"isOpen": False}),
        }
    sources = {"database": bool(auth is not None and exam is not None), "queue": queue_enabled(),
               "executionWorker": bool(workers) if queue_enabled() else None, "brokerManagement": False,
               "hostMetrics": False, "requestMetrics": False}
    degraded = not sources["database"] or (queue_enabled() and not workers)
    return jsonify({"data": {"users": users.count_documents({}) if users is not None else None,
                               "activeSessions": active_sessions, "examRooms": exam_count, "activeExams": active_exams,
                               "activeMeetings": active_meetings, "queuedJobs": job_counts.get("queued"),
                               "runningJobs": job_counts.get("running"), "completedJobs": job_counts.get("completed"),
                               "failedJobs": job_counts.get("failed"), "activeExecutionWorkers": len(workers),
                               "queueNames": sorted(set(QUEUE_NAMES.values()))},
                    "breakdown": {"examStatuses": exam_status_counts, "meetingStatuses": meeting_status_counts},
                    "workers": _json(workers),
                    "health": "degraded" if degraded else "healthy", "sources": sources,
                    "meta": {"asOf": now.isoformat(), "sourceStatus": "available" if sources["database"] else "unavailable"}})


@admin_bp.get("/api/admin/users")
@_require_admin()
def admin_users():
    db = get_auth_db()
    if db is None:
        return jsonify({"error": "Authentication database unavailable", "items": [], "meta": {"sourceStatus": "unavailable"}}), 503
    limit = _limit()
    query = {}
    search = str(request.args.get("q") or "").strip()[:80]
    if search:
        import re
        pattern = re.compile(re.escape(search), re.IGNORECASE)
        query["$or"] = [{"email": pattern}, {"name": pattern}, {"college": pattern}]
    cursor = request.args.get("cursor")
    if cursor:
        try:
            query["_id"] = {"$gt": ObjectId(decode_cursor(cursor).get("id"))}
        except (ValueError, InvalidId, TypeError):
            return jsonify({"error": "Invalid pagination cursor"}), 400
    docs = db.users.find(query, {"passwordHash": 0}).sort("_id", 1).limit(limit + 1)
    items = []
    for doc in docs:
        item = _json(doc)
        item["id"] = item.pop("_id", "")
        item["sessionActive"] = bool(db.sessions.find_one({"userId": doc.get("_id"), "expiresAt": {"$gt": _now()}}, {"_id": 1}))
        items.append(item)
    return jsonify(_page(items, limit))


@admin_bp.get("/api/admin/users/<user_id>")
@_require_admin()
def admin_user_detail(user_id):
    db = get_auth_db()
    try:
        object_id = ObjectId(user_id)
    except (InvalidId, TypeError):
        return jsonify({"error": "User not found"}), 404
    doc = db.users.find_one({"_id": object_id}, {"passwordHash": 0}) if db is not None else None
    if not doc:
        return jsonify({"error": "User not found"}), 404
    events = list(db.auth_events.find({"email": doc.get("email")}, {"_id": 0, "token": 0, "password": 0}).sort("createdAt", -1).limit(50))
    return jsonify({"user": _json(doc), "authEvents": _json(events), "activeSessions": db.sessions.count_documents({"userId": object_id, "expiresAt": {"$gt": _now()}})})


@admin_bp.delete("/api/admin/users/<user_id>")
@_require_admin("super_admin", "operations_admin")
def admin_delete_user(user_id):
    db = get_auth_db()
    try:
        object_id = ObjectId(user_id)
    except (InvalidId, TypeError):
        return jsonify({"error": "User not found"}), 404
    if db is None:
        return jsonify({"error": "Authentication database unavailable"}), 503
    user = db.users.find_one({"_id": object_id}, {"email": 1})
    if not user:
        return jsonify({"error": "User not found"}), 404
    db.users.delete_one({"_id": object_id})
    for collection in (db.sessions, db.identities, db.email_otps, db.password_resets):
        collection.delete_many({"userId": object_id})
    if user.get("email"):
        db.pending_signups.delete_many({"email": user["email"]})
    _audit("admin_delete_user", user_id)
    return jsonify({"deleted": True, "userId": user_id})


@admin_bp.get("/api/admin/exams")
@_require_admin()
def admin_exams():
    rooms = _rooms_collection()
    if rooms is None:
        return jsonify({"items": [], "meta": {"sourceStatus": "unavailable"}}), 503
    limit = _limit()
    status = str(request.args.get("status") or "").strip()
    query = {"status": status} if status else {}
    docs = rooms.find(query).sort("createdAt", -1).limit(limit + 1)
    items = []
    for doc in docs:
        participants = {k: v for k, v in doc.items() if str(k).startswith("participant:")}
        questions = []
        try:
            questions = json.loads(doc.get("questions", "[]")) if isinstance(doc.get("questions"), str) else (doc.get("questions") or [])
        except Exception:
            pass
        items.append({"id": str(doc.get("_id", "")), "title": doc.get("title", "Untitled"), "status": doc.get("status", "unknown"),
                      "mentorId": doc.get("mentorId", ""), "createdAt": doc.get("createdAt"), "startedAt": doc.get("startedAt"),
                      "endedAt": doc.get("endedAt"), "duration": doc.get("duration"), "questionCount": len(questions),
                      "participantCount": len(participants), "fullscreenMode": doc.get("fullscreenMode") in ("1", 1, True),
                      "blockCopyPaste": doc.get("blockCopyPaste") in ("1", 1, True)})
    return jsonify(_page(_json(items), limit))


@admin_bp.get("/api/admin/exams/<room_id>")
@_require_admin()
def admin_exam_detail(room_id):
    rooms = _rooms_collection()
    doc = rooms.find_one({"_id": room_id.strip().upper()}) if rooms is not None else None
    if not doc:
        return jsonify({"error": "Exam room not found"}), 404
    participants = []
    for key, value in doc.items():
        if not str(key).startswith("participant:"):
            continue
        try:
            parsed = json.loads(value) if isinstance(value, str) else value
        except Exception:
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        student_id = str(key)[12:]
        submissions_raw = doc.get(f"submissions:{student_id}", "{}")
        try:
            submissions = json.loads(submissions_raw) if isinstance(submissions_raw, str) else (submissions_raw or {})
        except (TypeError, ValueError):
            submissions = {}
        if not isinstance(submissions, dict):
            submissions = {}
        normalized_submissions = {}
        for question_id, submission in submissions.items():
            try:
                normalized_submissions[question_id] = (
                    json.loads(submission) if isinstance(submission, str) else submission
                )
            except (TypeError, ValueError):
                normalized_submissions[question_id] = {"raw": str(submission)}
        participants.append({
            "studentId": student_id,
            **_json(parsed),
            "submissions": _json(normalized_submissions),
            "submissionCount": len(normalized_submissions),
        })
    raw_questions = doc.get("questions", "[]")
    try:
        questions = json.loads(raw_questions) if isinstance(raw_questions, str) else (raw_questions or [])
    except Exception:
        questions = []
    if not isinstance(questions, list):
        questions = []
    question_summary = [{"id": q.get("id"), "title": q.get("title") or q.get("name"), "type": q.get("type"), "marks": q.get("marks") or q.get("points")} for q in questions if isinstance(q, dict)]
    raw_paper_audit = doc.get("paperAudit", "[]")
    try:
        paper_audit = json.loads(raw_paper_audit) if isinstance(raw_paper_audit, str) else (raw_paper_audit or [])
    except (TypeError, ValueError):
        paper_audit = []
    if not isinstance(paper_audit, list):
        paper_audit = []
    safe = {
        k: v for k, v in doc.items()
        if k not in {"questions", "datasets", "hostToken"}
        and not str(k).startswith("participant:")
        and not str(k).startswith("submissions:")
        and not str(k).startswith("q_answer:")
        and not str(k).startswith("dataset_docs:")
        and not str(k).startswith("dataset_meta:")
    }
    return jsonify({
        "participants": participants,
        "questions": question_summary,
        "questionDetails": _json(questions),
        "room": _json({**safe, "paperAudit": paper_audit}),
        "media": [],
        "telemetry": {
            "submissionCount": sum(p["submissionCount"] for p in participants),
            "activeParticipants": sum(1 for p in participants if not p.get("finished")),
            "flaggedParticipants": sum(
                1 for p in participants
                if (p.get("fullscreenExits", 0) or 0) + (p.get("copyPasteAttempts", 0) or 0) > 0
            ),
        },
    })


@admin_bp.post("/api/admin/exams/<room_id>/complete")
@_require_admin("super_admin", "operations_admin")
def admin_complete_exam(room_id):
    rooms = _rooms_collection()
    room_key = room_id.strip().upper()
    if rooms is None:
        return jsonify({"error": "Exam database unavailable"}), 503
    result = rooms.update_one({"_id": room_key}, {"$set": {"status": "ended", "endedAt": _now().isoformat()}})
    if not result.matched_count:
        return jsonify({"error": "Exam room not found"}), 404
    _audit("admin_complete_exam", room_key)
    return jsonify({"completed": True, "roomId": room_key})


@admin_bp.delete("/api/admin/exams/<room_id>")
@_require_admin("super_admin", "operations_admin")
def admin_delete_exam(room_id):
    """Permanently remove an exam and its room-scoped media."""
    rooms = _rooms_collection()
    room_key = room_id.strip().upper()
    if rooms is None:
        return jsonify({"error": "Exam database unavailable"}), 503
    room = rooms.find_one({"_id": room_key}, {"mentorId": 1, "title": 1})
    if not room:
        return jsonify({"error": "Exam room not found"}), 404
    if os.getenv("MONGO_URI", "").strip():
        try:
            QuestionMediaService.delete_room_media(room_key)
        except Exception as exc:
            log.warning("admin_exam_media_cleanup_failed", room_id=room_key, error=str(exc))
    result = rooms.delete_one({"_id": room_key})
    if not result.deleted_count:
        return jsonify({"error": "Exam room was already removed"}), 404
    _audit("admin_delete_exam", room_key, metadata={"title": room.get("title", "")})
    log.warning("admin_exam_deleted", room_id=room_key, title=room.get("title", ""))
    return jsonify({"deleted": True, "roomId": room_key})


@admin_bp.get("/api/admin/meetings")
@_require_admin()
def admin_meetings():
    db = get_exam_db()
    collection = db["meeting_rooms"] if db is not None else None
    if collection is None:
        return jsonify({"items": [], "meta": {"sourceStatus": "unavailable"}}), 503
    limit = _limit()
    docs = collection.find({}).sort("activeAt", -1).limit(limit + 1)
    items = []
    for doc in docs:
        participants = doc.get("participants") or {}
        items.append({"id": str(doc.get("_id", "")), "roomId": doc.get("roomId", str(doc.get("_id", ""))),
                      "roomTitle": doc.get("roomTitle", "CodeLeaf Meeting"), "hostName": doc.get("hostName", ""),
                      "ownerAccountId": doc.get("ownerAccountId", ""), "isOpen": bool(doc.get("isOpen", False)),
                      "createdAt": doc.get("createdAt"), "activeAt": doc.get("activeAt"), "endedAt": doc.get("endedAt"),
                      "participantCount": len(participants), "participants": [{"peerId": key, **_json(value)} for key, value in participants.items()]})
    return jsonify(_page(_json(items), limit))


@admin_bp.post("/api/admin/meetings/<room_id>/complete")
@_require_admin("super_admin", "operations_admin")
def admin_complete_meeting(room_id):
    db = get_exam_db()
    collection = db["meeting_rooms"] if db is not None else None
    room_key = room_id.strip().upper()
    if collection is None:
        return jsonify({"error": "Meeting database unavailable"}), 503
    result = collection.update_one({"$or": [{"_id": room_key}, {"roomId": room_key}]}, {"$set": {"isOpen": False, "endedAt": _now().isoformat()}})
    if not result.matched_count:
        return jsonify({"error": "Meeting room not found"}), 404
    _audit("admin_complete_meeting", room_key)
    return jsonify({"completed": True, "roomId": room_key})


@admin_bp.get("/api/admin/meetings/<room_id>")
@_require_admin()
def admin_meeting_detail(room_id):
    db = get_exam_db()
    collection = db["meeting_rooms"] if db is not None else None
    room_key = room_id.strip().upper()
    room = collection.find_one({"$or": [{"_id": room_key}, {"roomId": room_key}]}) if collection is not None else None
    if not room:
        return jsonify({"error": "Meeting room not found"}), 404
    room.pop("hostToken", None)
    return jsonify({"room": _json(room)})


@admin_bp.delete("/api/admin/meetings/<room_id>")
@_require_admin("super_admin", "operations_admin")
def admin_delete_meeting(room_id):
    """Permanently remove a meeting room and its retained activity."""
    db = get_exam_db()
    collection = db["meeting_rooms"] if db is not None else None
    room_key = room_id.strip().upper()
    if collection is None:
        return jsonify({"error": "Meeting database unavailable"}), 503
    room = collection.find_one({"$or": [{"_id": room_key}, {"roomId": room_key}]}, {"roomTitle": 1})
    if not room:
        return jsonify({"error": "Meeting room not found"}), 404
    result = collection.delete_one({"_id": room.get("_id")})
    if not result.deleted_count:
        return jsonify({"error": "Meeting room was already removed"}), 404
    MeetingService._rooms.pop(room_key, None)
    _audit("admin_delete_meeting", room_key, metadata={"title": room.get("roomTitle", "")})
    log.warning("admin_meeting_deleted", room_id=room_key, title=room.get("roomTitle", ""))
    return jsonify({"deleted": True, "roomId": room_key})


@admin_bp.get("/api/admin/queues")
@_require_admin("super_admin", "operations_admin")
def admin_queues():
    jobs = _jobs_collection()
    rows = []
    for queue_name in sorted(set(QUEUE_NAMES.values())):
        kinds = [kind for kind, name in QUEUE_NAMES.items() if name == queue_name]
        row = {"name": queue_name, "kinds": kinds, "brokerConfigured": bool(QUEUE_URL), "brokerManagement": "unavailable",
               "pending": None, "running": None, "completed": None, "failed": None, "sourceStatus": "unavailable"}
        if jobs is not None:
            row.update({"pending": jobs.count_documents({"kind": {"$in": kinds}, "status": "queued"}),
                        "running": jobs.count_documents({"kind": {"$in": kinds}, "status": "running"}),
                        "completed": jobs.count_documents({"kind": {"$in": kinds}, "status": "completed"}),
                        "failed": jobs.count_documents({"kind": {"$in": kinds}, "status": "failed"}), "sourceStatus": "available"})
        rows.append(row)
    recent = list(jobs.find({}, {"payload": 0, "result": 0}).sort("updatedAt", -1).limit(50)) if jobs is not None else []
    return jsonify({"queues": rows, "jobs": _json(recent), "workers": _json(active_workers()),
                    "meta": {"asOf": _now().isoformat(), "brokerManagementNote": "Broker-level consumer metrics require a CloudAMQP management API credential; execution job metrics are sourced from MongoDB."}})


@admin_bp.get("/api/admin/services")
@_require_admin("super_admin", "operations_admin")
def admin_services():
    auth = get_auth_db()
    exam = get_exam_db()
    checks = [{"name": "auth-database", "status": "healthy" if auth is not None else "down", "source": "MongoDB connection"},
              {"name": "exam-database", "status": "healthy" if exam is not None else "down", "source": "MongoDB connection"},
              {"name": "execution-queue", "status": "healthy" if queue_enabled() else "unavailable", "source": "CLOUDAMQP_URL + execution_jobs"},
              {"name": "broker-management", "status": "unavailable", "source": "Not configured"},
              {"name": "host-metrics", "status": "unavailable", "source": "Serverless runtime does not expose host metrics"}]
    return jsonify({"services": checks, "checkedAt": _now().isoformat()})


@admin_bp.get("/api/admin/logs")
@_require_admin("super_admin", "operations_admin", "auditor")
def admin_logs():
    db = get_auth_db()
    exam = get_exam_db()
    events = []
    if db is not None:
        events.extend({"type": "auth", **_json(event)} for event in db.auth_events.find({}, {"_id": 0}).sort("createdAt", -1).limit(50))
        events.extend({"type": "admin", **_json(event)} for event in db.admin_audit_events.find({}, {"_id": 0}).sort("createdAt", -1).limit(50))
    jobs = _jobs_collection()
    if jobs is not None:
        events.extend({"type": "execution", **_json(event)} for event in jobs.find({}, {"payload": 0, "result": 0}).sort("updatedAt", -1).limit(50))
    events.sort(key=lambda x: str(x.get("createdAt") or x.get("updatedAt") or ""), reverse=True)
    return jsonify({"events": events[:100], "meta": {"sourceStatus": "available" if events else "empty", "asOf": _now().isoformat()}})


@admin_bp.get("/api/admin/analytics")
@_require_admin()
def admin_analytics():
    auth = get_auth_db()
    rooms = _rooms_collection()
    jobs = _jobs_collection()
    meetings = get_exam_db()["meeting_rooms"] if get_exam_db() is not None else None
    submission_count = 0
    participant_count = 0
    flagged_participants = 0
    if rooms is not None:
        for room in rooms.find({}, {"participant:": 0}):
            for key, value in room.items():
                if str(key).startswith("participant:"):
                    participant_count += 1
                    try:
                        participant = json.loads(value) if isinstance(value, str) else (value or {})
                    except (TypeError, ValueError):
                        participant = {}
                    flagged_participants += int(participant.get("fullscreenExits", 0) or 0)
                    flagged_participants += int(participant.get("copyPasteAttempts", 0) or 0)
                elif str(key).startswith("submissions:"):
                    try:
                        submission_count += len(json.loads(value) if isinstance(value, str) else (value or {}))
                    except (TypeError, ValueError):
                        pass
    return jsonify({"data": {"users": auth.users.count_documents({}) if auth is not None else None,
                              "authEvents": auth.auth_events.count_documents({}) if auth is not None else None,
                              "exams": rooms.count_documents({}) if rooms is not None else None,
                              "meetings": meetings.count_documents({}) if meetings is not None else None,
                              "openMeetings": meetings.count_documents({"isOpen": True}) if meetings is not None else None,
                              "participants": participant_count,
                              "submissions": submission_count,
                              "proctoringFlags": flagged_participants,
                              "executionJobs": jobs.count_documents({}) if jobs is not None else None,
                              "completedExecutions": jobs.count_documents({"status": "completed"}) if jobs is not None else None,
                              "failedExecutions": jobs.count_documents({"status": "failed"}) if jobs is not None else None},
                    "meta": {"aggregation": "current persisted totals", "asOf": _now().isoformat(), "sourceStatus": "available"}})


@admin_bp.get("/api/admin/audit")
@_require_admin("super_admin", "operations_admin", "auditor")
def admin_audit():
    db = get_auth_db()
    rows = list(db.admin_audit_events.find({}, {"_id": 0}).sort("createdAt", -1).limit(_limit())) if db is not None else []
    return jsonify({"items": _json(rows), "meta": {"sourceStatus": "available" if db is not None else "unavailable"}})


@admin_bp.get("/api/admin/alerts")
@_require_admin("super_admin", "operations_admin", "auditor")
def admin_alerts():
    """Return only alerts derived from currently observed production state.

    This endpoint intentionally does not manufacture incidents. Long-lived
    alert history requires a metrics/incident store; current conditions are
    evaluated from the existing service checks and execution ledger.
    """
    alerts = []
    auth = get_auth_db()
    exam = get_exam_db()
    jobs = _jobs_collection()
    if auth is None or exam is None:
        alerts.append({"severity": "critical", "title": "Database telemetry unavailable", "service": "database", "status": "active", "detail": "One or more configured MongoDB databases could not be reached."})
    if not queue_enabled():
        alerts.append({"severity": "warning", "title": "Execution queue unavailable", "service": "execution-queue", "status": "active", "detail": "CLOUDAMQP_URL or queue enablement is not configured for this runtime."})
    if jobs is not None:
        failed = jobs.count_documents({"status": "failed"})
        queued = jobs.count_documents({"status": "queued"})
        if failed:
            alerts.append({"severity": "warning", "title": "Failed execution jobs present", "service": "execution", "status": "active", "detail": f"{failed} failed jobs are retained in the execution ledger."})
        if queued > int(os.getenv("ADMIN_QUEUE_BACKLOG_ALERT", "50")):
            alerts.append({"severity": "warning", "title": "Execution queue backlog elevated", "service": "execution", "status": "active", "detail": f"{queued} queued jobs exceed the configured alert threshold."})
    return jsonify({"alerts": alerts, "overall": "critical" if any(a["severity"] == "critical" for a in alerts) else ("degraded" if alerts else "healthy"), "meta": {"asOf": _now().isoformat(), "sourceStatus": "available"}})


@admin_bp.get("/api/admin/settings")
@_require_admin("super_admin", "operations_admin", "auditor")
def admin_settings():
    """Expose safe configuration state, never secret values."""
    return jsonify({"settings": {
        "environment": os.getenv("APP_ENV", "production"),
        "authRequired": os.getenv("AUTH_REQUIRED", "0").lower() in {"1", "true", "yes"},
        "queueEnabled": queue_enabled(),
        "brokerManagementConfigured": bool(os.getenv("CLOUDAMQP_MANAGEMENT_URL", "").strip()),
        "hostMetricsConfigured": bool(os.getenv("ADMIN_HOST_METRICS_URL", "").strip()),
        "adminRole": g.admin.get("role", "unknown"),
    }, "meta": {"asOf": _now().isoformat(), "sourceStatus": "available"}})
