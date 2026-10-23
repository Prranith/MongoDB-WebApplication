from flask import Blueprint, jsonify, request

from services.auth.auth_service import (
    AUTH_REQUIRED, create_session, create_pending_signup,
    current_user, logout, password_login, verify_pending_signup,
    resend_pending_signup_otp, update_profile,
)
from services.shared.rate_limit import make_rate_limiter

auth_bp = Blueprint("auth_bp", __name__)
_auth_limiter = make_rate_limiter()


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
    return jsonify({"authenticated": bool(current_user()), "required": AUTH_REQUIRED, "user": current_user()})


@auth_bp.post("/api/auth/register")
def auth_register():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("register", body.get("email"))
    if limited:
        return limited
    try:
        pending = create_pending_signup(body.get("name"), body.get("email"), body.get("password"))
        return jsonify({"authenticated": False, "verificationRequired": True, "email": pending["email"]}), 201
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


@auth_bp.post("/api/auth/verify-email")
def auth_verify_email():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("verify", body.get("email"))
    if limited:
        return limited
    try:
        user = verify_pending_signup(body.get("email"), body.get("code"))
        return jsonify({"authenticated": True, "user": create_session(user)})
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


