from flask import Blueprint, jsonify, request

from services.auth.auth_service import (
    AUTH_REQUIRED, create_password_user, create_session,
    current_user, logout, password_login,
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


