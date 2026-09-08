"""
services/shared/retry.py
Retry helper with exponential backoff + jitter and dead-letter handling.

Used for:
- background event publishing
- transient external API calls
- Kafka/RabbitMQ producer retries

No existing route/service logic is changed here.
"""

from __future__ import annotations

import random
import time
import typing as t
import uuid

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "retry")


def _noop(*args, **kwargs):
    return None


# ---------------------------------------------------------------------------
# Backoff calculation
# ---------------------------------------------------------------------------

def exponential_backoff_with_jitter(
    attempt: int,
    *,
    base: float = 0.1,
    max_seconds: float = 30.0,
    jitter: bool = True,
) -> float:
    """Compute a backoff delay for the given attempt (0-based)."""
    delay = base * (2 ** attempt)
    if delay > max_seconds:
        delay = max_seconds
    if jitter:
        delay = delay * (0.5 + random.random())
    return delay


# ---------------------------------------------------------------------------
# Retry decorator / runner
# ---------------------------------------------------------------------------

class RetryConfig(t.NamedTuple):
    max_attempts: int = 3
    base_seconds: float = 0.1
    max_seconds: float = 30.0
    jitter: bool = True
    retry_on: t.Optional[t.Callable[[BaseException], bool]] = None
    before_retry: t.Optional[t.Callable[[int, BaseException], None]] = None


def default_should_retry(exc: BaseException) -> bool:
    """Retry on transient errors only."""
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    name = type(exc).__name__
    transient_names = {"ConnectionError", "TimeoutError", "RemoteDisconnected", "TooManyRequests"}
    return name in transient_names


def retry_call(
    fn: t.Callable[..., t.Any],
    *args: t.Any,
    config: RetryConfig = RetryConfig(),
    **kwargs: t.Any,
) -> t.Any:
    """Run `fn(*args, **kwargs)` with retry/backoff/jitter.

    If all attempts fail, the last exception is raised.
    """
    last_exc: t.Optional[BaseException] = None
    for attempt in range(config.max_attempts):
        try:
            return fn(*args, **kwargs)
        except BaseException as exc:
            last_exc = exc
            if attempt >= config.max_attempts - 1:
                raise
            if not (config.retry_on or default_should_retry)(exc):
                raise
            delay = exponential_backoff_with_jitter(
                attempt,
                base=config.base_seconds,
                max_seconds=config.max_seconds,
                jitter=config.jitter,
            )
            log.warning(
                "retry_attempt",
                attempt=attempt + 1,
                max_attempts=config.max_attempts,
                delay_seconds=round(delay, 3),
                error=str(exc),
            )
            if config.before_retry:
                config.before_retry(attempt, exc)
            else:
                _noop()
            time.sleep(delay)

    # Should not be reached, but keep typing happy
    assert last_exc is not None
    raise last_exc


# ---------------------------------------------------------------------------
# Dead letter queue abstraction
# ---------------------------------------------------------------------------

class DeadLetterStore(t.Protocol):
    def enqueue(self, payload: t.Any, *, reason: str, topic: str, id: t.Optional[str] = None) -> str: ...


class InMemoryDeadLetterStore:
    """Simple DLQ store for local/dev use. Production should use Redis/Kafka DLQ."""

    def __init__(self) -> None:
        self._store: t.List[t.Dict[str, t.Any]] = []

    def enqueue(
        self,
        payload: t.Any,
        *,
        reason: str,
        topic: str,
        id: t.Optional[str] = None,
    ) -> str:
        entry_id = id or uuid.uuid4().hex
        entry = {
            "id": entry_id,
            "topic": topic,
            "reason": reason,
            "payload": payload,
            "created_at": time.time(),
        }
        self._store.append(entry)
        log.warning("dead_letter_enqueued", dlq_id=entry_id, topic=topic, reason=reason)
        return entry_id


# ---------------------------------------------------------------------------
# Retry + DLQ wrapper
# ---------------------------------------------------------------------------

class RetryWithDlq:
    """Retries an operation and enqueues to DLQ when it is ultimately unprocessable."""

    def __init__(
        self,
        *,
        dlq: DeadLetterStore,
        topic: str,
        config: RetryConfig = RetryConfig(),
    ) -> None:
        self._dlq = dlq
        self._topic = topic
        self._config = config

    def execute(self, operation: t.Callable[..., t.Any], *, payload: t.Any, id: t.Optional[str] = None) -> t.Any:
        try:
            return retry_call(operation, config=self._config)
        except BaseException as exc:
            self._dlq.enqueue(
                payload=payload,
                reason=str(exc),
                topic=self._topic,
                id=id,
            )
            raise
