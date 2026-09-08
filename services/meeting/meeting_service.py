"""
services/meeting/meeting_service.py
Room management for real-time video collaboration.
Lightweight room lifecycle: create, join, leave, auto-cleanup.
"""

import uuid
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "meeting_service")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MeetingService:
    """
    In-memory room store with automatic cleanup.

    NOTE: This is intentionally lightweight and uses an in-memory dict.
    Swap the store methods for MongoDB/Redis if persistence is needed.
    """

    # Class-level store so all instances share state in a single process
    _rooms: Dict[str, Dict[str, Any]] = {}
    _participant_counts: Dict[str, int] = {}

    @classmethod
    def create_room(cls, host_name: str = "Anonymous", room_id: Optional[str] = None) -> Dict[str, Any]:
        """Create a new meeting room and return its metadata."""
        if not room_id:
            room_id = f"MTG-{uuid.uuid4().hex[:8].upper()}"
        now = _now_iso()
        room = {
            "roomId": room_id,
            "hostName": host_name,
            "hostPeerId": "",  # set on join
            "createdAt": now,
            "activeAt": now,
            "participantCount": 0,
            "isOpen": True,
            "_activePeers": set(),
        }
        cls._rooms[room_id] = room
        cls._participant_counts[room_id] = 0
        log.info("meeting_room_created", room_id=room_id, host_name=host_name)
        return room

    @classmethod
    def get_room(cls, room_id: str) -> Optional[Dict[str, Any]]:
        """Fetch room metadata by ID."""
        return cls._rooms.get(room_id)

    @classmethod
    def join_room(
        cls,
        room_id: str,
        participant_name: str,
        peer_id: str,
    ) -> Dict[str, Any]:
        """Register a participant joining a room. Auto-creates room if not found."""
        room = cls._rooms.get(room_id)
        if not room:
            # Auto-create room on the fly so custom or generated room IDs always work seamlessly!
            now = _now_iso()
            room = {
                "roomId": room_id,
                "hostName": participant_name,
                "hostPeerId": peer_id if peer_id else "",
                "createdAt": now,
                "activeAt": now,
                "participantCount": 0,
                "isOpen": True,
            }
            cls._rooms[room_id] = room
            cls._participant_counts[room_id] = 0
            log.info("meeting_room_auto_created", room_id=room_id, host_name=participant_name)

        if not room.get("isOpen", True):
            raise ValueError(f"Room '{room_id}' is closed")

        # Track host peer ID on first join with a real peer_id
        if peer_id and not room.get("hostPeerId"):
            room["hostPeerId"] = peer_id

        # Idempotent join: only count the peer once per room. The frontend
        # re-calls /join on a 15s heartbeat and on reconnect; counting each
        # as a new participant would inflate the count and make leave cleanup
        # leave stale rooms behind.
        active_peers = room.get("_activePeers", set())
        is_new = peer_id and peer_id not in active_peers
        if is_new:
            active_peers.add(peer_id)
            room["_activePeers"] = active_peers

        count = len(active_peers)
        cls._participant_counts[room_id] = count
        room["participantCount"] = count
        room["activeAt"] = _now_iso()

        log.info(
            "meeting_room_joined",
            room_id=room_id,
            participant_name=participant_name,
            participant_count=count,
            is_new_participant=is_new,
        )
        return {
            "roomId": room_id,
            "participantName": participant_name,
            "participantCount": count,
            "hostPeerId": room.get("hostPeerId", ""),
        }

    @classmethod
    def leave_room(cls, room_id: str, peer_id: str) -> Dict[str, Any]:
        """
        Remove the peer from the room's active set and auto-destroy the room
        record if no peers remain. Uses the same _activePeers set that
        join_room maintains so leave is idempotent and count stays accurate.
        """
        room = cls._rooms.get(room_id)
        if not room:
            return {"roomId": room_id, "destroyed": False, "reason": "not_found"}

        active_peers = room.get("_activePeers", set())
        removed = False
        if peer_id and peer_id in active_peers:
            active_peers.discard(peer_id)
            room["_activePeers"] = active_peers
            removed = True

        new_count = len(active_peers)
        cls._participant_counts[room_id] = new_count
        room["participantCount"] = new_count
        room["activeAt"] = _now_iso()

        destroyed = False
        if new_count <= 0:
            destroyed = cls.destroy_room(room_id)

        log.info(
            "meeting_room_left",
            room_id=room_id,
            remaining_count=new_count,
            peer_removed=removed,
        )

        return {
            "roomId": room_id,
            "remainingParticipants": new_count,
            "destroyed": destroyed,
        }

    @classmethod
    def destroy_room(cls, room_id: str) -> bool:
        """Hard-delete a room and all transient meeting data."""
        existed = room_id in cls._rooms
        cls._rooms.pop(room_id, None)
        cls._participant_counts.pop(room_id, None)
        if existed:
            log.info("meeting_room_destroyed", room_id=room_id)
        return existed

    @classmethod
    def cleanup_stale_rooms(cls, max_age_seconds: int = 7200) -> int:
        """
        Garbage-collect orphaned rooms older than `max_age_seconds`.
        Returns count of purged rooms.
        """
        now_ts = time.time()
        cutoff = now_ts - max_age_seconds
        purged = 0
        stale_ids = []

        for room_id, room in list(cls._rooms.items()):
            created_str = room.get("createdAt", "")
            try:
                created_dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                created_ts = created_dt.timestamp()
            except (ValueError, TypeError):
                # If we can't parse, keep the room — be conservative.
                continue

            if created_ts < cutoff and room.get("participantCount", 0) == 0:
                stale_ids.append(room_id)

        for room_id in stale_ids:
            cls.destroy_room(room_id)
            purged += 1

        if purged:
            log.info("meeting_stale_cleanup", purged=purged)
        return purged

    @classmethod
    def room_status(cls, room_id: str) -> Dict[str, Any]:
        """Lightweight status payload for a room."""
        room = cls._rooms.get(room_id)
        if not room:
            raise KeyError(f"Room '{room_id}' not found")
        return {
            "roomId": room_id,
            "participantCount": room.get("participantCount", 0),
            "isOpen": room.get("isOpen", True),
            "createdAt": room.get("createdAt", ""),
            "activeAt": room.get("activeAt", ""),
            "hostPeerId": room.get("hostPeerId", ""),
        }
