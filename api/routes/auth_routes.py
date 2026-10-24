from flask import Blueprint, jsonify, request

from services.auth.auth_service import (
    AUTH_REQUIRED, create_session, create_pending_signup,
    current_user, logout, password_login, verify_pending_signup, delete_account,
    resend_pending_signup_otp, update_profile, change_password,
    request_password_reset, reset_password, _safe_user, college_options,
)
from services.shared.rate_limit import make_rate_limiter
from services.shared.idempotency import (
    get_idempotency_key_from_request, get_persistent_idempotency_handler,
    serialize_idempotency_body,
)

auth_bp = Blueprint("auth_bp", __name__)
_auth_limiter = make_rate_limiter()
_auth_idem = get_persistent_idempotency_handler(ttl_seconds=900)


def _replay_auth():
    key = get_idempotency_key_from_request(request)
    replay = _auth_idem.check_replay(key, method=request.method, path=request.path)
    return (jsonify(replay[1]), replay[0]) if replay else None


def _record_auth(payload, status=200):
    _auth_idem.record_response(
        get_idempotency_key_from_request(request), method=request.method,
        path=request.path, status_code=status, body=serialize_idempotency_body(payload),
    )


def _rate_limit(action, email=""):
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    key = f"auth:{action}:{ip}:{str(email or '').strip().lower()[:180]}"
    allowed, _, retry_after = _auth_limiter.check(key, max_requests=8, window_seconds=60)
    if allowed:
        return None
    response = jsonify({"error": "Too many authentication attempts. Try again shortly.", "code": "AUTH_RATE_LIMITED"})
    response.status_code = 429
    response.headers["Retry-After"] = str(retry_after)
    return response


@auth_bp.get("/api/auth/me")
def auth_me():
    user = current_user()
    response = jsonify({"authenticated": bool(user), "required": AUTH_REQUIRED, "user": user})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@auth_bp.get("/api/auth/colleges")
def auth_colleges():
    return jsonify({"colleges": college_options(), "otherValue": "__other__"})


@auth_bp.post("/api/auth/register")
def auth_register():
    replay = _replay_auth()
    if replay:
        return replay
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("register", body.get("email"))
    if limited:
        return limited
    try:
        pending = create_pending_signup(body.get("name"), body.get("email"), body.get("password"), body.get("college"))
        payload = {"authenticated": False, "verificationRequired": True, "email": pending["email"]}
        _record_auth(payload, 201)
        return jsonify(payload), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.post("/api/auth/login")
def auth_login():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("login", body.get("email"))
    if limited:
        return limited
    try:
        user = password_login(body.get("email"), body.get("password"))
        return jsonify({"authenticated": True, "user": create_session(user)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.post("/api/auth/logout")
def auth_logout():
    logout()
    return jsonify({"authenticated": False})


@auth_bp.delete("/api/auth/account")
def auth_delete_account():
    user = current_user()
    if not user:
        return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
    try:
        from bson import ObjectId
        delete_account(ObjectId(user["id"]))
        return jsonify({"deleted": True, "authenticated": False})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.post("/api/auth/forgot-password")
def auth_forgot_password():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("forgot-password", body.get("email"))
    if limited:
        return limited
    try:
        request_password_reset(body.get("email"))
        return jsonify({"sent": True, "message": "If an account exists for that email, a reset link has been sent."})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.post("/api/auth/reset-password")
def auth_reset_password():
    body = request.get_json(silent=True) or {}
    try:
        reset_password(body.get("token"), body.get("newPassword"))
        return jsonify({"reset": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.route("/api/auth/profile", methods=["GET", "PUT"])
def auth_profile():
    user = current_user()
    if not user:
        return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
    if request.method == "GET":
        return jsonify({"user": user})
    try:
        from bson import ObjectId
        update_profile(ObjectId(user["id"]), request.get_json(silent=True) or {})
        return jsonify({"user": current_user()})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.get("/api/auth/search")
def auth_search():
    user = current_user()
    if not user:
        return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
    from services.shared.redis_client import get_auth_db
    query = str(request.args.get("q") or "").strip()[:80]
    if len(query) < 1:
        return jsonify({"users": []})
    db = get_auth_db()
    if db is None:
        return jsonify({"error": "Authentication database is not configured."}), 503
    import re
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    docs = db.users.find({"status": "active", "$or": [{"name": pattern}, {"college": pattern}, {"bio": pattern}]}).limit(25)
    # Search is a public-profile feature: never return account email, phone,
    # provider identities, or verification/session metadata to other users.
    def public_profile(doc):
        if not doc:
            return None
        return {
            "id": str(doc.get("_id", "")),
            "name": doc.get("name") or doc.get("email", "").split("@")[0],
            "avatar": doc.get("avatar", ""),
            "college": doc.get("college", ""),
            "bio": doc.get("bio", ""),
            "links": doc.get("links", []),
        }
    return jsonify({"users": [current for current in (public_profile(doc) for doc in docs) if current]})


@auth_bp.get("/api/auth/profile/<user_id>")
def auth_public_profile(user_id):
    """Return a read-only member profile without password/session secrets."""
    if not current_user():
        return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
    from bson import ObjectId
    from bson.errors import InvalidId
    from services.shared.redis_client import get_auth_db
    try:
        object_id = ObjectId(user_id)
    except (InvalidId, TypeError):
        return jsonify({"error": "Profile not found"}), 404
    db = get_auth_db()
    doc = db.users.find_one({"_id": object_id, "status": "active"}) if db is not None else None
    if not doc:
        return jsonify({"error": "Profile not found"}), 404
    return jsonify({"profile": {
        "id": str(doc.get("_id", "")),
        "name": doc.get("name") or doc.get("email", "").split("@")[0],
        "email": doc.get("email", ""),
        "avatar": doc.get("avatar", ""),
        "college": doc.get("college", ""),
        "bio": doc.get("bio", ""),
        "links": doc.get("links", []),
        "emailVerified": bool(doc.get("emailVerified", False)),
        "createdAt": doc.get("createdAt").isoformat() if hasattr(doc.get("createdAt"), "isoformat") else doc.get("createdAt"),
    }})


@auth_bp.post("/api/auth/change-password")
def auth_change_password():
    user = current_user()
    if not user:
        return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
    body = request.get_json(silent=True) or {}
    try:
        from bson import ObjectId
        change_password(ObjectId(user["id"]), body.get("currentPassword"), body.get("newPassword"))
        return jsonify({"changed": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@auth_bp.post("/api/auth/verify-email")
def auth_verify_email():
    replay = _replay_auth()
    if replay:
        return replay
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("verify", body.get("email"))
    if limited:
        return limited
    try:
        user = verify_pending_signup(body.get("email"), body.get("code"))
        payload = {"authenticated": True, "user": create_session(user)}
        _record_auth(payload)
        return jsonify(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@auth_bp.post("/api/auth/resend-verification")
def auth_resend_verification():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("resend", body.get("email"))
    if limited:
        return limited
    try:
        resend_pending_signup_otp(body.get("email"))
        return jsonify({"sent": True})
    except (RuntimeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 503 if isinstance(exc, RuntimeError) else 400


