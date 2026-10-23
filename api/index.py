"""
api/index.py
Flask-based Vercel serverless API bootstrap.
Zero PySide6 dependency. Registers modular blueprints.
"""

import os
import secrets
import sys
from pathlib import Path

# Add project root so all core/ and utils/ imports work
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from flask import Flask, request, g, jsonify, session
from flask_cors import CORS

from utils.logger import setup_logging, get_logger, set_correlation_id

# Initialize logging early; enable JSON logs in production-like environments
_setup_json_logs = False
try:
    _setup_json_logs = bool(sys.getenv("JSON_LOGS", "0").strip() in ("1", "true", "True"))
except Exception:
    _setup_json_logs = False

setup_logging(level="INFO", json_logs=_setup_json_logs)

log = get_logger(__name__)

# Initialize Flask app
app = Flask(__name__)
_is_production = bool(os.getenv("VERCEL")) or os.getenv("APP_ENV", "").strip().lower() == "production"
_cookie_secure = os.getenv("COOKIE_SECURE", "1" if _is_production else "0").strip().lower() not in {"0", "false", "no"}
app.config.update(
    SECRET_KEY=os.getenv("AUTH_SECRET_KEY", "").strip() or secrets.token_hex(32),
    SESSION_COOKIE_NAME="codeleaf_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=_cookie_secure,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_PATH="/",
    SESSION_COOKIE_DOMAIN=None,
    SESSION_COOKIE_MAX_AGE=int(os.getenv("AUTH_SESSION_TTL_DAYS", "14")) * 24 * 60 * 60,
    SESSION_REFRESH_EACH_REQUEST=True,
    PERMANENT_SESSION_LIFETIME=__import__("datetime").timedelta(days=int(os.getenv("AUTH_SESSION_TTL_DAYS", "14"))),
)
_cors_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "").split(",") if origin.strip()]
if _cors_origins:
    CORS(app, supports_credentials=True, origins=_cors_origins)
else:
    CORS(app, supports_credentials=True)

# Import blueprints from the modular routes folder
from api.routes.static_routes import static_bp
from api.routes.database_routes import database_bp
from api.routes.file_routes import file_bp
from api.routes.analytics_routes import analytics_bp
from api.routes.exam_routes import exam_bp
from api.routes.meeting_routes import meeting_bp
from api.routes.sql_routes import sql_bp
from api.routes.ai_routes import ai_bp
from api.routes.auth_routes import auth_bp
from api.routes.admin_routes import admin_bp

# Register blueprints to keep code structure modular and maintainable
app.register_blueprint(static_bp)
app.register_blueprint(database_bp)
app.register_blueprint(file_bp)
app.register_blueprint(analytics_bp)
app.register_blueprint(exam_bp)
app.register_blueprint(meeting_bp)
app.register_blueprint(sql_bp)
app.register_blueprint(ai_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)


@app.before_request
def _before_request():
    """Inject a correlation id into the request context for observability."""
    correlation_id = request.headers.get("X-Correlation-ID")
    request_id = request.headers.get("X-Request-ID")
    set_correlation_id(correlation_id, request_id=request_id)
    g.correlation_id = correlation_id or set_correlation_id()

    # Authentication is opt-in until provider credentials and AUTH_REQUIRED=1
    # are configured in the deployment environment. Analytics and auth routes
    # remain public so the home screen and sign-in flow can load.
    from services.auth.auth_service import AUTH_REQUIRED, current_user
    g.user = current_user()
    if AUTH_REQUIRED and request.path.startswith("/api/"):
        # The administrator login is a separate public entry point. Every
        # other admin API remains protected by its own server-side session
        # decorator in admin_routes.py.
        # Admin APIs authenticate through the separate administrator session
        # enforced by admin_routes._require_admin. Do not let the ordinary
        # student session guard reject those requests before that decorator
        # gets a chance to validate the admin identity.
        public = request.path.startswith("/api/auth/") or request.path.startswith("/api/admin/") or request.path.startswith("/api/analytics")
        is_admin_api = request.path.startswith("/api/admin/")
        # Admin APIs have their own independent session and role guard. Do
        # not let the ordinary student session gate intercept them first.
        if not public and not is_admin_api and not g.user:
            return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401


@app.after_request
def _after_request(response):
    """Propagate correlation ids and log completed requests in structured form."""
    if g.get("correlation_id"):
        response.headers["X-Correlation-ID"] = g.correlation_id
    log.info(
        "request_completed",
        method=request.method,
        path=request.path,
        status=response.status_code,
        correlation_id=g.get("correlation_id"),
    )
    return response


# Vercel calls this 'app' variable via handler
handler = app
