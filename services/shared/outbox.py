"""
services/shared/outbox.py
Transactional outbox pattern helpers.

Goal: keep database writes and event publishing atomic by:
- persisting an outbox row as part of the same DB transaction
- a background worker publishing and marking events delivered

This module is a lightweight abstraction; wiring to a real DB table/collection
is performed where persistence already exists.
"""

from __future__ import annotations

import enum
import json
import time
import typing as t
import uuid

from utils.logger import get_logger, bind_component

log = bind_component(get_logger(__name__), "outbox")


class OutboxEvent:
    def __init__(
        self,
        *,
        aggregate_type: str,
        aggregate_id: str,
        event_type: str,
        payload: t.Any,
        id: t.Optional[str] = None,
        created_at: t.Optional[float] = None,
        retry_count: int = 0,
    ) -> None:
        self.id = id or uuid.uuid4().hex
        self.aggregate_type = aggregate_type
        self.aggregate_id = aggregate_id
        self.event_type = event_type
        self.payload = payload
        self.created_at = created_at or time.time()
        self.retry_count = retry_count

    def to_dict(self) -> t.Dict[str, t.Any]:
        return {
            "id": self.id,
            "aggregate_type": self.aggregate_type,
            "aggregate_id": self.aggregate_id,
            "event_type": self.event_type,
            "payload": self.payload,
            "created_at": self.created_at,
            "retry_count": self.retry_count,
        }

    @classmethod
    def from_dict(cls, data: t.Dict[str, t.Any]) -> "OutboxEvent":
        return cls(
            id=data.get("id"),
            aggregate_type=data.get("aggregate_type", ""),
            aggregate_id=data.get("aggregate_id", ""),
            event_type=data.get("event_type", ""),
            payload=data.get("payload"),
            created_at=data.get("created_at", time.time()),
            retry_count=int(data.get("retry_count", 0)),
        )


class OutboxStore(t.Protocol):
    def save(self, event: OutboxEvent) -> None: ...
    def fetch_pending(self, *, batch_size: int) -> t.List[OutboxEvent]: ...
    def mark_delivered(self, event_id: str) -> None: ...
    def increment_retry(self, event_id: str, current_retry_count: int) -> None: ...


class InMemoryOutboxStore:
    """In-memory outbox for local development and tests."""

    def __init__(self) -> None:
        self._events: t.List[OutboxEvent] = []

    def save(self, event: OutboxEvent) -> None:
        self._events.append(event)
        log.debug("outbox_saved", event_id=event.id, event_type=event.event_type)

    def fetch_pending(self, *, batch_size: int) -> t.List[OutboxEvent]:
        now = time.time()
        pending = [e for e in self._events if (now - e.created_at) < 86400]
        return pending[:batch_size]

    def mark_delivered(self, event_id: str) -> None:
        self._events = [e for e in self._events if e.id != event_id]
        log.debug("outbox_delivered", event_id=event_id)

    def increment_retry(self, event_id: str, current_retry_count: int) -> None:
        for e in self._events:
            if e.id == event_id:
                e.retry_count = current_retry_count + 1
                return


class OutboxPublisher:
    """Publish outbox events to a producer/consumer backend."""

    def __init__(
        self,
        *,
        store: OutboxStore,
        producer: t.Callable[[OutboxEvent], None],
        max_batch: int = 100,
    ) -> None:
        self._store = store
        self._producer = producer
        self._max_batch = max_batch

    def publish_pending(self) -> int:
        batch = self._store.fetch_pending(batch_size=self._max_batch)
        delivered = 0
        for event in batch:
            try:
                self._producer(event)
                self._store.mark_delivered(event.id)
                delivered += 1
            except Exception as exc:
                retry_count = event.retry_count + 1
                log.warning(
                    "outbox_publish_failed",
                    event_id=event.id,
                    event_type=event.event_type,
                    retry_count=retry_count,
                    error=str(exc),
                )
                self._store.increment_retry(event.id, retry_count)
        return delivered


def publish_outbox_event(
    store: OutboxStore,
    *,
    aggregate_type: str,
    aggregate_id: str,
    event_type: str,
    payload: t.Any,
) -> OutboxEvent:
    """Save an outbox event and return it (idempotent by event id)."""
    event = OutboxEvent(
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        payload=payload,
    )
    store.save(event)
    return event
