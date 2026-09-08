import sys
from pathlib import Path
from flask import Blueprint, request, jsonify, g
from datetime import datetime

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from utils.analytics import analytics_tracker
from utils.logger import get_logger, bind_component
from services.shared.idempotency import get_idempotency_key_from_request, IdempotencyHandler, MemoryIdempotencyStore

log = bind_component(get_logger(__name__), "analytics_api")

analytics_bp = Blueprint("analytics_bp", __name__)

# Lightweight idempotency store for analytics mutation endpoints only.
# This is additive and does not change any existing request/response shape.
_idem_store = MemoryIdempotencyStore()
_idem_handler = IdempotencyHandler(_idem_store, default_ttl_seconds=600)


def _json_response(payload, status=200):
    """Emit a JSON response with correlation context already attached upstream."""
    return jsonify(payload), status


@analytics_bp.route("/api/analytics", methods=["GET"])
def api_analytics():
    """Return live analytics metrics."""
    client_id = request.args.get("client_id")
    log.info("analytics_get_stats", client_id=client_id, correlation_id=g.get("correlation_id"))
    stats = analytics_tracker.get_stats(client_id=client_id)
    return _json_response(stats)


@analytics_bp.route("/api/analytics/launch", methods=["POST"])
def api_analytics_launch():
    """Record an app launch / page visit."""
    idempotency_key = get_idempotency_key_from_request(request)
    replay = _idem_handler.check_replay(idempotency_key, method="POST", path=request.path)
    if replay is not None:
        status, body = replay
        return _json_response(body, status=status)

    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    log.info("analytics_launch_requested", client_id=client_id, correlation_id=g.get("correlation_id"))
    result = analytics_tracker.record_app_launch(client_id=client_id)
    _idem_handler.record_response(idempotency_key, method="POST", path=request.path, status_code=200, body=result)
    return _json_response(result)


@analytics_bp.route("/api/analytics/heartbeat", methods=["POST"])
def api_analytics_heartbeat():
    """Refresh active session heartbeat without returning full metrics."""
    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    log.debug("analytics_heartbeat", client_id=client_id, correlation_id=g.get("correlation_id"))
    if client_id:
        now_ts = int(datetime.now().timestamp())
        analytics_tracker._async_run([
            ["ZADD", "active_users", str(now_ts), client_id],
            ["ZREMRANGEBYSCORE", "active_users", "-inf", str(now_ts - 90)]
        ])
    return _json_response({"status": "ok"}, status=200)
