"""
api/index.py
Flask-based Vercel serverless API.
Wraps core/database.py + core/web_executor.py — zero PySide6 dependency.
All existing Python backend logic runs unchanged.
"""

import sys
import json
from pathlib import Path

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

app = Flask(__name__)
CORS(app)

PUBLIC_DIR = ROOT / "public"

# Embedded frontend HTML (image.png already baked in as base64 data URI)
# This allows deployment even if .vercelignore removes public/ files
try:
    from api.frontend import INDEX_HTML
except ImportError:
    try:
        from frontend import INDEX_HTML  # when CWD is api/
    except ImportError:
        INDEX_HTML = None  # will fall back to file

# ── Utility ──────────────────────────────────────────────────────────────────

def _bson_safe(obj):
    """Serialize any BSON types to JSON-safe primitives."""
    return json.loads(json_util.dumps(obj))


# ── Serve frontend ────────────────────────────────────────────────────────────

@app.route("/")
def serve_index():
    # Try embedded HTML first (works even if public/ was removed by .vercelignore)
    if INDEX_HTML:
        return INDEX_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}
    # Fallback: serve from file
    return send_from_directory(str(PUBLIC_DIR), "index.html")

@app.route("/image.png")
def serve_logo():
    # Image is embedded as base64 in HTML, but serve file if available
    try:
        return send_from_directory(str(PUBLIC_DIR), "image.png")
    except Exception:
        return "", 404

@app.route("/favicon.ico")
def serve_favicon():
    return "", 204

@app.route("/<path:path>")
def serve_static(path):
    # API routes are handled above; all other paths return the SPA
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    try:
        return send_from_directory(str(PUBLIC_DIR), path)
    except Exception:
        if INDEX_HTML:
            return INDEX_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}
        return send_from_directory(str(PUBLIC_DIR), "index.html")



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

# ── API: File Operations (Query Files in queries/) ──────────────────────────

QUERIES_DIR = ROOT / "queries"

def _ensure_default_queries():
    """Ensure the queries directory has the default sample query files."""
    try:
        QUERIES_DIR.mkdir(parents=True, exist_ok=True)
        f1 = QUERIES_DIR / "01_find_paid.mongo"
        if not f1.exists():
            f1.write_text(
                "// MongoSandbox — Sample Query 1: Find Paid Transactions\n"
                "db.elite.find({\n"
                "  status: \"PAID\"\n"
                "})\n",
                encoding="utf-8"
            )
        f2 = QUERIES_DIR / "02_aggregate_pipeline.mongo"
        if not f2.exists():
            f2.write_text(
                "// MongoSandbox — Sample Query 2: Aggregation Pipeline\n"
                "db.elite.aggregate([\n"
                "  { $match: { status: \"PAID\" } },\n"
                "  {\n"
                "    $group: {\n"
                "      _id: \"$provider\",\n"
                "      totalAmount: { $sum: \"$amount\" },\n"
                "      transactionCount: { $sum: 1 }\n"
                "    }\n"
                "  },\n"
                "  { $sort: { totalAmount: -1 } }\n"
                "])\n",
                encoding="utf-8"
            )
    except Exception as e:
        print("Warning: Could not write default queries to directory:", e)

_ensure_default_queries()

@app.route("/api/files", methods=["GET"])
def api_list_files():
    """List all user query files recursively from the queries/ directory."""
    _ensure_default_queries()
    files = []
    try:
        for p in sorted(QUERIES_DIR.rglob("*")):
            # Ignore hidden files, caches, and system folders
            if p.name.startswith(".") or "__pycache__" in p.parts:
                continue
            rel_path = p.relative_to(QUERIES_DIR).as_posix()
            if p.is_dir():
                files.append({
                    "name": p.name,
                    "path": rel_path,
                    "type": "folder"
                })
            else:
                try:
                    content = p.read_text(encoding="utf-8")
                except Exception:
                    content = ""
                files.append({
                    "name": p.name,
                    "path": rel_path,
                    "type": "file",
                    "content": content
                })
    except Exception as e:
        # Fallback to hardcoded list of files if filesystem is not readable
        files = [
            {
                "name": "01_find_paid.mongo",
                "path": "01_find_paid.mongo",
                "type": "file",
                "content": "// MongoSandbox — Sample Query 1: Find Paid Transactions\ndb.elite.find({\n  status: \"PAID\"\n})\n"
            },
            {
                "name": "02_aggregate_pipeline.mongo",
                "path": "02_aggregate_pipeline.mongo",
                "type": "file",
                "content": "// MongoSandbox — Sample Query 2: Aggregation Pipeline\ndb.elite.aggregate([\n  { $match: { status: \"PAID\" } },\n  {\n    $group: {\n      _id: \"$provider\",\n      totalAmount: { $sum: \"$amount\" },\n      transactionCount: { $sum: 1 }\n    }\n  },\n  { $sort: { totalAmount: -1 } }\n])\n"
            }
        ]
    return jsonify({"files": files})

@app.route("/api/files/save", methods=["POST"])
def api_save_file():
    """Save content to a query file."""
    body = request.get_json(force=True, silent=True) or {}
    rel_path = body.get("path", "").strip()
    content = body.get("content", "")

    if not rel_path or ".." in rel_path:
        return jsonify({"status": "error", "error": "Invalid file path"}), 400

    target = QUERIES_DIR / rel_path
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return jsonify({"status": "ok", "saved_on_server": True})
    except Exception as e:
        # Expected on Vercel (read-only filesystem)
        return jsonify({"status": "ok", "saved_on_server": False, "warning": "Filesystem is read-only on server; saved in browser storage."})

@app.route("/api/files/create", methods=["POST"])
def api_create_file():
    """Create a new file or folder in queries/."""
    body = request.get_json(force=True, silent=True) or {}
    rel_path = body.get("path", "").strip()
    is_folder = body.get("is_folder", False)

    if not rel_path or ".." in rel_path:
        return jsonify({"status": "error", "error": "Invalid file path"}), 400

    target = QUERIES_DIR / rel_path
    try:
        if is_folder:
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_text("// New query\n\n", encoding="utf-8")
        return jsonify({"status": "ok", "created_on_server": True})
    except Exception as e:
        return jsonify({"status": "ok", "created_on_server": False, "warning": "Filesystem is read-only on server; created in browser storage."})

@app.route("/api/files/delete", methods=["POST"])
def api_delete_file():
    """Delete a file or folder in queries/."""
    body = request.get_json(force=True, silent=True) or {}
    rel_path = body.get("path", "").strip()

    if not rel_path or ".." in rel_path:
        return jsonify({"status": "error", "error": "Invalid file path"}), 400

    target = QUERIES_DIR / rel_path
    try:
        if target.exists():
            if target.is_dir():
                import shutil
                shutil.rmtree(target)
            else:
                target.unlink()
        return jsonify({"status": "ok", "deleted_on_server": True})
    except Exception as e:
        return jsonify({"status": "ok", "deleted_on_server": False, "warning": "Filesystem is read-only on server; deleted in browser storage."})

@app.route("/api/files/rename", methods=["POST"])
def api_rename_file():
    """Rename a file or folder in queries/."""
    body = request.get_json(force=True, silent=True) or {}
    old_path = body.get("old_path", "").strip()
    new_path = body.get("new_path", "").strip()

    if not old_path or ".." in old_path or not new_path or ".." in new_path:
        return jsonify({"status": "error", "error": "Invalid file path"}), 400

    target_old = QUERIES_DIR / old_path
    target_new = QUERIES_DIR / new_path
    try:
        if target_old.exists():
            target_new.parent.mkdir(parents=True, exist_ok=True)
            target_old.rename(target_new)
        return jsonify({"status": "ok", "renamed_on_server": True})
    except Exception as e:
        return jsonify({"status": "ok", "renamed_on_server": False, "warning": "Filesystem is read-only on server; renamed in browser storage."})


@app.route("/api/analytics", methods=["GET"])
def api_analytics():
    """Return live analytics metrics."""
    client_id = request.args.get("client_id")
    stats = analytics_tracker.get_stats(client_id=client_id)
    return jsonify(stats)


@app.route("/api/analytics/launch", methods=["POST"])
def api_analytics_launch():
    """Record an app launch / page visit."""
    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    result = analytics_tracker.record_app_launch(client_id=client_id)
    return jsonify(result)


@app.route("/api/analytics/heartbeat", methods=["POST"])
def api_analytics_heartbeat():
    """Refresh active session heartbeat without returning full metrics."""
    body = request.get_json(force=True, silent=True) or {}
    client_id = body.get("client_id")
    if client_id:
        now_ts = int(datetime.now().timestamp())
        analytics_tracker._async_run([
            ["ZADD", "active_users", str(now_ts), client_id],
            ["ZREMRANGEBYSCORE", "active_users", "-inf", str(now_ts - 90)]
        ])
    return jsonify({"status": "ok"})


# ── Vercel handler ────────────────────────────────────────────────────────────

# Vercel calls this 'app' variable
handler = app
