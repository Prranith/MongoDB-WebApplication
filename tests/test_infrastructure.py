"""
tests/test_infrastructure.py
Quick coverage for the new distributed-systems utilities:
cache, pagination, idempotency, retry/DLQ, outbox, circuit breaker.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from services.shared.cache import (
    MemoryCacheBackend,
    CacheManager,
    cache_key,
    cache_key_for_query,
    sha_signature,
    get_cache_manager,
)
from services.shared.pagination import (
    encode_cursor,
    decode_cursor,
    paginate_result,
    sanitize_offset_pagination,
    offset_page_meta,
    MAX_OFFSET_PAGE_SIZE,
    DEFAULT_OFFSET_PAGE_SIZE,
)
from services.shared.idempotency import (
    MemoryIdempotencyStore,
    IdempotencyHandler,
    idempotency_key_from_header,
    serialize_idempotency_body,
)
from services.shared.retry import (
    RetryConfig,
    exponential_backoff_with_jitter,
    InMemoryDeadLetterStore,
    RetryWithDlq,
)
from services.shared.outbox import OutboxEvent, InMemoryOutboxStore, publish_outbox_event, OutboxPublisher
from services.shared.circuit_breaker import CircuitBreaker, get_circuit_breaker
from services.shared.rate_limit import SlidingWindowRateLimiter, make_rate_limiter
from services.shared.kafka import Message, envelope_from_event


def test_cache_key_naming():
    assert cache_key("exam", "room", "MNG-123") == "exam:room:MNG-123"
    assert cache_key("exam", "room", "MNG-123", version="v2") == "exam:room:MNG-123:v2"
    assert cache_key_for_query("exam", query_sha="abc", params_sha="123") == "exam:query:abc:params:123"


def test_sha_signature():
    assert sha_signature("a", "b") == sha_signature("a", "b")
    assert sha_signature("a", "b") != sha_signature("a", "c")


def test_memory_cache_backend_ttl():
    backend = MemoryCacheBackend()
    backend.set("k", "v", ttl_seconds=1)
    assert backend.get("k") == "v"
    import time
    time.sleep(1.1)
    assert backend.get("k") is None


def test_cache_manager_singleflight():
    backend = MemoryCacheBackend()
    manager = CacheManager(backend, default_ttl_seconds=60, singleflight_enabled=True)

    calls = {"count": 0}

    def loader():
        calls["count"] += 1
        return calls["count"]

    results = [manager.get_or_load("shared", loader) for _ in range(5)]
    assert all(r == 1 for r in results)
    assert calls["count"] == 1


def test_pagination_cursor_roundtrip():
    payload = {"id": "abc", "created_at": 123}
    encoded = encode_cursor(payload)
    decoded = decode_cursor(encoded)
    assert decoded == payload


def test_pagination_result_truncation():
    rows = [{"id": str(i)} for i in range(5)]
    items, meta = paginate_result(rows, limit=2)
    assert len(items) == 2
    assert meta.has_more is True
    assert meta.next_cursor is not None


def test_offset_pagination_caps():
    params = sanitize_offset_pagination(page=1, page_size=5000)
    assert params["page_size"] <= MAX_OFFSET_PAGE_SIZE
    assert params["page_size"] == MAX_OFFSET_PAGE_SIZE


def test_idempotency_key_derivation():
    key = idempotency_key_from_header("my-key", method="POST", path="/foo")
    assert key is not None
    assert key.startswith("idem:")


def test_idempotency_handler_replay():
    store = MemoryIdempotencyStore()
    handler = IdempotencyHandler(store, default_ttl_seconds=60)
    assert handler.check_replay(None, method="POST", path="/x") is None
    handler.record_response("abc", method="POST", path="/x", status_code=201, body={"ok": True})
    replay = handler.check_replay("abc", method="POST", path="/x")
    assert replay == (201, {"ok": True})


def test_retry_backoff_and_dlq():
    store = InMemoryDeadLetterStore()
    called = {"n": 0}

    def flaky():
        called["n"] += 1
        if called["n"] < 3:
            raise ConnectionError("transient")
        return "ok"

    result = RetryWithDlq(dlq=store, topic="test", config=RetryConfig(max_attempts=3)).execute(flaky, payload="p")
    assert result == "ok"
    assert called["n"] == 3
    assert len(store._store) == 0


def test_retry_dlq_on_persistent_failure():
    store = InMemoryDeadLetterStore()

    def always_fails():
        raise ValueError("permanent")

    try:
        RetryWithDlq(dlq=store, topic="test", config=RetryConfig(max_attempts=2)).execute(always_fails, payload="p")
    except ValueError:
        pass

    assert len(store._store) == 1
    assert store._store[0]["reason"] == "permanent"


def test_outbox_event_roundtrip():
    event = OutboxEvent(aggregate_type="room", aggregate_id="r1", event_type="created", payload={"title": "T1"})
    d = event.to_dict()
    restored = OutboxEvent.from_dict(d)
    assert restored.id == event.id
    assert restored.aggregate_type == event.aggregate_type


def test_outbox_publish_and_deliver():
    store = InMemoryOutboxStore()

    delivered = []

    def producer(event):
        delivered.append(event)

    publisher = OutboxPublisher(store=store, producer=producer, max_batch=10)
    publish_outbox_event(store, aggregate_type="room", aggregate_id="r1", event_type="created", payload={})
    count = publisher.publish_pending()
    assert count == 1
    assert len(delivered) == 1


def test_circuit_breaker_transitions():
    cb = CircuitBreaker(failure_threshold=3, recovery_timeout_seconds=0.05, half_open_max_calls=1)

    assert cb.allow_request() is True
    cb.record_failure()
    cb.record_failure()
    assert cb.allow_request() is True
    cb.record_failure()
    assert cb.allow_request() is False

    import time
    time.sleep(0.1)
    assert cb.allow_request() is True
    cb.record_success()
    assert cb.allow_request() is True


def test_rate_limiter_basic():
    limiter = make_rate_limiter()
    allowed, count, retry_after = limiter.check("u1", max_requests=3)
    assert allowed is True
    assert count == 1
    limiter.check("u1", max_requests=3)
    limiter.check("u1", max_requests=3)
    allowed, count, retry_after = limiter.check("u1", max_requests=3)
    assert allowed is False


def test_kafka_message_envelope():
    msg = envelope_from_event(
        {"x": 1},
        topic="rooms",
        key="r1",
        correlation_id="cid-1",
    )
    assert msg.topic == "rooms"
    assert msg.key == "r1"
    assert msg.headers["correlation_id"] == "cid-1"
    assert msg.value == {"x": 1}


def test_serialize_idempotency_body():
    body = {"list": [1, 2], "now": float("nan")}
    out = serialize_idempotency_body(body)
    assert isinstance(out, dict)
    assert out["list"] == [1, 2]
