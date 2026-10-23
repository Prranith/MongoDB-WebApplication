"""
services/shared/idempotency.py
Idempotency support for non-safe HTTP methods (POST/PUT/PATCH/DELETE).

Features:
- X-Idempotency-Key based deduplication
- Response caching in a fast store (Redis or in-memory fallback) with TTL
- Optimistic re-play of prior results for retried network calls

This module does not change any existing route signatures. It is wired in at
the middleware/blueprint level separately.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import typing as t
import uuid

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "idempotency")


# ---------------------------------------------------------------------------
# Key derivation
# ---------------------------------------------------------------------------

def idempotency_key_from_header(key: t.Optional[str], *, method: str, path: str) -> t.Optional[str]:
    """Derive a storage key from the idempotency header + request identity.

    We include method + path so keys are scoped per endpoint.
    """
    if not key:
        return None
    raw = f"{method.upper()}|{path}|{key}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"idem:{digest}"


def default_idempotency_key() -> str:
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Response cache entry
# ---------------------------------------------------------------------------

IdempotencyEntry = t.Tuple[int, t.Any, float]  # (status_code, body, created_at)


class IdempotencyStore(t.Protocol):
    def get(self, key: str) -> t.Optional[IdempotencyEntry]: ...
    def set(
        self,
        key: str,
        entry: IdempotencyEntry,
        *,
        ttl_seconds: int,
    ) -> None: ...
    def delete(self, key: str) -> None: ...


class MemoryIdempotencyStore:
    """In-memory idempotency store with TTL."""

    def __init__(self, *, cleanup_interval_seconds: float = 60.0) -> None:
        self._store: t.Dict[str, IdempotencyEntry] = {}
        self._lock = threading.Lock()
        self._cleanup_interval = cleanup_interval_seconds
        self._last_cleanup = 0.0

    def get(self, key: str) -> t.Optional[IdempotencyEntry]:
        with self._lock:
            now = time.time()
            if now - self._last_cleanup >= self._cleanup_interval:
                self._last_cleanup = now
                expired = [k for k, (_s, _b, created_at) in self._store.items() if now - created_at > 3600]
                for k in expired:
                    self._store.pop(k, None)

            entry = self._store.get(key)
            if entry is None:
                return None
            status, body, created_at = entry
            if now - created_at > 3600:
                self._store.pop(key, None)
                return None
            return entry

    def set(self, key: str, entry: IdempotencyEntry, *, ttl_seconds: int) -> None:
        with self._lock:
            self._store[key] = entry

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)


class MongoIdempotencyStore:
    """Durable idempotency store shared by all API instances.

    The in-memory store is useful for tests, but it cannot protect a request
    retried against another serverless instance.  This store keeps only the
    serialized response and expires entries automatically in MongoDB.
    """

    def __init__(self, collection_name: str = "api_idempotency") -> None:
        from services.shared.redis_client import get_mongo_client
        client = get_mongo_client()
        if client is None:
            raise RuntimeError("MongoDB is required for durable idempotency")
        self._collection = client["codeleaf_platform"][collection_name]
        try:
            self._collection.create_index("expiresAt", expireAfterSeconds=0)
        except Exception:
            pass

    def get(self, key: str) -> t.Optional[IdempotencyEntry]:
        doc = self._collection.find_one({"_id": key})
        if not doc or doc.get("expiresAt", 0) <= time.time():
            if doc:
                self._collection.delete_one({"_id": key})
            return None
        return (int(doc.get("status", 200)), doc.get("body"), float(doc.get("createdAt", time.time())))

    def set(self, key: str, entry: IdempotencyEntry, *, ttl_seconds: int) -> None:
        status, body, created_at = entry
        now = time.time()
        self._collection.update_one(
            {"_id": key},
            {"$setOnInsert": {"createdAt": created_at},
             "$set": {"status": status, "body": body, "expiresAt": now + ttl_seconds}},
            upsert=True,
        )

    def delete(self, key: str) -> None:
        self._collection.delete_one({"_id": key})


def get_persistent_idempotency_handler(*, ttl_seconds: int = 600) -> "IdempotencyHandler":
    """Return Mongo-backed handler, falling back safely for local tests."""
    try:
        return IdempotencyHandler(MongoIdempotencyStore(), default_ttl_seconds=ttl_seconds)
    except Exception:
        return IdempotencyHandler(MemoryIdempotencyStore(), default_ttl_seconds=ttl_seconds)


# ---------------------------------------------------------------------------
# Idempotency handler
# ---------------------------------------------------------------------------

class IdempotencyHandler:
    """Checks and records idempotency keys for mutating requests.

    This is an optional layer. It is safe to leave keys unset; in that case
    requests are processed normally without deduplication.
    """

    def __init__(
        self,
        store: IdempotencyStore,
        *,
        default_ttl_seconds: int = 3600,
    ) -> None:
        self._store = store
        self._default_ttl = default_ttl_seconds

    def check_replay(
        self,
        key: t.Optional[str],
        *,
        method: str,
        path: str,
    ) -> t.Optional[t.Tuple[int, t.Any]]:
        """If a prior response exists for this idempotency key, return it.

        This intentionally requires an explicit idempotency key. Requests that
        do not provide one are always processed normally.
        """
        if not key:
            return None
        storage_key = idempotency_key_from_header(key, method=method, path=path)
        if storage_key is None:
            return None
        entry = self._store.get(storage_key)
        if entry is None:
            return None
        status, body, _created = entry
        log.info("idempotency_replay", key=storage_key, status=status)
        return status, body

    def record_response(
        self,
        key: t.Optional[str],
        *,
        method: str,
        path: str,
        status_code: int,
        body: t.Any,
        ttl_seconds: t.Optional[int] = None,
    ) -> None:
        if not key:
            return
        storage_key = idempotency_key_from_header(key, method=method, path=path)
        if storage_key is None:
            return
        self._store.set(
            storage_key,
            (status_code, body, time.time()),
            ttl_seconds=ttl_seconds or self._default_ttl,
        )
        log.debug("idempotency_recorded", key=storage_key, status=status_code)


# ---------------------------------------------------------------------------
# Flask-style middleware helpers
# ---------------------------------------------------------------------------

def get_idempotency_key_from_request(request: t.Any) -> t.Optional[str]:
    """Extract X-Idempotency-Key from a Flask request (if present)."""
    if not request:
        return None
    return request.headers.get("X-Idempotency-Key")


def build_idempotent_json_response(
    status_code: int,
    payload: t.Any,
) -> t.Tuple[int, t.Dict[str, t.Any]]:
    """Normalize response payload for caching."""
    return status_code, payload


def serialize_idempotency_body(body: t.Any, *, store: t.Optional[IdempotencyStore] = None) -> t.Any:
    """Normalize a response body for idempotency storage.

    If a store is provided, it must be able to round-trip the value via
    ``set/get``. For simple in-memory stores this is no-op for primitives.
    """
    if isinstance(body, (dict, list, str, int, float, bool, type(None))):
        return body
    return json.loads(json.dumps(body, default=str))
