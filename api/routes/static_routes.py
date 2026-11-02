import json
import sys
from pathlib import Path
from flask import Blueprint, request, send_from_directory, jsonify

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

try:
    from api.frontend import INDEX_HTML
except ImportError:
    try:
        from frontend import INDEX_HTML
    except ImportError:
        INDEX_HTML = None

PUBLIC_DIR = ROOT / "public"

static_bp = Blueprint("static_bp", __name__)

# These are real browser entry points for the existing interactive shell. The
# shell is intentionally reused so editor, exam, meeting, and auth behavior
# stays identical while each major screen gets a stable URL.
_APP_ROUTES = {
    "/": {"name": "home", "initial": "home"},
    "/home": {"name": "home", "initial": "home"},
    "/workspaceide": {"name": "workspace", "initial": "workspace"},
    "/workspace": {"name": "workspace", "initial": "workspace"},
    "/dbexplorer": {"name": "dbexplorer", "initial": "db"},
    "/history": {"name": "history", "initial": "history"},
    "/guide": {"name": "guide", "initial": "guide"},
    "/search": {"name": "search", "initial": "search"},
    "/examportal": {"name": "examportal", "initial": "examportal"},
    "/createRoom": {"name": "create-room", "initial": "create-room"},
    "/createExam": {"name": "create-exam", "initial": "create-exam"},
    "/liveLeaderBoard": {"name": "leaderboard", "initial": "leaderboard"},
    "/joinexam": {"name": "join-exam", "initial": "join-exam"},
    "/exampaper": {"name": "exam-paper", "initial": "exam-paper"},
    "/offlineViewer": {"name": "offline-viewer", "initial": "offline-viewer"},
    "/meeting": {"name": "meeting", "initial": "meeting"},
    "/createMeet": {"name": "create-meeting", "initial": "create-meeting"},
    "/joinmeet": {"name": "join-meeting", "initial": "join-meeting"},
}


def _app_shell(route="/"):
    if not INDEX_HTML:
        return None
    config = _APP_ROUTES.get(route, {"name": "app", "initial": "home"})
    bootstrap = '<script>window.__CODELEAF_ROUTE = ' + json.dumps(config, separators=(",", ":")) + ';</script>'
    return INDEX_HTML.replace("</head>", bootstrap + "</head>", 1)


def _serve_app_route(route):
    shell = _app_shell(route)
    if shell:
        return shell, 200, {"Content-Type": "text/html; charset=utf-8"}
    return send_from_directory(str(PUBLIC_DIR), "index.html")

@static_bp.route("/admin")
def serve_admin():
    """Serve the separate admin control-plane shell."""
    return send_from_directory(str(PUBLIC_DIR), "admin.html")

@static_bp.route("/admin/<path:path>")
def serve_admin_asset(path):
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(str(PUBLIC_DIR), path)

@static_bp.route("/")
def serve_index():
    # Try embedded HTML first (works even if public/ was removed by .vercelignore)
    if INDEX_HTML:
        return _serve_app_route("/")
    # Fallback: serve from file
    return send_from_directory(str(PUBLIC_DIR), "index.html")


@static_bp.route("/home")
@static_bp.route("/workspaceide")
@static_bp.route("/workspace")
@static_bp.route("/dbexplorer")
@static_bp.route("/history")
@static_bp.route("/guide")
@static_bp.route("/search")
@static_bp.route("/examportal")
@static_bp.route("/createRoom")
@static_bp.route("/createExam")
@static_bp.route("/liveLeaderBoard")
@static_bp.route("/joinexam")
@static_bp.route("/exampaper")
@static_bp.route("/offlineViewer")
@static_bp.route("/meeting")
@static_bp.route("/createMeet")
@static_bp.route("/joinmeet")
def serve_app_entry():
    return _serve_app_route(request.path)


@static_bp.route("/<string:student_id>/submission")
def serve_submission_entry(student_id):
    # The student id is consumed by the client route layer; private data still
    # requires the existing authenticated exam API calls.
    return _serve_app_route("/exampaper")


@static_bp.route("/meeting/<string:meeting_id>/<string:user_id>")
def serve_meeting_entry(meeting_id, user_id):
    shell = _app_shell("/joinmeet")
    if shell:
        room = json.dumps({"meetingId": meeting_id, "userId": user_id}, separators=(",", ":"))
        shell = shell.replace("</head>", f"<script>window.__CODELEAF_MEETING_ROOM = {room};</script></head>", 1)
        return shell, 200, {"Content-Type": "text/html; charset=utf-8"}
    return send_from_directory(str(PUBLIC_DIR), "index.html")

@static_bp.route("/robots.txt")
def serve_robots():
    robots_path = PUBLIC_DIR / "robots.txt"
    if robots_path.exists():
        return send_from_directory(str(PUBLIC_DIR), "robots.txt")
    return (
        "User-agent: *\nAllow: /\n\nSitemap: https://codeleaf-org.vercel.app/sitemap.xml",
        200,
        {"Content-Type": "text/plain; charset=utf-8"}
    )

@static_bp.route("/sitemap.xml")
def serve_sitemap():
    sitemap_path = PUBLIC_DIR / "sitemap.xml"
    if sitemap_path.exists():
        return send_from_directory(str(PUBLIC_DIR), "sitemap.xml")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        '  <url>\n'
        '    <loc>https://codeleaf-org.vercel.app/</loc>\n'
        '    <lastmod>2026-11-02</lastmod>\n'
        '    <changefreq>daily</changefreq>\n'
        '    <priority>1.0</priority>\n'
        '  </url>\n'
        '</urlset>',
        200,
        {"Content-Type": "application/xml; charset=utf-8"}
    )

@static_bp.route("/image.png")
def serve_logo():
    try:
        return send_from_directory(str(PUBLIC_DIR), "image.png")
    except Exception:
        return "", 404

@static_bp.route("/favicon.ico")
def serve_favicon():
    return "", 204

@static_bp.route("/assets/<path:path>")
def serve_asset(path):
    """Serve local assets for direct/local development requests."""
    assets_dir = PUBLIC_DIR / "assets"
    asset = assets_dir / path
    try:
        asset.resolve().relative_to(assets_dir.resolve())
    except ValueError:
        return jsonify({"error": "Not found"}), 404
    if not asset.is_file():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(str(assets_dir), path, max_age=31536000)

@static_bp.route("/<path:path>")
def serve_static(path):
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    try:
        return send_from_directory(str(PUBLIC_DIR), path)
    except Exception:
        if INDEX_HTML:
            return INDEX_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}
        return send_from_directory(str(PUBLIC_DIR), "index.html")
