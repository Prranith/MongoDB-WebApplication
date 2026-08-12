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
    if not isinstance(raw, list):
        return {}
    result = {}
    for i in range(0, len(raw) - 1, 2):
        result[raw[i]] = raw[i + 1]
    return result


def room_key(room_id: str) -> str:
    return f"room:{room_id}"
