import sys
from pathlib import Path
from flask import Blueprint, request, jsonify
from datetime import datetime

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from utils.analytics import analytics_tracker

analytics_bp = Blueprint("analytics_bp", __name__)

@analytics_bp.route("/api/analytics", methods=["GET"])
def api_analytics():
    """Return live analytics metrics."""
    client_id = request.args.get("client_id")
    stats = analytics_tracker.get_stats(client_id=client_id)
    return jsonify(stats)


@analytics_bp.route("/api/analytics/launch", methods=["POST"])
def api_analytics_launch():
    """Record an app launch / page visit."""
    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    result = analytics_tracker.record_app_launch(client_id=client_id)
    return jsonify(result)


@analytics_bp.route("/api/analytics/heartbeat", methods=["POST"])
def api_analytics_heartbeat():
    """Refresh active session heartbeat without returning full metrics."""
    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    if client_id:
        now_ts = int(datetime.now().timestamp())
        analytics_tracker._async_run([
            ["ZADD", "active_users", str(now_ts), client_id],
            ["ZREMRANGEBYSCORE", "active_users", "-inf", str(now_ts - 90)]
        ])
    return jsonify({"status": "ok"})
