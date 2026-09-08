"""
api/routes/meeting_routes.py
REST endpoints for meeting room lifecycle management.
"""

import sys
from pathlib import Path
from flask import Blueprint, request, jsonify

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.meeting.meeting_service import meeting_service
from utils.logger import get_logger

log = get_logger(__name__)

meeting_bp = Blueprint("meeting_bp", __name__)


@meeting_bp.route("/api/meeting/create", methods=["POST"])
def create_meeting():
    """
    Create a new meeting room.
    Body: { "room_id": "optional_custom_id", "host_peer_id": "optional_peer_id" }
    Returns: room data with room_id, active_participants, etc.
    """
    try:
        data = request.get_json(silent=True) or {}
        room_id = data.get("room_id")
        host_peer_id = data.get("host_peer_id")
        
        room = meeting_service.create_room(room_id=room_id, host_peer_id=host_peer_id)
        
        return jsonify({
            "success": True,
            "room": {
                "room_id": room["room_id"],
                "host_peer_id": room.get("host_peer_id"),
                "active_participants": room["active_participants"],
                "created_at": room["created_at"].isoformat() if room.get("created_at") else None,
            }
        }), 201
        
    except Exception as e:
        log.error("meeting_create_failed", error=str(e))
        return jsonify({"success": False, "error": "Failed to create room"}), 500


@meeting_bp.route("/api/meeting/join", methods=["POST"])
def join_meeting():
    """
    Join an existing meeting room.
    Body: { "room_id": "DEV-XXXXXX" }
    Returns: room data if found, error if not.
    """
    try:
        data = request.get_json(silent=True) or {}
        room_id = data.get("room_id", "").strip().upper()
        
        if not room_id:
            return jsonify({"success": False, "error": "room_id is required"}), 400
        
        room = meeting_service.join_room(room_id)
        
        if not room:
            return jsonify({"success": False, "error": f"Room '{room_id}' not found or inactive"}), 404
        
        return jsonify({
            "success": True,
            "room": {
                "room_id": room["room_id"],
                "active_participants": room["active_participants"],
            }
        }), 200
        
    except Exception as e:
        log.error("meeting_join_failed", error=str(e), room_id=data.get("room_id"))
        return jsonify({"success": False, "error": "Failed to join room"}), 500


@meeting_bp.route("/api/meeting/leave", methods=["POST"])
def leave_meeting():
    """
    Leave a meeting room (decrement count, delete if empty).
    Body: { "room_id": "DEV-XXXXXX" }
    Returns: status of cleanup action.
    """
    try:
        data = request.get_json(silent=True) or {}
        room_id = data.get("room_id", "").strip().upper()
        
        if not room_id:
            return jsonify({"success": False, "error": "room_id is required"}), 400
        
        result = meeting_service.leave_room(room_id)
        
        return jsonify({
            "success": True,
            "status": result["status"],
            "room_id": result["room_id"],
            "active_participants": result.get("active_participants"),
        }), 200
        
    except Exception as e:
        log.error("meeting_leave_failed", error=str(e), room_id=data.get("room_id"))
        return jsonify({"success": False, "error": "Failed to leave room"}), 500


@meeting_bp.route("/api/meeting/status/<room_id>", methods=["GET"])
def meeting_status(room_id: str):
    """
    Get active room metadata.
    Returns: room data or 404 if not found.
    """
    try:
        room_id = room_id.strip().upper()
        room = meeting_service.get_room_status(room_id)
        
        if not room:
            return jsonify({"success": False, "error": "Room not found"}), 404
        
        return jsonify({
            "success": True,
            "room": {
                "room_id": room["room_id"],
                "active_participants": room["active_participants"],
                "host_peer_id": room.get("host_peer_id"),
                "created_at": room.get("created_at"),
            }
        }), 200
        
    except Exception as e:
        log.error("meeting_status_failed", error=str(e), room_id=room_id)
        return jsonify({"success": False, "error": "Failed to fetch room status"}), 500


@meeting_bp.route("/api/meeting/cleanup", methods=["POST"])
def cleanup_orphaned():
    """
    Admin endpoint to purge orphaned rooms older than 2 hours.
    Returns: count of deleted rooms.
    """
    try:
        deleted = meeting_service.cleanup_orphaned_rooms()
        return jsonify({"success": True, "deleted_count": deleted}), 200
    except Exception as e:
        log.error("meeting_cleanup_failed", error=str(e))
        return jsonify({"success": False, "error": "Cleanup failed"}), 500
