"""
services/shared
Shared infrastructure utilities: cache, rate limiting, circuit breaker,
idempotency, pagination, outbox, kafka/MQ, observability, retry/DLQ.
"""

from services.shared.observability import (
    extract_correlation_id,
    next_correlation_id,
    current_correlation_id,
    attach_trace_id_to_headers,
)
from services.shared.cache import (
    cache_key,
    cache_key_for_query,
    sha_signature,
    CacheBackend,
    MemoryCacheBackend,
    CacheManager,
    get_cache_manager,
)
from services.shared.rate_limit import (
    SlidingWindowRateLimiter,
    make_rate_limiter,
)
from services.shared.circuit_breaker import (
    CircuitBreaker,
    get_circuit_breaker,
)
from services.shared.idempotency import (
    idempotency_key_from_header,
    default_idempotency_key,
    IdempotencyStore,
    MemoryIdempotencyStore,
    IdempotencyHandler,
    get_idempotency_key_from_request,
    serialize_idempotency_body,
    build_idempotent_json_response,
)
from services.shared.pagination import (
    encode_cursor,
    decode_cursor,
    build_cursor_query,
    paginate_result,
    sanitize_offset_pagination,
    offset_page_meta,
    MAX_OFFSET_PAGE_SIZE,
    DEFAULT_OFFSET_PAGE_SIZE,
)
from services.shared.outbox import (
    OutboxEvent,
    OutboxStore,
    InMemoryOutboxStore,
    OutboxPublisher,
    publish_outbox_event,
)
from services.shared.kafka import (
    Message,
    envelope_from_event,
    KafkaProducerClient,
    KafkaConsumerClient,
    ProducerError,
    ConsumerConfig,
    reconnect_with_backoff,
    serialize_message,
    deserialize_message,
)
from services.shared.retry import (
    RetryConfig,
    exponential_backoff_with_jitter,
    retry_call,
    default_should_retry,
    DeadLetterStore,
    InMemoryDeadLetterStore,
    RetryWithDlq,
)

__all__ = [
    "extract_correlation_id",
    "next_correlation_id",
    "current_correlation_id",
    "attach_trace_id_to_headers",
    "cache_key",
    "cache_key_for_query",
    "sha_signature",
    "CacheBackend",
    "MemoryCacheBackend",
    "CacheManager",
    "get_cache_manager",
    "SlidingWindowRateLimiter",
    "make_rate_limiter",
    "CircuitBreaker",
    "get_circuit_breaker",
    "idempotency_key_from_header",
    "default_idempotency_key",
    "IdempotencyStore",
    "MemoryIdempotencyStore",
    "IdempotencyHandler",
    "get_idempotency_key_from_request",
    "serialize_idempotency_body",
    "build_idempotent_json_response",
    "encode_cursor",
    "decode_cursor",
    "build_cursor_query",
    "paginate_result",
    "sanitize_offset_pagination",
    "offset_page_meta",
    "MAX_OFFSET_PAGE_SIZE",
    "DEFAULT_OFFSET_PAGE_SIZE",
    "OutboxEvent",
    "OutboxStore",
    "InMemoryOutboxStore",
    "OutboxPublisher",
    "publish_outbox_event",
    "Message",
    "envelope_from_event",
    "KafkaProducerClient",
    "KafkaConsumerClient",
    "ProducerError",
    "ConsumerConfig",
    "reconnect_with_backoff",
    "serialize_message",
    "deserialize_message",
    "RetryConfig",
    "exponential_backoff_with_jitter",
    "retry_call",
    "default_should_retry",
    "DeadLetterStore",
    "InMemoryDeadLetterStore",
    "RetryWithDlq",
]
