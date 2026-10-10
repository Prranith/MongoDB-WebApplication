"""
tests/test_end_to_end_health.py
Lightweight end-to-end smoke tests wired through the Flask app.

These exercises the actual blueprints so we can confirm the refactored
middleware/logging/idempotency/pagination hooks do not break behaviour.
"""

import sys
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
    assert any(x["name"] == "users" for x in coll["collections"])

    sample = c.get("/api/sample/users?limit=3").get_json()
    assert sample["collection"] == "users"
    assert isinstance(sample["documents"], list)

    schema = c.get("/api/schema/users").get_json()
    assert schema["collection"] == "users"
    assert "schema" in schema
    assert "count" in schema


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


def test_dataset_question_answer_fallback():
    c = _client()
    created = c.post(
        "/api/exam/room/create",
        json={"title": "Dataset AI", "mentorId": "mentor_ai"},
    ).get_json()
    room_id = created["roomId"]

    uploaded = c.post(
        f"/api/exam/room/{room_id}/dataset",
        json={
            "mentorId": "mentor_ai",
            "name": "customers 1000",
            "docs": [
                {"Customer Id": "A1", "Country": "India"},
                {"Customer Id": "A2", "Country": "India"},
                {"Customer Id": "A3", "Country": "USA"},
            ],
        },
    ).get_json()
    dataset_id = uploaded["datasetId"]

    answered = c.post(
        f"/api/exam/room/{room_id}/dataset/{dataset_id}/ask",
        json={"question": "What columns are available in this dataset?"},
    ).get_json()

    assert answered["status"] == "ok"
    assert "Customer Id" in answered["columns"]
    assert "out of dataset scope" not in answered["answer"].lower()
