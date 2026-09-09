"""Persistent meeting-room lifecycle and presence management.

Media remains peer-to-peer through PeerJS. Room metadata and presence live in
the separate ``meeting_rooms`` collection so Vercel instances share state.
"""

import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import pymongo

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
        uri = os.getenv("MONGO_URI", "").strip()
        if not uri:
            return None
        with cls._mongo_lock:
            if cls._mongo_collection is not None:
                return cls._mongo_collection
            try:
                cls._mongo_client = pymongo.MongoClient(
                    uri,
                    serverSelectionTimeoutMS=3500,
                    connectTimeoutMS=3500,
                    socketTimeoutMS=7000,
                    maxPoolSize=30,
                    retryWrites=True,
                    w="majority",
                )
                cls._mongo_collection = cls._mongo_client["meeting_system"]["meeting_rooms"]
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
    def create_room(cls, host_name: str = "Anonymous", room_id: Optional[str] = None) -> Dict[str, Any]:
        room_id = (room_id or f"MTG-{uuid.uuid4().hex[:8].upper()}").strip().upper()
        if cls._load(room_id):
            raise ValueError(f"Meeting room '{room_id}' already exists")
        now = _now_iso()
        room = {
            "roomId": room_id,
            "hostName": host_name,
            "hostPeerId": "",
            "createdAt": now,
            "activeAt": now,
            "participants": {},
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
    def join_room(cls, room_id: str, participant_name: str, peer_id: str) -> Dict[str, Any]:
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
            if not room.get("hostPeerId"):
                room["hostPeerId"] = peer_id
            participants[peer_id] = {
                "name": participant_name,
                "nameKey": name_key,
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
            "hostPeerId": room.get("hostPeerId", ""),
            "isHost": room.get("hostPeerId") == peer_id,
            "isOpen": True,
        }

    @classmethod
    def leave_room(cls, room_id: str, peer_id: str) -> Dict[str, Any]:
        room = cls._load(room_id)
        if not room:
            return {"roomId": room_id, "destroyed": False, "reason": "not_found"}
        participants = dict(room.get("participants") or {})
        removed = peer_id in participants
        participants.pop(peer_id, None)
        room["participants"] = participants
        room["activeAt"] = _now_iso()
        room["_activePeers"] = set(participants.keys())
        room["participantCount"] = len(participants)
        cls._save(room)
        log.info("meeting_room_left", room_id=room_id, peer_removed=removed, remaining_count=len(participants))
        return {"roomId": room_id, "remainingParticipants": len(participants), "destroyed": False, "removed": removed}

    @classmethod
    def end_room(cls, room_id: str, peer_id: str) -> Dict[str, Any]:
        room = cls._load(room_id)
        if not room:
            raise KeyError(f"Meeting room '{room_id}' not found")
        if room.get("hostPeerId") != peer_id:
            raise PermissionError("Only the meeting host can end the meeting")
        room["isOpen"] = False
        room["endedAt"] = _now_iso()
        room["endedBy"] = room.get("hostName") or "the host"
        room["participants"] = {}
        room["_activePeers"] = set()
        room["participantCount"] = 0
        cls._save(room)
        log.info("meeting_room_ended", room_id=room_id, ended_by=peer_id)
        return {"roomId": room_id, "isOpen": False, "endedAt": room["endedAt"], "endedBy": room["endedBy"]}

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
    def room_status(cls, room_id: str) -> Dict[str, Any]:
        room = cls._load(room_id)
        if not room:
            raise KeyError(f"Meeting room '{room_id}' not found")
        return {
            "roomId": room_id,
            "participantCount": len(room.get("_activePeers", set())),
            "isOpen": room.get("isOpen", True),
            "createdAt": room.get("createdAt", ""),
            "activeAt": room.get("activeAt", ""),
            "hostPeerId": room.get("hostPeerId", ""),
            "endedAt": room.get("endedAt", ""),
            "endedBy": room.get("endedBy", ""),
        }
