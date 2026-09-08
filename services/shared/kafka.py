"""
services/shared/kafka.py
Kafka (and generic MQ) producer/consumer abstractions.

These are intentionally abstract enough to be swapped for RabbitMQ later.
They support:
- topic/partition routing
- consumer groups
- automatic reconnection back-off
- message headers including correlation ids
- retry + DLQ integration

No existing routes/services are changed here.
"""

from __future__ import annotations

import json
import time
import typing as t
import uuid

from utils.logger import get_logger, bind_component
from services.shared.retry import RetryConfig, retry_call, InMemoryDeadLetterStore

log = bind_component(get_logger(__name__), "kafka")


# ---------------------------------------------------------------------------
# Message envelope
# ---------------------------------------------------------------------------

class Message(t.NamedTuple):
    key: t.Optional[str]
    value: t.Any
    headers: t.Dict[str, str]
    topic: str
    partition: t.Optional[int]
    correlation_id: t.Optional[str]


def envelope_from_event(
    event: t.Any,
    *,
    topic: str,
    key: t.Optional[str] = None,
    correlation_id: t.Optional[str] = None,
    headers: t.Optional[t.Dict[str, str]] = None,
) -> Message:
    return Message(
        key=key,
        value=event,
        headers={
            "correlation_id": correlation_id or "",
            **(headers or {}),
        },
        topic=topic,
        partition=None,
        correlation_id=correlation_id,
    )


# ---------------------------------------------------------------------------
# Producer abstraction
# ---------------------------------------------------------------------------

class BaseProducer(t.Protocol):
    def send(self, topic: str, value: t.Any, *, key: t.Optional[str] = None, headers: t.Optional[t.Dict[str, str]] = None) -> t.Any: ...
    def flush(self, timeout: float = 5.0) -> None: ...
    def close(self) -> None: ...


class ProducerError(Exception):
    pass


class KafkaProducerClient:
    """Thin producer wrapper with retry + DLQ + header propagation."""

    def __init__(
        self,
        producer: BaseProducer,
        *,
        dlq: t.Optional[t.Any] = None,
        topic_prefix: str = "",
        correlation_id: t.Optional[str] = None,
    ) -> None:
        self._producer = producer
        self._dlq = dlq
        self._topic_prefix = topic_prefix.rstrip(".")
        self._correlation_id = correlation_id

    def _topic(self, name: str) -> str:
        if self._topic_prefix:
            return f"{self._topic_prefix}.{name}"
        return name

    def send(
        self,
        topic: str,
        value: t.Any,
        *,
        key: t.Optional[str] = None,
        correlation_id: t.Optional[str] = None,
        headers: t.Optional[t.Dict[str, str]] = None,
    ) -> t.Any:
        cid = correlation_id or self._correlation_id or uuid.uuid4().hex
        merged_headers = {"correlation_id": cid, **(headers or {})}

        def _produce() -> t.Any:
            try:
                return self._producer.send(
                    self._topic(topic),
                    value,
                    key=key,
                    headers=merged_headers,
                )
            except Exception as exc:
                raise ProducerError(str(exc)) from exc

        try:
            future = retry_call(
                _produce,
                config=RetryConfig(
                    max_attempts=3,
                    base_seconds=0.1,
                    max_seconds=30.0,
                    retry_on=lambda exc: isinstance(exc, ProducerError),
                ),
            )
            return future
        except ProducerError as exc:
            if self._dlq is not None:
                self._dlq.enqueue(
                    payload={"topic": topic, "key": key, "value": value, "headers": merged_headers},
                    reason=str(exc),
                    topic=self._topic(topic),
                )
            raise

    def flush(self, timeout: float = 5.0) -> None:
        try:
            self._producer.flush(timeout=timeout)
        except Exception as exc:
            log.error("producer_flush_failed", error=str(exc))


# ---------------------------------------------------------------------------
# Consumer abstraction
# ---------------------------------------------------------------------------

class ConsumerConfig(t.NamedTuple):
    group_id: str
    auto_offset_reset: str = "earliest"
    max_poll_records: int = 500
    session_timeout_ms: int = 45000
    heartbeat_interval_ms: int = 15000


class BaseConsumer(t.Protocol):
    def subscribe(self, topics: t.List[str]) -> None: ...
    def poll(self, timeout_ms: int = 1000) -> t.Optional[t.Any]: ...
    def commit(self, offsets: t.Any) -> None: ...
    def close(self) -> None: ...


class KafkaConsumerClient:
    """Consumer wrapper with automatic reconnection and header-based tracing."""

    def __init__(
        self,
        consumer: BaseConsumer,
        *,
        topics: t.List[str],
        config: ConsumerConfig,
        processor: t.Callable[[Message], t.Any],
        retry_config: RetryConfig = RetryConfig(max_attempts=3),
        poll_timeout_ms: int = 1000,
    ) -> None:
        self._consumer = consumer
        self._topics = topics
        self._config = config
        self._processor = processor
        self._retry_config = retry_config
        self._poll_timeout_ms = poll_timeout_ms
        self._running = False

    def start(self) -> None:
        self._consumer.subscribe(self._topics)
        self._running = True
        log.info("consumer_started", group_id=self._config.group_id, topics=self._topics)

    def stop(self) -> None:
        self._running = False
        try:
            self._consumer.close()
        except Exception as exc:
            log.error("consumer_close_failed", error=str(exc))

    def run_once(self) -> int:
        """Process a single poll batch. Returns number of messages processed."""
        if not self._running:
            return 0
        message = self._consumer.poll(timeout_ms=self._poll_timeout_ms)
        if message is None:
            return 0
        try:
            value = message.value()
            headers = getattr(message, "headers", {}) or {}
            key = getattr(message, "key", None)
            correlation_id = headers.get("correlation_id") if isinstance(headers, dict) else None
            evt = Message(
                key=key,
                value=value,
                headers=headers,
                topic=getattr(message, "topic", ""),
                partition=getattr(message, "partition", None),
                correlation_id=correlation_id,
            )
            retry_call(self._processor, evt, config=self._retry_config)
            self._consumer.commit(message)
            return 1
        except Exception as exc:
            log.error("consumer_process_failed", error=str(exc), topic=getattr(message, "topic", ""))
            return 0


# ---------------------------------------------------------------------------
# Reconnection helper
# ---------------------------------------------------------------------------

def reconnect_with_backoff(
    factory: t.Callable[[], t.Any],
    *,
    max_attempts: int = 5,
    base_seconds: float = 1.0,
    max_seconds: float = 30.0,
) -> t.Any:
    """Create or reconnect a client with backoff."""
    last_exc: t.Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            return factory()
        except Exception as exc:
            last_exc = exc
            delay = min(max_seconds, base_seconds * (2 ** attempt))
            delay = delay * (0.5 + random.random()) if attempt > 0 else delay
            log.warning(
                "reconnect_attempt",
                attempt=attempt + 1,
                max_attempts=max_attempts,
                delay_seconds=round(delay, 3),
                error=str(exc),
            )
            time.sleep(delay)
    raise RuntimeError("reconnect_failed") from last_exc


# ---------------------------------------------------------------------------
# JSON serialization helpers
# ---------------------------------------------------------------------------

def serialize_message(value: t.Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)


def deserialize_message(value: t.Any) -> t.Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return value
    return value
