"""
api/routes/meeting_routes.py
Meeting room REST API — decoupled from media.
Handles room lifecycle only; all media is P2P via PeerJS.
"""

import sys
from pathlib import Path
from flask import Blueprint, request, jsonify, g

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.meeting.meeting_service import MeetingService
from utils.logger import get_logger, bind_component

meeting_bp = Blueprint("meeting_bp", __name__)
log = bind_component(get_logger(__name__), "meeting_api")


def _json_response(payload, status=200):
    return jsonify(payload), status


@meeting_bp.route("/api/meeting/create", methods=["POST"])
def api_meeting_create():
    """Create a new meeting room."""
    log.info("meeting_create_requested", correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    host_name = (body.get("hostName") or "Anonymous").strip() or "Anonymous"
    room_id = (body.get("roomId") or "").strip().upper()

    try:
        room = MeetingService.create_room(host_name=host_name, room_id=room_id if room_id else None)
        return _json_response({
            "status": "ok",
            "roomId": room["roomId"],
            "hostName": room["hostName"],
            "createdAt": room["createdAt"],
        })
    except Exception as e:
        log.error("meeting_create_failed", error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=503)


@meeting_bp.route("/api/meeting/join", methods=["POST"])
def api_meeting_join():
    """Join an existing meeting room."""
    log.info("meeting_join_requested", correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    room_id = (body.get("roomId") or "").strip().upper()
    participant_name = (body.get("participantName") or "Anonymous").strip() or "Anonymous"
    peer_id = (body.get("peerId") or "").strip()

    if not room_id:
        return _json_response({"status": "error", "error": "roomId is required"}, status=400)

    try:
        res = MeetingService.join_room(room_id, participant_name, peer_id)
        return _json_response({
            "status": "ok",
            **res,
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except ValueError as e:
        return _json_response({"status": "error", "error": str(e)}, status=400)
    except Exception as e:
        log.error("meeting_join_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@meeting_bp.route("/api/meeting/leave", methods=["POST"])
def api_meeting_leave():
    """
    Decrement participant count and auto-destroy the room if empty.
    Clients should call this on 'End Meeting' and beforeunload.
    """
    log.info("meeting_leave_requested", correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    room_id = (body.get("roomId") or "").strip().upper()
    peer_id = (body.get("peerId") or "").strip()

    if not room_id:
        return _json_response({"status": "error", "error": "roomId is required"}, status=400)

    try:
        res = MeetingService.leave_room(room_id, peer_id or "unknown")
        status_code = 200
        if res.get("destroyed"):
            status_code = 200  # still OK — room was intentionally torn down
        return _json_response({
            "status": "ok",
            **res,
        }, status=status_code)
    except Exception as e:
        log.error("meeting_leave_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@meeting_bp.route("/api/meeting/status/<room_id>", methods=["GET"])
def api_meeting_status(room_id):
    """Fetch lightweight room status metadata."""
    room_id = room_id.strip().upper()
    log.debug("meeting_status_requested", room_id=room_id, correlation_id=g.get("correlation_id"))
    try:
        status = MeetingService.room_status(room_id)
        return _json_response({
            "status": "ok",
            **status,
        })
    except KeyError as e:
        return _json_response({"status": "error", "error": str(e)}, status=404)
    except Exception as e:
        log.error("meeting_status_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@meeting_bp.route("/api/meeting/cleanup", methods=["POST"])
def api_meeting_cleanup():
    """
    Trigger stale-room garbage collection.
    Purges rooms older than 2 hours with 0 participants.
    """
    log.info("meeting_cleanup_requested", correlation_id=g.get("correlation_id"))
    body = request.get_json(force=True, silent=True) or {}
    max_age = int(body.get("maxAgeSeconds", 7200))
    try:
        purged = MeetingService.cleanup_stale_rooms(max_age_seconds=max_age)
        return _json_response({
            "status": "ok",
            "purged": purged,
        })
    except Exception as e:
        log.error("meeting_cleanup_failed", error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)


@meeting_bp.route("/api/meeting/peers", methods=["GET"])
def api_meeting_peers():
    """Return all active peer IDs in a room for mesh connectivity."""
    room_id = (request.args.get("roomId") or "").strip().upper()
    caller_peer_id = (request.args.get("peerId") or "").strip()

    if not room_id:
        return _json_response({"status": "error", "error": "roomId is required"}, status=400)

    try:
        room = MeetingService.get_room(room_id)
        if not room:
            return _json_response({"status": "error", "error": "Room not found"}, status=404)

        active_peers = list(room.get("_activePeers", set()))
        # Exclude the caller from the list so they don't try to connect to themselves
        if caller_peer_id and caller_peer_id in active_peers:
            active_peers.remove(caller_peer_id)

        return _json_response({
            "status": "ok",
            "roomId": room_id,
            "peerIds": active_peers,
            "count": len(active_peers),
        })
    except Exception as e:
        log.error("meeting_peers_failed", room_id=room_id, error=str(e), correlation_id=g.get("correlation_id"))
        return _json_response({"status": "error", "error": str(e)}, status=500)

