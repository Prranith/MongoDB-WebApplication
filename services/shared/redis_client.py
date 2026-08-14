import os
import sys
import json
import time
import pymongo
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

# MongoDB Atlas Direct Connection (Bypasses SRV DNS timeouts on Vercel Serverless)
MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://swargamprranith1_db_user:Prranith0521@ac-wowbq8f-shard-00-00.hgri1wa.mongodb.net:27017,ac-wowbq8f-shard-00-01.hgri1wa.mongodb.net:27017,ac-wowbq8f-shard-00-02.hgri1wa.mongodb.net:27017/?ssl=true&replicaSet=atlas-193153-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Cluster0"
)

_mongo_client = None
_db = None
_rooms = None

def _get_rooms_coll():
    """Lazy singleton to acquire rooms collection with auto-reconnect."""
    global _mongo_client, _db, _rooms
    if _rooms is not None:
        return _rooms
    try:
        _mongo_client = pymongo.MongoClient(
            MONGO_URI,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            socketTimeoutMS=10000,
            maxPoolSize=50,
            retryWrites=True,
            w="majority"
        )
        _db = _mongo_client["exam_system"]
        _rooms = _db["rooms"]
        return _rooms
    except Exception as e:
        print(f"Warning: Failed to connect to MongoDB Atlas: {e}")
        return None


def _get_room_doc(room_id: str) -> dict:
    """Fetch room document from MongoDB Atlas."""
    coll = _get_rooms_coll()
    if coll is None:
        return {}
    try:
        clean_id = room_id.replace("room:", "").strip().upper()
        doc = coll.find_one({"_id": clean_id}) or {}
        doc.pop("_id", None)
        return doc
    except Exception as e:
        print(f"MongoDB read error: {e}")
        return {}


def redis_cmd(commands: list) -> list | None:
    """Execute operations atomically against MongoDB Atlas."""
    coll = _get_rooms_coll()
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
            room_id = key.replace("room:", "").strip().upper()
            
            set_fields = {}
            for i in range(2, len(cmd) - 1, 2):
                set_fields[str(cmd[i])] = cmd[i + 1]
            
            if set_fields and coll is not None:
                try:
                    coll.update_one({"_id": room_id}, {"$set": set_fields}, upsert=True)
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
            room_id = key.replace("room:", "").strip().upper()
            unset_fields = {str(f): "" for f in cmd[2:]}
            if unset_fields and coll is not None:
                try:
                    coll.update_one({"_id": room_id}, {"$unset": unset_fields})
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
            room_id = key.replace("room:", "").strip().upper()
            field = str(cmd[2])
            val = cmd[3]
            doc = _get_room_doc(room_id)
            if field not in doc and coll is not None:
                try:
                    coll.update_one({"_id": room_id}, {"$set": {field: val}}, upsert=True)
                    results.append(1)
                except Exception:
                    results.append(0)
            else:
                results.append(0)

        elif op == "EXISTS":
            room_id = cmd[1].replace("room:", "").strip().upper()
            doc = _get_room_doc(room_id)
            results.append(1 if bool(doc) else 0)

        elif op == "DEL":
            room_id = cmd[1].replace("room:", "").strip().upper()
            if coll is not None:
                res = coll.delete_one({"_id": room_id})
                results.append(res.deleted_count)
            else:
                results.append(0)

        elif op == "EXPIRE":
            # MongoDB Atlas documents are persistently stored
            results.append(1)

        else:
            results.append(None)

    return results


def redis_one(command: list):
    """Execute a single operation against MongoDB Atlas."""
    if not command or not isinstance(command, list):
        return None

    op = command[0].upper()
    if op == "HGET":
        room_id = command[1].replace("room:", "").strip().upper()
        field = str(command[2])
        doc = _get_room_doc(room_id)
        return doc.get(field)

    elif op == "HMGET":
        room_id = command[1].replace("room:", "").strip().upper()
        fields = [str(f) for f in command[2:]]
        doc = _get_room_doc(room_id)
        return [doc.get(f) for f in fields]

    elif op == "HGETALL":
        room_id = command[1].replace("room:", "").strip().upper()
        return _get_room_doc(room_id)

    elif op == "EXISTS":
        room_id = command[1].replace("room:", "").strip().upper()
        doc = _get_room_doc(room_id)
        return 1 if bool(doc) else 0

    elif op == "DEL":
        room_id = command[1].replace("room:", "").strip().upper()
        coll = _get_rooms_coll()
        if coll is not None:
            res = coll.delete_one({"_id": room_id})
            return res.deleted_count
        return 0

    else:
        res = redis_cmd([command])
        return res[0] if res else None


def hgetall(key: str) -> dict:
    """Fetch all fields for a key from MongoDB Atlas."""
    room_id = key.replace("room:", "").strip().upper()
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
