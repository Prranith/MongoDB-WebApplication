import sys
from pathlib import Path
from flask import Blueprint, send_from_directory, jsonify

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

@static_bp.route("/")
def serve_index():
    # Try embedded HTML first (works even if public/ was removed by .vercelignore)
    if INDEX_HTML:
        return INDEX_HTML, 200, {"Content-Type": "text/html; charset=utf-8"}
    # Fallback: serve from file
    return send_from_directory(str(PUBLIC_DIR), "index.html")

@static_bp.route("/robots.txt")
def serve_robots():
    robots_path = PUBLIC_DIR / "robots.txt"
    if robots_path.exists():
        return send_from_directory(str(PUBLIC_DIR), "robots.txt")
    return (
        "User-agent: *\nAllow: /\n\nSitemap: https://practice-mongodb.vercel.app/sitemap.xml",
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
        '    <loc>https://practice-mongodb.vercel.app/</loc>\n'
        '    <lastmod>2026-07-26</lastmod>\n'
        '    <changefreq>weekly</changefreq>\n'
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
