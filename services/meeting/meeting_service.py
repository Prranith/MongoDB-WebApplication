"""
services/meeting/meeting_service.py
Room management and DB cleanup for real-time video/screen-share meetings.
"""

import uuid
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from pymongo import MongoClient

from services.shared.cache import cache


class MeetingService:
    """
    Lightweight room management for PeerJS WebRTC meetings.
    - Creates room metadata in MongoDB
    - Tracks active participants count
    - Auto-cleans up rooms when participant count reaches 0
    - Purges orphaned rooms older than 2 hours
    """

    ROOM_TTL_HOURS = 2
    COLLECTION_NAME = "meeting_rooms"

    def __init__(self, mongo_client: Optional[MongoClient] = None):
        self.client = mongo_client
        self.db = None
        self.collection = None
        if self.client:
            self.db = self.client.get_database("codexa_labs")
            self.collection = self.db[self.COLLECTION_NAME]

    def _ensure_collection(self):
        if self.collection is None:
            raise RuntimeError("MongoDB client not initialized")

    def create_room(self, room_id: Optional[str] = None, host_peer_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Create a new meeting room.
        Returns room data including generated room_id.
        """
        self._ensure_collection()
        room_id = room_id or f"DEV-{uuid.uuid4().hex[:6].upper()}"
        
        now = datetime.utcnow()
        room_data = {
            "room_id": room_id,
            "host_peer_id": host_peer_id,
            "created_at": now,
            "updated_at": now,
            "active_participants": 1,
            "is_active": True,
        }
        
        self.collection.insert_one(room_data)
        cache.set(f"meeting_room:{room_id}", room_data, ttl=3600)
        
        return room_data

    def join_room(self, room_id: str) -> Optional[Dict[str, Any]]:
        """
        Validate room exists and increment participant count.
        Returns room data if found, None otherwise.
        """
        self._ensure_collection()
        room = self.collection.find_one({"room_id": room_id, "is_active": True})
        
        if room:
            self.collection.update_one(
                {"room_id": room_id},
                {
                    "$inc": {"active_participants": 1},
                    "$set": {"updated_at": datetime.utcnow()}
                }
            )
            room["active_participants"] += 1
            cache.set(f"meeting_room:{room_id}", room, ttl=3600)
        
        return room

    def leave_room(self, room_id: str, peer_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Decrement participant count. If count reaches 0, delete the room.
        Returns status dict with action taken.
        """
        self._ensure_collection()
        room = self.collection.find_one({"room_id": room_id, "is_active": True})
        
        if not room:
            return {"status": "not_found", "room_id": room_id}
        
        new_count = max(0, room["active_participants"] - 1)
        
        if new_count == 0:
            self.collection.delete_one({"room_id": room_id})
            cache.delete(f"meeting_room:{room_id}")
            return {"status": "deleted", "room_id": room_id, "reason": "no_participants"}
        
        self.collection.update_one(
            {"room_id": room_id},
            {
                "$set": {
                    "active_participants": new_count,
                    "updated_at": datetime.utcnow()
                }
            }
        )
        cache.set(f"meeting_room:{room_id}", {"room_id": room_id, "active_participants": new_count}, ttl=3600)
        
        return {"status": "updated", "room_id": room_id, "active_participants": new_count}

    def get_room_status(self, room_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetch active room metadata.
        """
        cached = cache.get(f"meeting_room:{room_id}")
        if cached:
            return cached
        
        self._ensure_collection()
        room = self.collection.find_one({"room_id": room_id, "is_active": True})
        
        if room:
            room["_id"] = str(room.get("_id", ""))
            cache.set(f"meeting_room:{room_id}", room, ttl=3600)
        
        return room

    def cleanup_orphaned_rooms(self) -> int:
        """
        Delete rooms that have been inactive for longer than ROOM_TTL_HOURS.
        Returns count of deleted rooms.
        """
        self._ensure_collection()
        cutoff = datetime.utcnow() - timedelta(hours=self.ROOM_TTL_HOURS)
        
        result = self.collection.delete_many({
            "is_active": True,
            "updated_at": {"$lt": cutoff}
        })
        
        return result.deleted_count


# Singleton instance
meeting_service = MeetingService()
