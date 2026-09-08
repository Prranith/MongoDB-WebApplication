"""
services/shared/rate_limit.py
Distributed-friendly rate limiting helpers.

This module provides:
- Sliding window rate limiting (token-bucket-like behavior via counters)
- Per-key limits (IP, user, route, client_id)
- Graceful degradation when the backing cache is unavailable

Rate limiting is additive: existing endpoints are not changed unless wired in.
"""

from __future__ import annotations

import time
import typing as t

from services.shared.cache import CacheManager, MemoryCacheBackend, get_cache_manager


# ---------------------------------------------------------------------------
# Sliding window rate limiter
# ---------------------------------------------------------------------------

class SlidingWindowRateLimiter:
    """A simple sliding-window rate limiter keyed by an identifier.

    It tracks counts per fixed time windows. In a distributed setting this
    should be backed by Redis/Upstash; here we rely on the provided cache.
    """

    def __init__(self, cache: CacheManager, *, window_seconds: int = 60) -> None:
        self._cache = cache
        self._window = window_seconds

    def check(
        self,
        key: str,
        *,
        max_requests: int,
        window_seconds: t.Optional[int] = None,
    ) -> t.Tuple[bool, int, int]:
        """Returns (allowed, current_count, retry_after_seconds)."""
        window = window_seconds or self._window
        now = int(time.time())
        window_key = f"{key}:{now // window}"

        current = self._cache.get(window_key)
        if current is None:
            current = 0

        if current >= max_requests:
            # Approximate retry-after based on current window boundary
            next_window = (now // window + 1) * window
            retry_after = max(0, next_window - now)
            return False, current, retry_after

        new_count = current + 1
        self._cache.set(window_key, new_count, ttl_seconds=window + 5)
        return True, new_count, 0

    def remaining(self, key: str, *, max_requests: int, window_seconds: t.Optional[int] = None) -> int:
        window = window_seconds or self._window
        now = int(time.time())
        window_key = f"{key}:{now // window}"
        current = self._cache.get(window_key) or 0
        return max(0, max_requests - current)


def make_rate_limiter(cache: t.Optional[CacheManager] = None) -> SlidingWindowRateLimiter:
    """Create a rate limiter using the global cache manager by default."""
    return SlidingWindowRateLimiter(cache or get_cache_manager(), window_seconds=60)
