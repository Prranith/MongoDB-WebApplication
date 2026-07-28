import sys
import shutil
from pathlib import Path
from flask import Blueprint, request, jsonify

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

QUERIES_DIR = ROOT / "queries"

file_bp = Blueprint("file_bp", __name__)

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

@file_bp.route("/api/files", methods=["GET"])
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

@file_bp.route("/api/files/save", methods=["POST"])
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

@file_bp.route("/api/files/create", methods=["POST"])
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

@file_bp.route("/api/files/delete", methods=["POST"])
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
                shutil.rmtree(target)
            else:
                target.unlink()
        return jsonify({"status": "ok", "deleted_on_server": True})
    except Exception as e:
        return jsonify({"status": "ok", "deleted_on_server": False, "warning": "Filesystem is read-only on server; deleted in browser storage."})

@file_bp.route("/api/files/rename", methods=["POST"])
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
