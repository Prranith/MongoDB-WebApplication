"""
services/shared/circuit_breaker.py
Circuit breaker wrapper for external service calls.

States:
- closed: normal operation
- open: fast-fail after consecutive/aggregate failures
- half_open: allow a probe request to test recovery

This is intentionally small and additive. It does not touch existing services.
"""

from __future__ import annotations

import threading
import time
import typing as t
import uuid

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "circuit_breaker")


class CircuitState(t.NamedTuple):
    closed: bool
    open_: bool
    half_open: bool


class CircuitBreaker:
    """A simple thread-safe circuit breaker.

    Configuration:
    - failure_threshold: open the circuit after this many failures
    - recovery_timeout_seconds: time before transitioning from open to half_open
    - half_open_max_calls: number of probe calls allowed in half_open
    """

    def __init__(
        self,
        *,
        failure_threshold: int = 5,
        recovery_timeout_seconds: float = 10.0,
        half_open_max_calls: int = 1,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout_seconds
        self._half_open_max_calls = half_open_max_calls

        self._state: str = "closed"
        self._failure_count = 0
        self._success_count = 0
        self._open_at: float = 0.0
        self._call_semaphore = threading.BoundedSemaphore(value=half_open_max_calls)
        self._lock = threading.Lock()
        self._id = uuid.uuid4().hex[:8]

    @property
    def id(self) -> str:
        return self._id

    def allow_request(self) -> bool:
        with self._lock:
            if self._state == "closed":
                return True
            if self._state == "open":
                if time.time() - self._open_at >= self._recovery_timeout:
                    self._transition("half_open")
                    return True
                return False
            if self._state == "half_open":
                if self._call_semaphore.acquire(blocking=False):
                    return True
                return False
        return True

    def record_success(self) -> None:
        with self._lock:
            if self._state == "half_open":
                self._success_count += 1
                if self._success_count >= self._half_open_max_calls:
                    self._transition("closed")
            else:
                self._failure_count = 0

    def record_failure(self) -> None:
        with self._lock:
            if self._state == "closed":
                self._failure_count += 1
                if self._failure_count >= self._failure_threshold:
                    self._transition("open")
            elif self._state == "half_open":
                # Any failure in half_open reopens the circuit
                self._transition("open")

    def _transition(self, new_state: str) -> None:
        old = self._state
        self._state = new_state
        if new_state == "open":
            self._open_at = time.time()
            self._failure_count = 0
            self._success_count = 0
        elif new_state == "closed":
            self._failure_count = 0
            self._success_count = 0
            self._call_semaphore = threading.BoundedSemaphore(value=self._half_open_max_calls)
        elif new_state == "half_open":
            self._success_count = 0
        log.info("circuit_state_changed", circuit_id=self._id, from_state=old, to_state=new_state)

    @property
    def is_closed(self) -> bool:
        with self._lock:
            return self._state == "closed"

    @property
    def state_snapshot(self) -> CircuitState:
        with self._lock:
            return CircuitState(closed=(self._state == "closed"), open_=(self._state == "open"), half_open=(self._state == "half_open"))


# ---------------------------------------------------------------------------
# Global registry by name
# ---------------------------------------------------------------------------

_registries: t.Dict[str, CircuitBreaker] = {}
_reg_lock = threading.Lock()


def get_circuit_breaker(name: str, *, recreate: bool = False) -> CircuitBreaker:
    """Get or create a named circuit breaker."""
    with _reg_lock:
        if recreate or name not in _registries:
            _registries[name] = CircuitBreaker()
        return _registries[name]
