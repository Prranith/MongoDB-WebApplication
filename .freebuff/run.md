# Running the Codexa Labs dev server

## Reproduce the artifacts

The Flask app serves the frontend from the **auto-generated embedded copy**
`api/frontend.py`, NOT directly from `public/` (see `api/routes/static_routes.py`
— it returns `INDEX_HTML` when available). After editing anything in `public/`
(HTML/CSS/JS), regenerate the embedded copy:

```
python embed_frontend.py
```

No other build steps or dependencies are required. `requirements.txt` covers
Flask/PeerJS-free backend deps (`pip install -r requirements.txt`).

## Run the server

The dev server is a single Flask process serving both static frontend and
`/api/*` endpoints (do NOT use `npx serve public` — API calls will 404):

```
python run.py          # → http://127.0.0.1:8000  (debug reloader on)
```

To run on port 8001 (used by the live preview):

```
python -c "from api.index import app; app.run(host='127.0.0.1', port=8001, debug=True, threaded=True)"
```

`debug=True` enables the auto-reloader, so it picks up `embed_frontend.py`
regenerations and `api/*.py` edits without a manual restart. The meeting
feature (PeerJS WebRTC) requires a real browser with camera/mic access at
`http://127.0.0.1:8001`.