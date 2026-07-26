"""
api/index.py
Flask-based Vercel serverless API.
Wraps core/database.py + core/web_executor.py — zero PySide6 dependency.
All existing Python backend logic runs unchanged.
"""

import sys
import json
from pathlib import Path
from functools import wraps

# Add project root so all core/ and utils/ imports work
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from bson import json_util, ObjectId
from datetime import datetime

# Import existing Python backend (no PySide6 involved)
from core.database import db_manager
from core.web_executor import execute as web_execute
from core.snippets import snippet_registry
from utils.analytics import analytics_tracker

app = Flask(__name__, static_folder=str(ROOT / "public"), static_url_path="")
CORS(app)

# ── Utility ──────────────────────────────────────────────────────────────────

def _bson_safe(obj):
    """Serialize any BSON types to JSON-safe primitives."""
    return json.loads(json_util.dumps(obj))


# ── Serve frontend ────────────────────────────────────────────────────────────

@app.route("/")
def serve_index():
    return send_from_directory(str(ROOT / "public"), "index.html")


@app.route("/<path:path>")
def serve_static(path):
    try:
        return send_from_directory(str(ROOT / "public"), path)
    except Exception:
        return send_from_directory(str(ROOT / "public"), "index.html")


# ── API: Collections ──────────────────────────────────────────────────────────

@app.route("/api/collections", methods=["GET"])
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

@app.route("/api/query", methods=["POST"])
def api_query():
    """Execute a MongoDB shell query and return results."""
    body = request.get_json(force=True, silent=True) or {}
    raw_query = body.get("query", "").strip()
    limit = int(body.get("limit", 100))

    if not raw_query:
        return jsonify({"status": "error", "error": "Empty query"}), 400

    # Track analytics
    analytics_tracker.record_query_executed()

    result = web_execute(raw_query, max_results=limit)
    payload = result.to_dict()
    return jsonify(payload)


# ── API: Schema ───────────────────────────────────────────────────────────────

@app.route("/api/schema", methods=["GET"])
def api_schema():
    """Return inferred field types for each collection."""
    schemas = {}
    for name in db_manager.list_collections():
        schemas[name] = db_manager.get_schema_for_collection(name, sample_size=50)
    return jsonify({"schemas": schemas})


@app.route("/api/schema/<collection>", methods=["GET"])
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

@app.route("/api/sample/<collection>", methods=["GET"])
def api_sample(collection):
    """Return sample documents from a collection."""
    limit = int(request.args.get("limit", 5))
    coll = db_manager.get_collection(collection)
    if coll is None:
        return jsonify({"error": f"Collection '{collection}' not found"}), 404
    docs = list(coll.find().limit(limit))
    return jsonify({"collection": collection, "documents": _bson_safe(docs)})


# ── API: Snippets ─────────────────────────────────────────────────────────────

@app.route("/api/snippets", methods=["GET"])
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


# ── API: Analytics ────────────────────────────────────────────────────────────

@app.route("/api/analytics", methods=["GET"])
def api_analytics():
    """Return live analytics metrics."""
    stats = analytics_tracker.get_stats()
    return jsonify(stats)


@app.route("/api/analytics/launch", methods=["POST"])
def api_analytics_launch():
    """Record an app launch / page visit."""
    result = analytics_tracker.record_app_launch()
    return jsonify(result)


# ── Vercel handler ────────────────────────────────────────────────────────────

# Vercel calls this 'app' variable
handler = app
