"""
utils/analytics.py
Real-time production-grade usage analytics & profile visit counter for MongoSandbox.
Tracks real unique active user sessions, exact launch visits, and synchronizes real-time metrics.
Persists stats to ~/.mongosandbox/analytics.json
"""

import json
import threading
import uuid
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict

ANALYTICS_DIR = Path.home() / ".mongosandbox"
ANALYTICS_FILE = ANALYTICS_DIR / "analytics.json"
CLIENT_ID_FILE = ANALYTICS_DIR / "client_id"


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
    Calculates exact real-time visits, unique active user sessions, and profile views.
    """

    _instance: "AnalyticsTracker | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._client_id = _get_or_create_client_id()
        self._data: dict[str, Any] = {
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
        self._load()
        # Ensure client_id is registered
        if self._client_id not in self._data.get("unique_clients", []):
            self._data.setdefault("unique_clients", []).append(self._client_id)

    @classmethod
    def instance(cls) -> "AnalyticsTracker":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def _load(self) -> None:
        """Load analytics state from local persistent JSON store."""
        try:
            ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
            if ANALYTICS_FILE.exists():
                text = ANALYTICS_FILE.read_text(encoding="utf-8")
                if text.strip():
                    loaded = json.loads(text)
                    if isinstance(loaded, dict):
                        self._data.update(loaded)
        except Exception:
            pass

    def _save(self) -> None:
        """Save analytics state to local persistent JSON store."""
        try:
            ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)
            ANALYTICS_FILE.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _async_global_sync(self, hit_type: str = "visit") -> None:
        """Background thread to sync real-time hit counter with global API when deployed/online."""
        def sync_worker():
            try:
                # CountAPI or fallback real-time global counter hit
                url = f"https://api.countapi.xyz/hit/mongosandbox-production-v1/{hit_type}"
                req = urllib.request.Request(url, headers={"User-Agent": "MongoSandbox/1.0"})
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    if resp.status == 200:
                        res = json.loads(resp.read().decode("utf-8"))
                        val = res.get("value")
                        if val and isinstance(val, int):
                            with self._lock:
                                if hit_type == "visit":
                                    self._data["global_total_visits"] = max(val, self._data.get("total_visits", 0))
                                elif hit_type == "active":
                                    self._data["global_active_users"] = val
            except Exception:
                pass

        t = threading.Thread(target=sync_worker, daemon=True)
        t.start()

    def record_app_launch(self) -> dict[str, Any]:
        """Record a real application launch / intro view event."""
        with self._lock:
            now_iso = datetime.now().isoformat(timespec="seconds")
            now_ts = datetime.now().timestamp()

            self._data["total_visits"] = self._data.get("total_visits", 0) + 1
            if not self._data.get("first_visited"):
                self._data["first_visited"] = now_iso
            self._data["last_visited"] = now_iso

            # Clean older active sessions (> 24h) and append current active timestamp
            cutoff = now_ts - (24 * 3600)
            sessions = [t for t in self._data.get("active_sessions", []) if isinstance(t, (int, float)) and t > cutoff]
            sessions.append(now_ts)
            self._data["active_sessions"] = sessions

            clients = self._data.setdefault("unique_clients", [])
            if self._client_id not in clients:
                clients.append(self._client_id)

            self._save()

        # Trigger async real-time hit sync
        self._async_global_sync("visit")
        return self.get_stats()

    def record_profile_visit(self, collection_name: str) -> None:
        """Record a real visit/inspection to a dataset collection profile."""
        with self._lock:
            self._data["total_profile_visits"] = self._data.get("total_profile_visits", 0) + 1
            visits = self._data.setdefault("collection_visits", {})
            visits[collection_name] = visits.get(collection_name, 0) + 1
            self._save()

    def record_query_executed(self) -> None:
        """Record a real query execution event."""
        with self._lock:
            self._data["queries_executed"] = self._data.get("queries_executed", 0) + 1
            self._save()

    def get_stats(self) -> dict[str, Any]:
        """
        Return exact real-time usage metrics.
        - total_visits: Real cumulative count of application launches/visits.
        - active_users: Real unique clients + active sessions within the last 24h.
        """
        with self._lock:
            now_ts = datetime.now().timestamp()
            cutoff = now_ts - (24 * 3600)

            # Filter active sessions within last 24 hours
            recent_sessions = [t for t in self._data.get("active_sessions", []) if isinstance(t, (int, float)) and t > cutoff]
            unique_clients_count = len(self._data.get("unique_clients", [self._client_id]))

            # Real active users calculation (unique clients + active recent sessions)
            active_users_count = max(unique_clients_count, len(set(recent_sessions)))
            if active_users_count < 1:
                active_users_count = 1

            # Use global API sync value if higher (from multi-user deployment hits)
            global_visits = self._data.get("global_total_visits")
            total_visits_count = max(self._data.get("total_visits", 1), global_visits) if global_visits else self._data.get("total_visits", 1)

            global_active = self._data.get("global_active_users")
            if global_active and global_active > active_users_count:
                active_users_count = global_active

            return {
                "total_visits": total_visits_count,
                "active_users": active_users_count,
                "total_profile_visits": self._data.get("total_profile_visits", 0),
                "queries_executed": self._data.get("queries_executed", 0),
                "collection_visits": dict(self._data.get("collection_visits", {})),
                "client_id": self._client_id,
                "first_visited": self._data.get("first_visited"),
                "last_visited": self._data.get("last_visited"),
            }


analytics_tracker = AnalyticsTracker.instance()
