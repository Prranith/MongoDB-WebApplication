import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from utils.analytics import analytics_tracker

def redis_cmd(commands: list) -> list | None:
    """Execute Redis pipeline via Upstash REST."""
    return analytics_tracker._redis_pipeline(commands)


def redis_one(command: list):
    """Execute a single Redis command and return its result."""
    res = redis_cmd([command])
    if res and len(res) >= 1:
        return res[0]
    return None


def hgetall(key: str) -> dict:
    """Fetch a Redis Hash as a Python dict."""
    raw = redis_one(["HGETALL", key])
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, list):
        return {}
    result = {}
    for i in range(0, len(raw) - 1, 2):
        result[raw[i]] = raw[i + 1]
    return result


def room_key(room_id: str) -> str:
    return f"room:{room_id}"


def get_room_participants(room_id: str) -> dict:
    """Fetch participants dictionary packed within room:{room_id} hash."""
    import json
    all_data = hgetall(f"room:{room_id}")
    participants = {}
    if all_data:
        for k, v in all_data.items():
            if k.startswith("participant:"):
                sid = k[len("participant:"):]
                participants[sid] = v
    if participants:
        return participants

    # Fallback to separate hash or legacy JSON field
    raw_hash = hgetall(f"room:{room_id}:participants")
    if raw_hash:
        return raw_hash
    legacy_json = all_data.get("participants") if all_data else redis_one(["HGET", f"room:{room_id}", "participants"])
    if legacy_json:
        try:
            return json.loads(legacy_json)
        except Exception:
            pass
    return {}


def get_room_leaderboard_dict(room_id: str) -> dict:
    """Fetch leaderboard dictionary packed within room:{room_id} hash."""
    import json
    all_data = hgetall(f"room:{room_id}")
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

    # Fallback to separate hash or legacy JSON field
    raw_hash = hgetall(f"room:{room_id}:leaderboard")
    if raw_hash:
        return raw_hash
    legacy_json = all_data.get("leaderboard") if all_data else redis_one(["HGET", f"room:{room_id}", "leaderboard"])
    if legacy_json:
        try:
            return json.loads(legacy_json)
        except Exception:
            pass
    return {}


def get_room_kicked_dict(room_id: str) -> dict:
    """Fetch kicked dictionary packed within room:{room_id} hash."""
    import json
    all_data = hgetall(f"room:{room_id}")
    kicked = {}
    if all_data:
        for k, v in all_data.items():
            if k.startswith("kicked:"):
                sid = k[len("kicked:"):]
                kicked[sid] = v
    if kicked:
        return kicked

    # Fallback to separate hash or legacy JSON field
    raw_hash = hgetall(f"room:{room_id}:kicked")
    if raw_hash:
        return raw_hash
    legacy_json = all_data.get("kicked") if all_data else redis_one(["HGET", f"room:{room_id}", "kicked"])
    if legacy_json:
        try:
            parsed = json.loads(legacy_json)
            if isinstance(parsed, list):
                return {sid: "Removed by Mentor" for sid in parsed}
            return parsed
        except Exception:
            pass
    return {}
