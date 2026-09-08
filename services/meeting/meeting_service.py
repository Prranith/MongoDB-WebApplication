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
    def create_room(cls, host_name: str = "Anonymous") -> Dict[str, Any]:
        """Create a new meeting room and return its metadata."""
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
        """Register a participant joining a room."""
        room = cls._rooms.get(room_id)
        if not room:
            raise KeyError(f"Room '{room_id}' not found")
        if not room.get("isOpen", True):
            raise ValueError(f"Room '{room_id}' is closed")

        # Track host peer ID on first join
        if not room.get("hostPeerId"):
            room["hostPeerId"] = peer_id

        count = cls._participant_counts.get(room_id, 0) + 1
        cls._participant_counts[room_id] = count
        room["participantCount"] = count
        room["activeAt"] = _now_iso()

        log.info(
            "meeting_room_joined",
            room_id=room_id,
            participant_name=participant_name,
            participant_count=count,
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
        Decrement participant count on leave.
        If count reaches 0, destroy the room record entirely.
        """
        room = cls._rooms.get(room_id)
        if not room:
            return {"roomId": room_id, "destroyed": False, "reason": "not_found"}

        count = cls._participant_counts.get(room_id, 0)
        new_count = max(0, count - 1)
        cls._participant_counts[room_id] = new_count
        room["participantCount"] = new_count
        room["activeAt"] = _now_iso()

        log.info(
            "meeting_room_left",
            room_id=room_id,
            remaining_count=new_count,
        )

        destroyed = False
        if new_count <= 0:
            destroyed = cls.destroy_room(room_id)

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
