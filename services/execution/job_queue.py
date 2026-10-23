"""CloudAMQP-backed execution jobs.

The web API remains compatible with the existing synchronous callers: when
the queue is enabled it publishes a durable job, waits for the worker result,
and returns the same result shape. The worker is a separate long-lived
process (``python -m services.execution.worker``). Queue mode is enabled
automatically when ``CLOUDAMQP_URL`` is configured; set
``EXECUTION_QUEUE_ENABLED=0`` only for local development without a worker.
"""

from __future__ import annotations

import json
import os
import time
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Any, Callable

from bson import json_util

from services.shared.redis_client import get_exam_db
from services.shared.cache import get_cache_manager, sha_signature
from services.shared.idempotency import get_persistent_idempotency_handler


QUEUE_URL = os.getenv("CLOUDAMQP_URL", "").strip()
# A configured broker is opt-in by itself.  An explicit value of 0 still
# disables the queue for local development, but production deployments do not
# need a second switch after adding CLOUDAMQP_URL.
QUEUE_ENABLED = os.getenv("EXECUTION_QUEUE_ENABLED", "1").strip().lower() in {"1", "true", "yes"}
QUEUE_WAIT_SECONDS = max(5.0, float(os.getenv("EXECUTION_QUEUE_WAIT_SECONDS", "25")))
QUEUE_VISIBILITY_SECONDS = max(30, int(os.getenv("EXECUTION_QUEUE_VISIBILITY_SECONDS", "180")))

QUEUE_NAMES = {
    "playground_code": "code-execution",
    "exam_code": "code-execution",
    "exam_generate_cases": "code-execution",
    "exam_custom_verify": "code-execution",
    "playground_mongodb": "mongodb-execution",
    "exam_mongodb": "mongodb-execution",
    "playground_sql": "sql-execution",
    "exam_sql": "sql-execution",
}
_execution_idem = get_persistent_idempotency_handler(ttl_seconds=300)


def enabled() -> bool:
    """Return whether a configured CloudAMQP broker should receive jobs."""
    return bool(QUEUE_ENABLED and QUEUE_URL)


def _jobs():
    db = get_exam_db()
    if db is None:
        raise RuntimeError("Execution job database is unavailable")
    collection = db[os.getenv("EXECUTION_JOB_COLLECTION", "execution_jobs")]
    try:
        collection.create_index("createdAt", expireAfterSeconds=86400)
        collection.create_index("status")
        collection.create_index([("kind", 1), ("idempotencyKey", 1)], unique=True, sparse=True)
    except Exception:
        pass
    return collection


def _safe_json(value: Any) -> Any:
    return json.loads(json_util.dumps(value, default=str))


def _connection():
    if not QUEUE_URL:
        raise RuntimeError("CLOUDAMQP_URL is not configured")
    try:
        import pika
    except ImportError as exc:
        raise RuntimeError("pika is required for CloudAMQP execution queues") from exc
    params = pika.URLParameters(QUEUE_URL)
    params.heartbeat = 30
    params.blocked_connection_timeout = 10
    return pika, pika.BlockingConnection(params)


def enqueue(kind: str, payload: dict, idempotency_key: str | None = None) -> str:
    queue_name = QUEUE_NAMES.get(kind)
    if not queue_name:
        raise ValueError(f"Unsupported execution job type: {kind}")
    fingerprint = sha_signature(kind, _safe_json(payload))
    stable_key = None
    if idempotency_key:
        stable_key = hashlib.sha256(f"{kind}|{idempotency_key}".encode()).hexdigest()
    job_id = f"job_{stable_key or uuid.uuid4().hex}"
    now = datetime.now(timezone.utc)
    jobs = _jobs()
    doc = {"_id": job_id, "kind": kind, "payload": _safe_json(payload),
           "status": "queued", "createdAt": now, "updatedAt": now,
           "fingerprint": fingerprint}
    if stable_key:
        doc["idempotencyKey"] = stable_key
    try:
        jobs.insert_one(doc)
    except Exception as exc:
        existing = jobs.find_one({"_id": job_id}) if stable_key else None
        if not existing:
            raise
        if existing.get("fingerprint") != fingerprint:
            raise ValueError("Idempotency key was already used with a different execution request") from exc
        return job_id
    pika, connection = _connection()
    try:
        channel = connection.channel()
        channel.queue_declare(queue=queue_name, durable=True)
        channel.confirm_delivery()
        channel.basic_publish(
            exchange="",
            routing_key=queue_name,
            body=json.dumps({"jobId": job_id, "kind": kind}, separators=(",", ":")).encode(),
            properties=pika.BasicProperties(delivery_mode=2, content_type="application/json"),
        )
    except Exception:
        _jobs().update_one({"_id": job_id}, {"$set": {"status": "failed", "error": "Unable to publish execution job", "updatedAt": datetime.now(timezone.utc)}})
        raise
    finally:
        connection.close()
    return job_id


def wait_for_result(job_id: str, timeout: float | None = None) -> dict:
    deadline = time.monotonic() + (timeout or QUEUE_WAIT_SECONDS)
    collection = _jobs()
    while time.monotonic() < deadline:
        job = collection.find_one({"_id": job_id}) or {}
        status = job.get("status")
        if status == "completed":
            return job.get("result") or {"status": "ok"}
        if status == "failed":
            return {"status": "error", "error": job.get("error", "Execution job failed"), "code": "EXECUTION_JOB_FAILED"}
        time.sleep(0.25)
    return {"status": "error", "error": "Execution queue timed out while waiting for a worker.", "code": "EXECUTION_QUEUE_TIMEOUT", "jobId": job_id}


def execute(kind: str, payload: dict, direct: Callable[[], dict], idempotency_key: str | None = None) -> dict:
    """Run directly when disabled, otherwise enqueue and wait for a result."""
    # Read-only database work is safe to cache briefly. Code execution is
    # deliberately never cached because it may depend on time or randomness.
    if kind in {"playground_mongodb", "exam_mongodb", "playground_sql", "exam_sql"}:
        cache = get_cache_manager(default_ttl_seconds=5)
        cache_key = f"execution:{kind}:{sha_signature(_safe_json(payload))}"
        return cache.get_or_load(cache_key, lambda: _execute_uncached(kind, payload, direct, idempotency_key), ttl_seconds=5)
    return _execute_uncached(kind, payload, direct, idempotency_key)


def _execute_uncached(kind: str, payload: dict, direct: Callable[[], dict], idempotency_key: str | None = None) -> dict:
    if idempotency_key:
        replay = _execution_idem.check_replay(idempotency_key, method="POST", path=f"/execution/{kind}")
        if replay:
            return replay[1]
    result = direct() if not enabled() else wait_for_result(enqueue(kind, payload, idempotency_key))
    if idempotency_key:
        _execution_idem.record_response(idempotency_key, method="POST", path=f"/execution/{kind}", status_code=200, body=result)
    return result


def _dispatch(kind: str, payload: dict) -> Any:
    """Execute one job. Imports stay inside the worker path to avoid cycles."""
    if kind == "playground_code":
        from services.compiler.compiler_service import CompilerService
        return CompilerService.run_piston_code(payload["language"], payload["code"], payload.get("stdin", ""), payload.get("filename", ""), payload.get("strictJavaFilename", False))
    if kind == "exam_code":
        from services.submission.submission_service import SubmissionService
        return {"results": SubmissionService.run_piston_code(payload["roomId"], payload.get("questionId"), payload["language"], payload["code"], payload.get("stdins", ""))}
    if kind == "exam_generate_cases":
        from services.submission.submission_service import SubmissionService
        return {"outputs": SubmissionService.generate_test_cases(payload["language"], payload["code"], payload.get("inputs", []), payload.get("templateType", "scratch"), payload.get("driverCode", ""))}
    if kind == "exam_custom_verify":
        from services.submission.submission_service import SubmissionService
        return SubmissionService.verify_custom_input(payload["roomId"], payload["questionId"], payload["language"], payload["code"], payload["stdin"])
    if kind == "playground_mongodb":
        from api.routes.database_routes import _create_temp_db
        from core.web_executor import execute as web_execute
        temp_db = _create_temp_db(payload["query"], payload.get("custom_collections", {})) if payload.get("custom_collections") else None
        return web_execute(payload["query"], max_results=payload.get("limit", 100), db=temp_db).to_dict()
    if kind == "exam_mongodb":
        from services.submission.submission_service import SubmissionService
        return SubmissionService.execute_room_query(payload["roomId"], payload.get("datasetIds", []), payload["query"], max_results=payload.get("limit", 100000))
    if kind == "playground_sql":
        from services.sql.sql_service import SqlService
        return SqlService.execute_query(payload["query"], payload.get("limit", 500), payload.get("tables"))
    if kind == "exam_sql":
        from services.sql.sql_service import SqlService
        return SqlService.execute_room_query(payload["roomId"], payload.get("datasetIds", []), payload["query"], limit=payload.get("limit", 1000))
    raise ValueError(f"Unsupported execution job type: {kind}")


def process(job_id: str, kind: str, payload: dict | None = None) -> str:
    collection = _jobs()
    if payload is None:
        stored = collection.find_one({"_id": job_id}) or {}
        payload = stored.get("payload") or {}
    now = datetime.now(timezone.utc)
    claimed = collection.update_one(
        {"_id": job_id, "status": "queued"},
        {"$set": {"status": "running", "startedAt": now, "updatedAt": now}},
    )
    if not claimed.modified_count:
        return "skipped"
    try:
        result = _safe_json(_dispatch(kind, payload))
        collection.update_one({"_id": job_id}, {"$set": {"status": "completed", "result": result, "finishedAt": datetime.now(timezone.utc), "updatedAt": datetime.now(timezone.utc)}})
        return "completed"
    except Exception as exc:
        collection.update_one({"_id": job_id}, {"$set": {"status": "failed", "error": str(exc)[:1000], "finishedAt": datetime.now(timezone.utc), "updatedAt": datetime.now(timezone.utc)}})
        return "failed"

