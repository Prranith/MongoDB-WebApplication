import sys
import json
from pathlib import Path
from flask import Blueprint, request, jsonify
from bson import json_util

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from core.database import db_manager
from core.web_executor import execute as web_execute
from core.snippets import snippet_registry
from utils.analytics import analytics_tracker

database_bp = Blueprint("database_bp", __name__)

def _bson_safe(obj):
    """Serialize any BSON types to JSON-safe primitives."""
    return json.loads(json_util.dumps(obj))

# ── API: Collections ──────────────────────────────────────────────────────────

@database_bp.route("/api/collections", methods=["GET"])
def api_collections():
    """List all available collections with document counts."""
    names = db_manager.list_collections()
    result = []
    for name in names:
        stats = db_manager.get_collection_stats(name)
        result.append({
            "name": name,
            "count": stats.get("count", 0),
        })
    return jsonify({"collections": result})


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
        return jsonify({"status": "error", "error": "Empty query"}), 400

    # Track analytics
    analytics_tracker.record_query_executed()

    if custom_collections:
        temp_db = _create_temp_db(raw_query, custom_collections)
        result = web_execute(raw_query, max_results=limit, db=temp_db)
    else:
        result = web_execute(raw_query, max_results=limit)

    payload = result.to_dict()
    return jsonify(payload)


# ── API: Schema ───────────────────────────────────────────────────────────────

@database_bp.route("/api/schema", methods=["GET"])
def api_schema():
    """Return inferred field types for each collection."""
    schemas = {}
    for name in db_manager.list_collections():
        schemas[name] = db_manager.get_schema_for_collection(name, sample_size=50)
    return jsonify({"schemas": schemas})


@database_bp.route("/api/schema/<collection>", methods=["GET"])
def api_schema_collection(collection):
    """Return schema for a single collection."""
    schema = db_manager.get_schema_for_collection(collection, sample_size=100)
    stats = db_manager.get_collection_stats(collection)
    analytics_tracker.record_profile_visit(collection)
    return jsonify({
        "collection": collection,
        "count": stats.get("count", 0),
        "schema": schema,
    })


# ── API: Sample Documents ─────────────────────────────────────────────────────

@database_bp.route("/api/sample/<collection>", methods=["GET"])
def api_sample(collection):
    """Return sample documents from a collection."""
    limit = int(request.args.get("limit", 5))
    coll = db_manager.get_collection(collection)
    if coll is None:
        return jsonify({"error": f"Collection '{collection}' not found"}), 404
    docs = list(coll.find().limit(limit))
    return jsonify({"collection": collection, "documents": _bson_safe(docs)})


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
    return jsonify({"snippets": result})


@database_bp.route("/api/sandbox/run", methods=["POST"])
def api_sandbox_run():
    """Execute arbitrary code using Paiza API for playground mode."""
    from api.routes.exam_routes import run_piston_code
    body = request.get_json(force=True, silent=True) or {}
    language = body.get("language", "python")
    code = body.get("code", "")
    stdin = body.get("stdin", "")
    
    res = run_piston_code(language, code, stdin)
    try:
        code_val = int(res.get("code", 0))
    except (ValueError, TypeError):
        code_val = 0
        
    return jsonify({
        "status": "ok",
        "stdout": res.get("stdout", ""),
        "stderr": res.get("stderr", ""),
        "code": code_val,
        "output": res.get("output", "")
    })
