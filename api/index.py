"""
api/index.py
Flask-based Vercel serverless API bootstrap.
Zero PySide6 dependency. Registers modular blueprints.
"""

import sys
from pathlib import Path

# Add project root so all core/ and utils/ imports work
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from flask import Flask, request, g, jsonify
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
CORS(app)

# Import blueprints from the modular routes folder
from api.routes.static_routes import static_bp
from api.routes.database_routes import database_bp
from api.routes.file_routes import file_bp
from api.routes.analytics_routes import analytics_bp
from api.routes.exam_routes import exam_bp

# Register blueprints to keep code structure modular and maintainable
app.register_blueprint(static_bp)
app.register_blueprint(database_bp)
app.register_blueprint(file_bp)
app.register_blueprint(analytics_bp)
app.register_blueprint(exam_bp)


@app.before_request
def _before_request():
    """Inject a correlation id into the request context for observability."""
    correlation_id = request.headers.get("X-Correlation-ID")
    request_id = request.headers.get("X-Request-ID")
    set_correlation_id(correlation_id, request_id=request_id)
    g.correlation_id = correlation_id or set_correlation_id()


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
