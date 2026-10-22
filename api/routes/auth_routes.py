from flask import Blueprint, jsonify, request

from services.auth.auth_service import (
    AUTH_REQUIRED, create_password_user, create_session,
    current_user, logout, password_login, issue_email_otp, verify_email_otp, _db,
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
        user = create_password_user(body.get("name"), body.get("email"), body.get("password"))
        if not user.get("emailVerified", False):
            issue_email_otp(user)
            return jsonify({"authenticated": False, "verificationRequired": True, "email": user["email"]}), 201
        return jsonify({"authenticated": True, "user": create_session(user)}), 201
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


@auth_bp.post("/api/auth/verify-email")
def auth_verify_email():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("verify", body.get("email"))
    if limited:
        return limited
    try:
        user = verify_email_otp(body.get("email"), body.get("code"))
        return jsonify({"authenticated": True, "user": create_session(user)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@auth_bp.post("/api/auth/resend-verification")
def auth_resend_verification():
    body = request.get_json(silent=True) or {}
    limited = _rate_limit("resend", body.get("email"))
    if limited:
        return limited
    db_user = _db().users.find_one({"email": str(body.get("email", "")).strip().lower()})
    if not db_user:
        return jsonify({"error": "Unable to send verification code."}), 400
    try:
        issue_email_otp(db_user)
        return jsonify({"sent": True})
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


