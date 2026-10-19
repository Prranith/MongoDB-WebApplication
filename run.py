"""
run.py
Local development server for the CodeLeaf web app.

Serves BOTH the static frontend (public/) and the /api/* endpoints from one
Flask process. Do NOT use `npx serve public` for this — a static file server
has no backend, so every /api/* call (meeting join, collections, snippets,
analytics, exams) returns 404.

Usage:
    python run.py
Then open http://127.0.0.1:8000
"""

from api.index import app

if __name__ == "__main__":
    print("CodeLeaf dev server -> http://127.0.0.1:8000")
    app.run(host="127.0.0.1", port=8000, debug=True, threaded=True)
