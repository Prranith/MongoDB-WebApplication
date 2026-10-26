"""
tests/test_end_to_end_health.py
Lightweight end-to-end smoke tests wired through the Flask app.

These exercises the actual blueprints so we can confirm the refactored
middleware/logging/idempotency/pagination hooks do not break behaviour.
"""

import sys
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from api.index import handler


def _client() -> "handler.test_clientClass":
    # Flask test client from the shared app instance
    return handler.test_client()


def test_collections_and_sample_and_schema():
    c = _client()
    coll = c.get("/api/collections").get_json()
    assert "collections" in coll
    listed = {item["name"]: item["count"] for item in coll["collections"]}
    assert {"elite", "users", "orders", "inventory", "shipments"} <= listed.keys()
    assert all(listed[name] > 0 for name in ("elite", "users", "orders", "inventory", "shipments"))

    sample = c.get("/api/sample/users?limit=3").get_json()
    assert sample["collection"] == "users"
    assert isinstance(sample["documents"], list)

    schema = c.get("/api/schema/users").get_json()
    assert schema["collection"] == "users"
    assert "schema" in schema
    assert "count" in schema


def test_vercel_function_bundle_includes_practice_database_files():
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    included_files = config["functions"]["api/index.py"]["includeFiles"]
    assert "databases/**" in included_files


def test_analytics_endpoints():
    c = _client()
    stats = c.get("/api/analytics?client_id=smoke").get_json()
    assert isinstance(stats, dict)
    assert "total_visits" in stats or "active_users" in stats

    launch = c.post("/api/analytics/launch", json={"client_id": "smoke2"}).get_json()
    assert isinstance(launch, dict)

    heartbeat = c.post("/api/analytics/heartbeat", json={"client_id": "smoke3"}).get_json()
    assert heartbeat.get("status") == "ok"


def test_room_lifecycle():
    c = _client()
    created = c.post(
        "/api/exam/room/create",
        json={
            "title": "Smoke Assessment",
            "mentorId": "mentor_smoke",
            "timed": True,
            "duration": 30,
        },
    ).get_json()
    assert created["status"] == "ok"
    room_id = created["roomId"]

    status = c.get(f"/api/exam/room/{room_id}/status").get_json()
    assert status["status"] == "ok"
    assert status["roomStatus"] in {"waiting", "live", "ended"}

    joined = c.post(
        f"/api/exam/room/{room_id}/join",
        json={"name": "Jane Doe", "rollNo": "SMK001", "branch": "CSE", "section": "A"},
    ).get_json()
    assert joined["status"] == "ok"
    assert "studentId" in joined


def test_correlation_id_propagation():
    c = _client()
    resp = c.get("/api/collections", headers={"X-Correlation-ID": "test-corr-123"})
    assert resp.headers.get("X-Correlation-ID") == "test-corr-123"
