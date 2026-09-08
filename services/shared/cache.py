"""
services/shared/cache.py
Cache-aside abstraction with Redis-first and in-memory fallback.

This module introduces:
- A consistent cache key naming convention: domain:entity:id:version
- TTL policies for read-heavy data
- Cache invalidation hooks for create/update/delete paths
- SingleFlight / thundering-herd protection for expensive reads

No existing routes/services are modified here; consumers opt in gradually.
"""

from __future__ import annotations

import hashlib
import threading
import time
import typing as t

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "cache")


# ---------------------------------------------------------------------------
# Cache key conventions
# ---------------------------------------------------------------------------

def cache_key(domain: str, entity: str, identifier: t.Any, *, version: t.Optional[str] = None) -> str:
    """Build a cache key using the convention {domain}:{entity}:{id}:{version}."""
    key = f"{domain}:{entity}:{identifier}"
    if version:
        key = f"{key}:{version}"
    return key


def cache_key_for_query(domain: str, *, query_sha: str, params_sha: t.Optional[str] = None) -> str:
    """Cache key for expensive read queries based on a stable hash of inputs."""
    base = f"{domain}:query:{query_sha}"
    if params_sha:
        base = f"{base}:params:{params_sha}"
    return base


def sha_signature(*parts: t.Any) -> str:
    """Deterministic SHA-256 signature for cache key derivation."""
    payload = "|".join(str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Backend abstraction
# ---------------------------------------------------------------------------

class CacheBackend(t.Protocol):
    """Minimal cache backend interface used by the cache manager."""

    def get(self, key: str) -> t.Optional[t.Any]: ...
    def set(self, key: str, value: t.Any, *, ttl_seconds: t.Optional[int] = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def delete_many(self, keys: t.Sequence[str]) -> None: ...


# ---------------------------------------------------------------------------
# In-memory fallback (used when Redis/Upstash is unavailable)
# ---------------------------------------------------------------------------

class MemoryCacheBackend:
    """Thread-safe in-memory cache with simple TTL expiration.

    In production this is intended only as a fallback; a real distributed
    cache (Redis) should be preferred for shared state.
    """

    def __init__(self) -> None:
        # Maps key -> (value, expires_at_or_None)
        self._store: t.Dict[str, t.Tuple[t.Any, t.Optional[float]]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> t.Optional[t.Any]:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, expires_at = entry
            if expires_at is not None and time.time() > expires_at:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: t.Any, *, ttl_seconds: t.Optional[int] = None) -> None:
        with self._lock:
            expires_at = None
            if ttl_seconds is not None:
                expires_at = time.time() + ttl_seconds
            self._store[key] = (value, expires_at)

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def delete_many(self, keys: t.Sequence[str]) -> None:
        with self._lock:
            for key in keys:
                self._store.pop(key, None)


# ---------------------------------------------------------------------------
# Cache manager
# ---------------------------------------------------------------------------

class CacheManager:
    """Cache-aside manager with TTL, invalidation, and optional SingleFlight."""

    def __init__(
        self,
        backend: CacheBackend,
        *,
        default_ttl_seconds: int = 60,
        singleflight_enabled: bool = True,
    ) -> None:
        self._backend = backend
        self._default_ttl = default_ttl_seconds
        self._singleflight_enabled = singleflight_enabled
        self._singleflight: t.Dict[str, t.Any] = {}
        self._singleflight_lock = threading.Lock()

    # --- Read path ---

    def get(self, key: str) -> t.Optional[t.Any]:
        return self._backend.get(key)

    def get_or_load(
        self,
        key: str,
        loader: t.Callable[[], t.Any],
        *,
        ttl_seconds: t.Optional[int] = None,
        protection: bool = True,
    ) -> t.Any:
        """Cache-aside read with thundering-herd protection.

        If the key is missing, only one caller performs `loader()` while others
        wait for the result (SingleFlight-style). Once loaded, the value is
        cached with the given TTL.
        """
        value = self._backend.get(key)
        if value is not None:
            return value

        if protection and self._singleflight_enabled:
            return self._load_with_protection(key, loader, ttl_seconds=ttl_seconds)

        value = loader()
        self._backend.set(key, value, ttl_seconds=ttl_seconds)
        return value

    # --- Write path / invalidation ---

    def set(self, key: str, value: t.Any, *, ttl_seconds: t.Optional[int] = None) -> None:
        self._backend.set(key, value, ttl_seconds=ttl_seconds)

    def delete(self, key: str) -> None:
        self._backend.delete(key)

    def invalidate(self, pattern: str) -> None:
        """Delete all keys that start with the given prefix.

        This is a simple but effective invalidation strategy for versioned keys.
        """
        raise NotImplementedError("Bulk/pattern deletion must be implemented by the backend")

    def invalidate_keys(self, keys: t.Sequence[str]) -> None:
        self._backend.delete_many(keys)

    # --- Helpers ---

    def _load_with_protection(
        self,
        key: str,
        loader: t.Callable[[], t.Any],
        *,
        ttl_seconds: t.Optional[int],
    ) -> t.Any:
        with self._singleflight_lock:
            if key in self._singleflight:
                event, _start = self._singleflight[key]
            else:
                event = threading.Event()
                self._singleflight[key] = (event, time.time())
                try:
                    value = loader()
                    self._backend.set(key, value, ttl_seconds=ttl_seconds)
                    elapsed = time.time() - self._singleflight[key][1]
                    log.debug("cache_loaded", key=key, elapsed_ms=round(elapsed * 1000, 2))
                    return value
                finally:
                    event.set()
                    self._singleflight.pop(key, None)

        # Another thread is already loading; wait for it
        event.wait()
        value = self._backend.get(key)
        if value is None:
            # Fallback: loader may have failed; retry once
            log.warning("cache_protection_stale", key=key)
            value = loader()
            self._backend.set(key, value, ttl_seconds=ttl_seconds)
        return value


# ---------------------------------------------------------------------------
# Global fallback instance
# ---------------------------------------------------------------------------

_default_backend: t.Optional[CacheBackend] = None
_default_manager: t.Optional[CacheManager] = None
_global_lock = threading.Lock()


def get_cache_manager(
    backend: t.Optional[CacheBackend] = None,
    *,
    default_ttl_seconds: int = 60,
) -> CacheManager:
    """Return a global cache manager (memory-backed if no Redis is configured)."""
    global _default_backend, _default_manager
    with _global_lock:
        if _default_manager is None:
            _default_backend = backend or MemoryCacheBackend()
            _default_manager = CacheManager(_default_backend, default_ttl_seconds=default_ttl_seconds)
        if backend is not None:
            # Replace backend only if reconfiguring; keeps existing manager behavior stable
            _default_backend = backend
            _default_manager = CacheManager(_default_backend, default_ttl_seconds=default_ttl_seconds)
        return _default_manager
