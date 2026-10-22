"""Bounded coordination for database-query execution.

This protects each application worker from unbounded Mongo/SQL work.  It is
intentionally small and dependency-free; deployments with multiple workers
should still use a shared worker/Redis queue for global ordering.
"""

import os
import threading
import time
from contextlib import contextmanager


_MAX_ACTIVE = max(1, int(os.getenv("QUERY_EXECUTION_CONCURRENCY", "4")))
_WAIT_SECONDS = max(0.1, float(os.getenv("QUERY_EXECUTION_QUEUE_TIMEOUT", "15")))
_slots = threading.BoundedSemaphore(_MAX_ACTIVE)
_local = threading.local()


@contextmanager
def query_slot(kind: str):
    """Wait for a bounded execution slot and release it reliably.

    Nested calls in the same request reuse the slot, preventing deadlocks when
    a room-query loader delegates to the common SQL executor.
    """
    depth = getattr(_local, "depth", 0)
    if depth:
        _local.depth = depth + 1
        try:
            yield {"queued": False, "kind": kind, "activeLimit": _MAX_ACTIVE}
        finally:
            _local.depth -= 1
        return

    started = time.monotonic()
    acquired = _slots.acquire(timeout=_WAIT_SECONDS)
    if not acquired:
        raise TimeoutError(
            f"The {kind} execution queue is busy. Please retry in a moment."
        )
    _local.depth = 1
    try:
        yield {
            "queued": time.monotonic() - started > 0.01,
            "waitMs": round((time.monotonic() - started) * 1000, 2),
            "kind": kind,
            "activeLimit": _MAX_ACTIVE,
        }
    finally:
        _local.depth = 0
        _slots.release()
