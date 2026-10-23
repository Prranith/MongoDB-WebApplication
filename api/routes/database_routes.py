import sys
import json
from pathlib import Path
from flask import Blueprint, request, jsonify, g
from bson import json_util

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from core.database import db_manager
from core.web_executor import execute as web_execute
from core.snippets import snippet_registry
from utils.analytics import analytics_tracker
from utils.logger import get_logger, bind_component

from services.shared.cache import get_cache_manager, cache_key_for_query, sha_signature
from services.shared.pagination import sanitize_offset_pagination, MAX_OFFSET_PAGE_SIZE
from services.shared.idempotency import get_idempotency_key_from_request, serialize_idempotency_body, IdempotencyHandler, MemoryIdempotencyStore
from services.execution.job_queue import execute as execute_job

log = bind_component(get_logger(__name__), "database_api")

database_bp = Blueprint("database_bp", __name__)

def _bson_safe(obj):
    """Serialize any BSON types to JSON-safe primitives."""
    return json.loads(json_util.dumps(obj))


def _json_response(payload, status=200):
    """Emit a JSON response with correlation context already attached upstream."""
    return jsonify(payload), status


# Idempotency for mutating sandbox runs (additive only)
_idem_store = MemoryIdempotencyStore()
_idem_handler = IdempotencyHandler(_idem_store, default_ttl_seconds=120)


# ── API: Collections ──────────────────────────────────────────────────────────

@database_bp.route("/api/collections", methods=["GET"])
def api_collections():
    """List all available collections with document counts."""
    log.debug("collections_requested", correlation_id=g.get("correlation_id"))
    names = db_manager.list_collections()
    result = []
    for name in names:
        stats = db_manager.get_collection_stats(name)
        result.append({
            "name": name,
            "count": stats.get("count", 0),
        })
    return _json_response({"collections": result})


# ── API: Query Execution ──────────────────────────────────────────────────────

# Global warm cache to keep parsed BSON docs across sequential requests on warm instances
_PARSED_CACHE = {}

def _create_temp_db(raw_query, custom_collections=None):
    """
    Create an isolated, temporary, in-memory MongoDB client per request.
    Populates it with referenced default collections plus the user's custom JSON collections.
    """
    import mongomock
    temp_client = mongomock.MongoClient()
    temp_db = temp_client[db_manager.db_name]
    
    # 1. Copy default collection datasets only if they are referenced in the query string
    # This prevents loading/copying unneeded collections (saving CPU & memory overhead)
    for coll_name in db_manager.list_collection_names():
        if coll_name in raw_query:
            global_coll = db_manager.get_collection(coll_name)
            if global_coll:
                docs = list(global_coll.find({}))
                if docs:
                    temp_db[coll_name].insert_many(docs)
                
    # 2. Load custom collections provided by user
    if custom_collections:
        for coll_name, docs in custom_collections.items():
            if not coll_name or not isinstance(docs, list):
                continue
            if docs:
                # Fast BSON parse fingerprint cache key
                first_id = docs[0].get('_id', {}).get('$oid', '') if (docs and isinstance(docs[0], dict)) else ''
                last_id = docs[-1].get('_id', {}).get('$oid', '') if (docs and isinstance(docs[-1], dict)) else ''
                cache_key = f"{coll_name}_{len(docs)}_{first_id}_{last_id}"
                
                if cache_key in _PARSED_CACHE:
                    parsed_docs = _PARSED_CACHE[cache_key]
                else:
                    # json.dumps is implemented in C and much faster than json_util.dumps
                    parsed_docs = json_util.loads(json.dumps(docs))
                    _PARSED_CACHE[cache_key] = parsed_docs
                
                temp_db[coll_name].drop()
                temp_db[coll_name].insert_many(parsed_docs)
                
    return temp_db


@database_bp.route("/api/query", methods=["POST"])
def api_query():
    """Execute a MongoDB shell query and return results."""
    body = request.get_json(force=True, silent=True) or {}
    raw_query = body.get("query", "").strip()
    limit = int(body.get("limit", 100))
    custom_collections = body.get("custom_collections", {})

    if not raw_query:
        return _json_response({"status": "error", "error": "Empty query"}, status=400)

    # Track analytics
    analytics_tracker.record_query_executed()

    job_payload = {
        "query": raw_query,
        "limit": limit,
        "custom_collections": custom_collections,
    }
    result = execute_job(
        "playground_mongodb",
        job_payload,
        lambda: (
            web_execute(
                raw_query,
                max_results=limit,
                db=_create_temp_db(raw_query, custom_collections),
            ) if custom_collections else web_execute(raw_query, max_results=limit)
        ).to_dict(),
    )
    if result.get("status") == "error" and result.get("code") == "EXECUTION_QUEUE_TIMEOUT":
        return _json_response(result, status=503)
    return _json_response(result)


# ── API: Schema ───────────────────────────────────────────────────────────────

@database_bp.route("/api/schema", methods=["GET"])
def api_schema():
    """Return inferred field types for each collection."""
    schemas = {}
    for name in db_manager.list_collections():
        schemas[name] = db_manager.get_schema_for_collection(name, sample_size=50)
    return _json_response({"schemas": schemas})


@database_bp.route("/api/schema/<collection>", methods=["GET"])
def api_schema_collection(collection):
    """Return schema for a single collection."""
    schema = db_manager.get_schema_for_collection(collection, sample_size=100)
    stats = db_manager.get_collection_stats(collection)
    analytics_tracker.record_profile_visit(collection)
    return _json_response({
        "collection": collection,
        "count": stats.get("count", 0),
        "schema": schema,
    })


# ── API: Sample Documents ─────────────────────────────────────────────────────

@database_bp.route("/api/sample/<collection>", methods=["GET"])
def api_sample(collection):
    """Return sample documents from a collection."""
    limit = int(request.args.get("limit", 5))
    limit = max(1, min(limit, MAX_OFFSET_PAGE_SIZE))
    if collection not in db_manager.list_collections():
        return _json_response({"error": f"Collection '{collection}' not found"}, status=404)
    coll = db_manager.get_collection(collection)
    if coll is None:
        return _json_response({"error": f"Collection '{collection}' not found"}, status=404)
    docs = list(coll.find().limit(limit))
    return _json_response({"collection": collection, "documents": _bson_safe(docs)})


# ── API: Snippets ─────────────────────────────────────────────────────────────

@database_bp.route("/api/snippets", methods=["GET"])
def api_snippets():
    """Return all snippets grouped by category."""
    by_cat = snippet_registry.by_category()
    result = {}
    for cat, snips in by_cat.items():
        result[cat] = [
            {
                "name": s.name,
                "prefix": s.prefix,
                "body": s.body,
                "description": s.description,
                "category": s.category,
            }
            for s in snips
        ]
    return _json_response({"snippets": result})


@database_bp.route("/api/sandbox/run", methods=["POST"])
def api_sandbox_run():
    """Execute playground code through the configured execution worker."""
    from services.compiler.compiler_service import CompilerService
    run_piston_code = CompilerService.run_piston_code
    body = request.get_json(force=True, silent=True) or {}
    language = body.get("language", "python")
    code = body.get("code", "")
    stdin = body.get("stdin", "")
    filename = body.get("filename", "")
    
    res = execute_job(
        "playground_code",
        {"language": language, "code": code, "stdin": stdin, "filename": filename},
        lambda: run_piston_code(language, code, stdin, filename),
    )
    try:
        code_val = int(res.get("code", 0))
    except (ValueError, TypeError):
        code_val = 0
        
    return _json_response({
        "status": "ok",
        "stdout": res.get("stdout", ""),
        "stderr": res.get("stderr", ""),
        "code": code_val,
        "output": res.get("output", "")
    })
