"""Persistent meeting-room lifecycle and presence management.

Media remains peer-to-peer through PeerJS. Room metadata and presence live in
the separate ``meeting_rooms`` collection so Vercel instances share state.
"""

import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from services.shared.redis_client import get_exam_db
from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "meeting_service")
_rooms_lock = threading.RLock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MeetingService:
    """MongoDB-backed meeting room and participant presence service."""

    _rooms: Dict[str, Dict[str, Any]] = {}
    _mongo_client = None
    _mongo_collection = None
    _mongo_lock = threading.Lock()

    @classmethod
    def _collection(cls):
        if cls._mongo_collection is not None:
            return cls._mongo_collection
        with cls._mongo_lock:
            if cls._mongo_collection is not None:
                return cls._mongo_collection
            try:
                # Meetings share the existing Atlas cluster/database used by
                # exams, but remain isolated in their own collection. The
                # shared accessor also contains the deployed fallback URI;
                # using a separate ad-hoc client here previously caused the
                # meeting service to silently fall back to process memory
                # whenever MONGO_URI was not injected into the environment.
                cls._mongo_client = get_exam_db()
                if cls._mongo_client is None:
                    return None
                cls._mongo_collection = cls._mongo_client["meeting_rooms"]
                cls._mongo_collection.create_index("activeAt")
                cls._mongo_collection.create_index("isOpen")
            except Exception as exc:
                log.warning("meeting_mongo_unavailable", error=str(exc))
                cls._mongo_collection = None
        return cls._mongo_collection

    @classmethod
    def _from_doc(cls, doc: Optional[dict]) -> Optional[dict]:
        if not doc:
            return None
        participants = doc.get("participants") or {}
        room = dict(doc)
        room.pop("_id", None)
        room["_activePeers"] = set(participants.keys())
        room["participantCount"] = len(participants)
        return room

    @classmethod
    def _load(cls, room_id: str) -> Optional[dict]:
        room_id = room_id.strip().upper()
        collection = cls._collection()
        if collection is not None:
            try:
                return cls._from_doc(collection.find_one({"_id": room_id}))
            except Exception as exc:
                log.warning("meeting_room_read_failed", room_id=room_id, error=str(exc))
        with _rooms_lock:
            room = cls._rooms.get(room_id)
            return dict(room) if room else None

    @classmethod
    def _save(cls, room: dict) -> None:
        room_id = room["roomId"]
        clean = {k: v for k, v in room.items() if k not in {"_activePeers", "participantCount"}}
        clean["_id"] = room_id
        collection = cls._collection()
        if collection is not None:
            try:
                collection.replace_one({"_id": room_id}, clean, upsert=True)
            except Exception as exc:
                log.warning("meeting_room_write_failed", room_id=room_id, error=str(exc))
        with _rooms_lock:
            cls._rooms[room_id] = dict(room)

    @classmethod
    def create_room(
        cls,
        host_name: str = "Anonymous",
        room_id: Optional[str] = None,
        host_token: str = "",
        room_title: str = "",
    ) -> Dict[str, Any]:
        room_id = (room_id or f"MTG-{uuid.uuid4().hex[:8].upper()}").strip().upper()
        if cls._load(room_id):
            raise ValueError(f"Meeting room '{room_id}' already exists")
        now = _now_iso()
        room_title = " ".join((room_title or "").split())[:120] or "Codexa Meeting"
        room = {
            "roomId": room_id,
            "roomTitle": room_title,
            "hostName": host_name,
            "hostToken": (host_token or "").strip(),
            "hostPeerId": "",
            "creatorPeerId": "",
            "creatorActive": False,
            "createdAt": now,
            "activeAt": now,
            "participants": {},
            "chatMessages": [],
            "reactions": [],
            "participantEvents": [],
            "participantCount": 0,
            "isOpen": True,
            "endedAt": "",
            "endedBy": "",
            "_activePeers": set(),
        }
        cls._save(room)
        log.info("meeting_room_created", room_id=room_id, host_name=host_name)
        return room

    @classmethod
    def get_room(cls, room_id: str) -> Optional[Dict[str, Any]]:
        return cls._load(room_id)

    @classmethod
    def get_active_peers(cls, room_id: str) -> list:
        room = cls._load(room_id)
        return list((room or {}).get("_activePeers", set()))

    @classmethod
    def join_room(cls, room_id: str, participant_name: str, peer_id: str, host_token: str = "") -> Dict[str, Any]:
        room_id = room_id.strip().upper()
        participant_name = " ".join((participant_name or "Anonymous").split()) or "Anonymous"
        peer_id = peer_id.strip()
        if not peer_id:
            raise ValueError("peerId is required")
        # Keep the read/check/write sequence together so two join requests
        # handled by the same server instance cannot claim the same display
        # name. Names are compared case-insensitively with collapsed spaces.
        with _rooms_lock:
            room = cls._load(room_id)
            if not room:
                raise KeyError(f"Meeting room '{room_id}' not found")
            if not room.get("isOpen", True):
                raise ValueError("Meeting ended by the host")
            participants = dict(room.get("participants") or {})
            name_key = participant_name.casefold()
            for existing_peer, existing in participants.items():
                if existing_peer == peer_id:
                    continue
                existing_name = " ".join(str((existing or {}).get("name") or "").split()).casefold()
                if existing_name and existing_name == name_key:
                    raise ValueError("A participant with that name is already in the meeting")
            host_token = (host_token or "").strip()
            is_creator = bool(host_token and room.get("hostToken") and host_token == room.get("hostToken"))
            creator_peer_id = room.get("creatorPeerId") or ""
            creator_is_present = bool(creator_peer_id and creator_peer_id in participants)
            if is_creator and creator_is_present and creator_peer_id != peer_id:
                raise PermissionError("The meeting creator is already in the meeting")
            if is_creator and not creator_is_present:
                room["creatorPeerId"] = peer_id
                room["creatorActive"] = True
                room["hostPeerId"] = peer_id
                room["hostName"] = participant_name
            elif not room.get("hostPeerId"):
                room["hostPeerId"] = peer_id
                if not room.get("hostToken"):
                    room["hostToken"] = ""
            existing = participants.get(peer_id) or {}
            participants[peer_id] = {
                "name": participant_name,
                "nameKey": name_key,
                "isCreator": is_creator or bool(existing.get("isCreator")),
                "joinedAt": existing.get("joinedAt") or _now_iso(),
                "joinOrder": existing.get("joinOrder") or time.time_ns(),
                "lastSeen": _now_iso(),
            }
            room["participants"] = participants
            room["activeAt"] = _now_iso()
            room["_activePeers"] = set(participants.keys())
            room["participantCount"] = len(participants)
            cls._save(room)
        return {
            "roomId": room_id,
            "participantName": participant_name,
            "participantCount": len(participants),
            "roomTitle": room.get("roomTitle", "Codexa Meeting"),
            "hostPeerId": room.get("hostPeerId", ""),
            "isHost": room.get("hostPeerId") == peer_id,
            "isOpen": True,
        }

    @classmethod
    def leave_room(cls, room_id: str, peer_id: str) -> Dict[str, Any]:
        with _rooms_lock:
            room = cls._load(room_id)
            if not room:
                return {"roomId": room_id, "destroyed": False, "reason": "not_found"}
            participants = dict(room.get("participants") or {})
            removed = peer_id in participants
            participants.pop(peer_id, None)
            if not removed:
                return {"roomId": room_id, "remainingParticipants": len(participants), "destroyed": False, "removed": False}

            # The room is disposable: once the final participant leaves, remove
            # it from both MongoDB and the local fallback cache. This prevents
            # stale meeting IDs from being joinable later.
            if not participants:
                cls._delete(room_id)
                log.info("meeting_room_destroyed_empty", room_id=room_id)
                return {"roomId": room_id, "remainingParticipants": 0, "destroyed": True, "removed": True}

            room["participants"] = participants
            room["activeAt"] = _now_iso()
            room["_activePeers"] = set(participants.keys())
            room["participantCount"] = len(participants)
            host_changed = False
            if room.get("creatorPeerId") == peer_id:
                room["creatorActive"] = False
            if room.get("hostPeerId") == peer_id:
                successor = min(
                    participants.items(),
                    key=lambda item: (
                        int((item[1] or {}).get("joinOrder") or 0),
                        str((item[1] or {}).get("joinedAt") or ""),
                        item[0],
                    ),
                )[0]
                room["hostPeerId"] = successor
                room["hostName"] = (participants.get(successor) or {}).get("name") or "Anonymous"
                host_changed = True
            cls._save(room)
        log.info("meeting_room_left", room_id=room_id, peer_removed=removed, remaining_count=len(participants), host_changed=host_changed)
        return {"roomId": room_id, "remainingParticipants": len(participants), "destroyed": False, "removed": True, "hostPeerId": room.get("hostPeerId", ""), "hostChanged": host_changed}

    @classmethod
    def remove_participant(cls, room_id: str, host_peer_id: str, target_peer_id: str) -> Dict[str, Any]:
        """Remove a guest after verifying the caller is the persisted host."""
        with _rooms_lock:
            room = cls._load(room_id)
            if not room:
                raise KeyError(f"Meeting room '{room_id}' not found")
            if room.get("hostPeerId") != host_peer_id:
                raise PermissionError("Only the meeting host can remove participants")
            if not target_peer_id or target_peer_id == host_peer_id:
                raise ValueError("The host cannot remove themselves")
            participants = dict(room.get("participants") or {})
            removed = participants.pop(target_peer_id, None)
            if removed is None:
                raise KeyError("Participant not found")
            room["participants"] = participants
            if room.get("creatorPeerId") == target_peer_id:
                room["creatorActive"] = False
            room["activeAt"] = _now_iso()
            room["_activePeers"] = set(participants.keys())
            room["participantCount"] = len(participants)
            cls._save(room)
        return {
            "roomId": room_id,
            "removedPeerId": target_peer_id,
            "remainingParticipants": len(participants),
            "hostPeerId": room.get("hostPeerId", ""),
        }

    @classmethod
    def record_event(cls, room_id: str, peer_id: str, event_type: str, payload: Optional[dict] = None) -> Dict[str, Any]:
        """Store bounded meeting activity inside the room document itself."""
        allowed = {"chat", "reaction", "participant"}
        if event_type not in allowed:
            raise ValueError("Unsupported meeting event")
        with _rooms_lock:
            room = cls._load(room_id)
            if not room:
                raise KeyError(f"Meeting room '{room_id}' not found")
            if peer_id not in (room.get("participants") or {}):
                raise PermissionError("Participant is not in this meeting")
            event = {"peerId": peer_id, "createdAt": _now_iso(), **(payload or {})}
            field = {"chat": "chatMessages", "reaction": "reactions", "participant": "participantEvents"}[event_type]
            items = list(room.get(field) or [])
            items.append(event)
            room[field] = items[-500:]
            room["activeAt"] = _now_iso()
            cls._save(room)
        return {"roomId": room_id.strip().upper(), "eventType": event_type}

    @classmethod
    def _delete(cls, room_id: str) -> None:
        collection = cls._collection()
        if collection is not None:
            try:
                collection.delete_one({"_id": room_id})
            except Exception as exc:
                log.warning("meeting_room_delete_failed", room_id=room_id, error=str(exc))
        with _rooms_lock:
            cls._rooms.pop(room_id, None)

    @classmethod
    def end_room(cls, room_id: str, peer_id: str) -> Dict[str, Any]:
        room = cls._load(room_id)
        if not room:
            raise KeyError(f"Meeting room '{room_id}' not found")
        if room.get("hostPeerId") != peer_id:
            raise PermissionError("Only the meeting host can end the meeting")
        ended_at = _now_iso()
        ended_by = room.get("hostName") or "the host"
        # Ending is terminal. Clients receive the end notification from the
        # caller, while the room is removed immediately so an ended ID cannot
        # be joined or retained indefinitely in MongoDB.
        cls._delete(room_id)
        log.info("meeting_room_ended", room_id=room_id, ended_by=peer_id)
        return {"roomId": room_id, "isOpen": False, "endedAt": ended_at, "endedBy": ended_by}

    @classmethod
    def cleanup_stale_rooms(cls, max_age_seconds: int = 7200) -> int:
        cutoff = datetime.now(timezone.utc).timestamp() - max_age_seconds
        purged = 0
        collection = cls._collection()
        if collection is not None:
            try:
                cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
                result = collection.delete_many({"activeAt": {"$lt": cutoff_iso}, "participants": {"$size": 0}})
                purged += result.deleted_count
            except Exception as exc:
                log.warning("meeting_cleanup_db_failed", error=str(exc))
        with _rooms_lock:
            stale = []
            for room_id, room in cls._rooms.items():
                try:
                    active_ts = datetime.fromisoformat(room.get("activeAt", "").replace("Z", "+00:00")).timestamp()
                except (TypeError, ValueError):
                    continue
                if active_ts < cutoff and not room.get("_activePeers"):
                    stale.append(room_id)
            for room_id in stale:
                cls._rooms.pop(room_id, None)
                purged += 1
        return purged

    @classmethod
    def room_status(cls, room_id: str, peer_id: str = "") -> Dict[str, Any]:
        room = cls._load(room_id)
        if not room:
            raise KeyError(f"Meeting room '{room_id}' not found")
        return {
            "roomId": room_id,
            "roomTitle": room.get("roomTitle", "Codexa Meeting"),
            "participantCount": len(room.get("_activePeers", set())),
            "isOpen": room.get("isOpen", True),
            "createdAt": room.get("createdAt", ""),
            "activeAt": room.get("activeAt", ""),
            "hostPeerId": room.get("hostPeerId", ""),
            "isHost": bool(peer_id and room.get("hostPeerId") == peer_id),
            "endedAt": room.get("endedAt", ""),
            "endedBy": room.get("endedBy", ""),
        }
