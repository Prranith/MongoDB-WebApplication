import os
import sys
import json
import time
import pymongo
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

# MongoDB Atlas Connection (Unlimited commands & storage)
MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb+srv://swargamprranith1_db_user:Prranith0521@cluster0.hgri1wa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
)

try:
    _mongo_client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000, maxPoolSize=50)
    _db = _mongo_client["exam_system"]
    _rooms = _db["rooms"]
except Exception as e:
    print(f"Warning: Failed to connect to MongoDB Atlas: {e}")
    _rooms = None


def _clean_room_id(raw_id: str) -> str:
    if not raw_id:
        return ""
    return str(raw_id).replace("room:", "").strip().upper()


def _get_room_doc(room_id: str) -> dict:
    """Fetch room document from MongoDB Atlas."""
    if _rooms is None:
        return {}
    try:
        clean_id = _clean_room_id(room_id)
        if not clean_id:
            return {}
        doc = _rooms.find_one({"_id": clean_id})
        if not doc:
            # Case-insensitive fallback
            import re
            doc = _rooms.find_one({"_id": {"$regex": f"^{re.escape(clean_id)}$", "$options": "i"}}) or {}
        if doc:
            doc.pop("_id", None)
            return doc
        return {}
    except Exception as e:
        print(f"MongoDB read error: {e}")
        return {}


def redis_cmd(commands: list) -> list | None:
    """Execute operations atomically against MongoDB Atlas."""
    results = []
    for cmd in commands:
        if not cmd or not isinstance(cmd, list):
            results.append(None)
            continue

        op = cmd[0].upper()
        if op == "HSET":
            if len(cmd) < 3:
                results.append(None)
                continue
            key = cmd[1]
            room_id = _clean_room_id(key)
            
            set_fields = {}
            for i in range(2, len(cmd) - 1, 2):
                set_fields[cmd[i]] = cmd[i + 1]
            
            if set_fields and _rooms is not None and room_id:
                try:
                    _rooms.update_one({"_id": room_id}, {"$set": set_fields}, upsert=True)
                    results.append(len(set_fields))
                except Exception as e:
                    print(f"MongoDB write error: {e}")
                    results.append(0)
            else:
                results.append(0)

        elif op == "HDEL":
            if len(cmd) < 3:
                results.append(None)
                continue
            key = cmd[1]
            room_id = _clean_room_id(key)
            unset_fields = {f: "" for f in cmd[2:]}
            if unset_fields and _rooms is not None and room_id:
                try:
                    _rooms.update_one({"_id": room_id}, {"$unset": unset_fields})
                    results.append(len(cmd) - 2)
                except Exception as e:
                    print(f"MongoDB unset error: {e}")
                    results.append(0)
            else:
                results.append(0)

        elif op == "HSETNX":
            if len(cmd) < 4:
                results.append(None)
                continue
            key = cmd[1]
            room_id = _clean_room_id(key)
            field = cmd[2]
            val = cmd[3]
            doc = _get_room_doc(room_id)
            if field not in doc and _rooms is not None and room_id:
                try:
                    _rooms.update_one({"_id": room_id}, {"$set": {field: val}}, upsert=True)
                    results.append(1)
                except Exception:
                    results.append(0)
            else:
                results.append(0)

        elif op == "EXPIRE":
            # MongoDB Atlas manages persistent documents; expire is a no-op success
            results.append(1)

        elif op == "DEL":
            room_id = _clean_room_id(cmd[1])
            if _rooms is not None and room_id:
                try:
                    _rooms.delete_one({"_id": room_id})
                    results.append(1)
                except Exception:
                    results.append(0)
            else:
                results.append(0)

        else:
            results.append(None)

    return results


def redis_one(command: list):
    """Execute a single operation against MongoDB Atlas."""
    if not command or not isinstance(command, list):
        return None

    op = command[0].upper()
    if op == "HGET":
        room_id = command[1]
        field = command[2]
        doc = _get_room_doc(room_id)
        return doc.get(field)

    elif op == "HMGET":
        room_id = command[1]
        fields = command[2:]
        doc = _get_room_doc(room_id)
        return [doc.get(f) for f in fields]

    elif op == "HGETALL":
        room_id = command[1]
        return _get_room_doc(room_id)

    elif op == "EXISTS":
        room_id = command[1]
        doc = _get_room_doc(room_id)
        return 1 if doc else 0

    elif op == "DEL":
        room_id = command[1]
        res = redis_cmd([["DEL", room_id]])
        return res[0] if res else 0

    else:
        res = redis_cmd([command])
        return res[0] if res else None


def hgetall(key: str) -> dict:
    """Fetch all fields for a key from MongoDB Atlas."""
    room_id = key.replace("room:", "")
    return _get_room_doc(room_id)


def room_key(room_id: str) -> str:
    return f"room:{room_id}"


def get_room_participants(room_id: str) -> dict:
    """Fetch participants dictionary from MongoDB Atlas."""
    all_data = _get_room_doc(room_id)
    participants = {}
    if all_data:
        for k, v in all_data.items():
            if k.startswith("participant:"):
                sid = k[len("participant:"):]
                participants[sid] = v
    if participants:
        return participants

    legacy_json = all_data.get("participants")
    if legacy_json:
        try:
            return json.loads(legacy_json) if isinstance(legacy_json, str) else legacy_json
        except Exception:
            pass
    return {}


def get_room_leaderboard_dict(room_id: str) -> dict:
    """Fetch leaderboard dictionary from MongoDB Atlas."""
    all_data = _get_room_doc(room_id)
    leaderboard = {}
    if all_data:
        for k, v in all_data.items():
            if k.startswith("score:"):
                sid = k[len("score:"):]
                try:
                    leaderboard[sid] = float(v) if "." in str(v) else int(v)
                except Exception:
                    leaderboard[sid] = 0
    if leaderboard:
        return leaderboard

    legacy_json = all_data.get("leaderboard")
    if legacy_json:
        try:
            return json.loads(legacy_json) if isinstance(legacy_json, str) else legacy_json
        except Exception:
            pass
    return {}


def get_room_kicked_dict(room_id: str) -> dict:
    """Fetch kicked dictionary from MongoDB Atlas."""
    all_data = _get_room_doc(room_id)
    kicked = {}
    if all_data:
        for k, v in all_data.items():
            if k.startswith("kicked:"):
                sid = k[len("kicked:"):]
                kicked[sid] = v
    if kicked:
        return kicked

    legacy_json = all_data.get("kicked")
    if legacy_json:
        try:
            parsed = json.loads(legacy_json) if isinstance(legacy_json, str) else legacy_json
            if isinstance(parsed, list):
                return {sid: "Removed by Mentor" for sid in parsed}
            return parsed
        except Exception:
            pass
    return {}
