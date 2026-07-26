"""
utils/analytics.py
Real-time production-grade usage analytics & profile visit counter for MongoSandbox.
Uses Upstash Redis REST interface for cloud scalability, with a local JSON fallback.
"""

import json
import threading
import uuid
import time
import urllib.request
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

ANALYTICS_DIR = Path.home() / ".mongosandbox"
ANALYTICS_FILE = ANALYTICS_DIR / "analytics.json"
CLIENT_ID_FILE = ANALYTICS_DIR / "client_id"

UPSTASH_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "https://choice-filly-171541.upstash.io")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "gQAAAAAAAp4VAAIgcDE4NjFmNjc3ODY4NmU0ODE4YWZlNmJlYjJmMjRmMjUzMA")

def _get_or_create_client_id() -> str:
    """Return a persistent unique identifier for this installation/user."""
    try:
        ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
        if CLIENT_ID_FILE.exists():
            cid = CLIENT_ID_FILE.read_text(encoding="utf-8").strip()
            if cid:
                return cid
        cid = str(uuid.uuid4())
        CLIENT_ID_FILE.write_text(cid, encoding="utf-8")
        return cid
    except Exception:
        return str(uuid.uuid4())


class AnalyticsTracker:
    """
    Production-grade real-time analytics tracker.
    Uses Upstash Redis Rest with pipeline optimizations, falling back to local JSON.
    """

    _instance: "AnalyticsTracker | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._client_id = _get_or_create_client_id()
        self._local_data: dict[str, Any] = {
            "total_visits": 0,
            "total_profile_visits": 0,
            "queries_executed": 0,
            "first_visited": None,
            "last_visited": None,
            "active_sessions": [],
            "unique_clients": [self._client_id],
            "collection_visits": {
                "users": 0,
                "orders": 0,
                "inventory": 0,
                "shipments": 0,
                "elite": 0,
            },
        }
        self._load_local()

    @classmethod
    def instance(cls) -> "AnalyticsTracker":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def _load_local(self) -> None:
        try:
            ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
            if ANALYTICS_FILE.exists():
                text = ANALYTICS_FILE.read_text(encoding="utf-8")
                if text.strip():
                    loaded = json.loads(text)
                    if isinstance(loaded, dict):
                        self._local_data.update(loaded)
        except Exception:
            pass

    def _save_local(self) -> None:
        try:
            ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
            ANALYTICS_FILE.write_text(json.dumps(self._local_data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _redis_pipeline(self, commands: list[list[Any]]) -> list[Any] | None:
        """Execute multiple Redis commands in a single HTTP REST pipeline call."""
        if not UPSTASH_URL or not UPSTASH_TOKEN:
            return None
        url = f"{UPSTASH_URL.rstrip('/')}/pipeline"
        headers = {
            "Authorization": f"Bearer {UPSTASH_TOKEN}",
            "Content-Type": "application/json"
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(commands).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=3.0) as response:
                res = json.loads(response.read().decode("utf-8"))
                # Response format: [{'result': ...}, ...]
                return [r.get("result") for r in res]
        except Exception:
            return None

    def _async_run(self, commands: list[list[Any]]) -> None:
        """Run Redis commands asynchronously in a background thread."""
        def worker():
            self._redis_pipeline(commands)
        t = threading.Thread(target=worker, daemon=True)
        t.start()

    def record_app_launch(self, client_id: str | None = None) -> dict[str, Any]:
        """Record an app launch or intro page visit."""
        cid = client_id or self._client_id
        now_iso = datetime.now().isoformat(timespec="seconds")
        now_ts = int(time.time())

        # 1. Update local state fallback
        with self._lock:
            self._local_data["total_visits"] = self._local_data.get("total_visits", 0) + 1
            if not self._local_data.get("first_visited"):
                self._local_data["first_visited"] = now_iso
            self._local_data["last_visited"] = now_iso
            
            sessions = self._local_data.setdefault("active_sessions", [])
            cutoff = now_ts - 300
            sessions = [t for t in sessions if isinstance(t, (int, float)) and t > cutoff]
            sessions.append(now_ts)
            self._local_data["active_sessions"] = sessions

            clients = self._local_data.setdefault("unique_clients", [])
            if cid not in clients:
                clients.append(cid)
            self._save_local()

        # 2. Redis Pipeline: INCR launches for internal tracking, use PFCOUNT for unique visitor display
        pipeline_cmds = [
            ["PFADD", "unique_visitors", cid],          # 0: register unique visitor
            ["PFCOUNT", "unique_visitors"],              # 1: unique visitor count (for total_visits)
            ["ZADD", "active_users", str(now_ts), cid], # 2: register active user
            ["ZREMRANGEBYSCORE", "active_users", "-inf", str(now_ts - 300)],  # 3: prune stale
            ["ZCARD", "active_users"]                   # 4: active user count
        ]
        
        res = self._redis_pipeline(pipeline_cmds)
        if res and len(res) == 5:
            # total_visits = unique visitors (HyperLogLog - stable, truly unique)
            total_visits = res[1]
            active_users = res[4]
            
            # Sync back to local data cache
            with self._lock:
                if isinstance(total_visits, int):
                    self._local_data["total_visits"] = total_visits
                self._save_local()

            return {
                "total_visits": total_visits if isinstance(total_visits, int) else self._local_data["total_visits"],
                "active_users": active_users if isinstance(active_users, int) else len(set(sessions)),
                "last_visited": now_iso
            }
        
        # Fallback to local
        with self._lock:
            recent_sessions = [t for t in self._local_data["active_sessions"] if t > cutoff]
            return {
                "total_visits": self._local_data["total_visits"],
                "active_users": max(1, len(set(recent_sessions))),
                "last_visited": now_iso
            }

    def record_profile_visit(self, collection_name: str) -> None:
        """Record a visit/inspection to a dataset collection profile."""
        with self._lock:
            self._local_data["total_profile_visits"] = self._local_data.get("total_profile_visits", 0) + 1
            visits = self._local_data.setdefault("collection_visits", {})
            visits[collection_name] = visits.get(collection_name, 0) + 1
            self._save_local()

        # Run background Redis commands
        self._async_run([
            ["INCR", "total_profile_visits"],
            ["HINCRBY", "collection_visits", collection_name, "1"]
        ])

    def record_query_executed(self) -> None:
        """Record a query execution event."""
        with self._lock:
            self._local_data["queries_executed"] = self._local_data.get("queries_executed", 0) + 1
            self._save_local()

        # Run background Redis commands
        self._async_run([
            ["INCR", "queries_executed"]
        ])

    def get_stats(self, client_id: str | None = None) -> dict[str, Any]:
        """Return exact real-time usage metrics (pure read — does not write activity)."""
        cid = client_id or self._client_id
        now_ts = int(time.time())
        cutoff = now_ts - 300

        # Pure read pipeline — does NOT register activity (heartbeat/launch does that)
        pipeline_cmds = [
            ["ZCARD", "active_users"],            # 0: active users right now
            ["PFCOUNT", "unique_visitors"],        # 1: unique visitor total (HyperLogLog)
            ["GET", "total_profile_visits"],       # 2
            ["GET", "queries_executed"],           # 3
            ["HGETALL", "collection_visits"]       # 4
        ]
        
        res = self._redis_pipeline(pipeline_cmds)
        if res and len(res) == 5:
            active_users = res[0]
            total_visits = res[1]   # unique visitors via HyperLogLog
            total_prof = res[2]
            queries = res[3]
            col_visits_raw = res[4]

            # Parse HGETALL list [key1, val1, key2, val2...]
            col_visits = {}
            if isinstance(col_visits_raw, list):
                for i in range(0, len(col_visits_raw), 2):
                    if i + 1 < len(col_visits_raw):
                        col_visits[col_visits_raw[i]] = int(col_visits_raw[i+1])

            # Sync Redis numbers back into local cache for offline resiliency
            with self._lock:
                if total_visits is not None:
                    self._local_data["total_visits"] = int(total_visits)
                if total_prof is not None:
                    self._local_data["total_profile_visits"] = int(total_prof)
                if queries is not None:
                    self._local_data["queries_executed"] = int(queries)
                if col_visits:
                    self._local_data["collection_visits"].update(col_visits)
                self._save_local()

            return {
                "total_visits": self._local_data["total_visits"],
                "active_users": active_users if isinstance(active_users, int) else 1,
                "total_profile_visits": self._local_data["total_profile_visits"],
                "queries_executed": self._local_data["queries_executed"],
                "collection_visits": self._local_data["collection_visits"],
                "client_id": cid,
                "first_visited": self._local_data.get("first_visited"),
                "last_visited": self._local_data.get("last_visited")
            }

        # Fallback to local stats
        with self._lock:
            recent_sessions = [t for t in self._local_data.get("active_sessions", []) if t > cutoff]
            return {
                "total_visits": self._local_data["total_visits"],
                "active_users": max(1, len(set(recent_sessions))),
                "total_profile_visits": self._local_data["total_profile_visits"],
                "queries_executed": self._local_data["queries_executed"],
                "collection_visits": dict(self._local_data["collection_visits"]),
                "client_id": cid,
                "first_visited": self._local_data.get("first_visited"),
                "last_visited": self._local_data.get("last_visited")
            }


analytics_tracker = AnalyticsTracker.instance()
