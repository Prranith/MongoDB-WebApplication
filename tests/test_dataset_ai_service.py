import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from api.index import handler
from services.ai.dataset_ai_service import DatasetAIService


def test_dataset_ai_fallback_columns_answer():
    result = DatasetAIService.answer_question(
        "customers 1000",
        [{"Customer Id": "A1", "Country": "India"}],
        "What columns are available?",
    )
    assert result["status"] == "ok"
    assert "Customer Id" in result["columns"]
    assert "out of dataset scope" not in result["answer"].lower()


def test_dataset_ai_route_with_stubbed_dataset(monkeypatch):
    from api.routes import exam_routes

    def _fake_dataset(_room_id, _dataset_id):
        return {
            "docs": [
                {"Customer Id": "A1", "Country": "India"},
                {"Customer Id": "A2", "Country": "USA"},
            ],
            "meta": {"name": "customers 1000"},
        }

    monkeypatch.setattr(exam_routes.SubmissionService, "get_dataset_details", staticmethod(_fake_dataset))
    client = handler.test_client()
    res = client.post(
        "/api/exam/room/ROOM1/dataset/DS1/ask",
        json={"question": "What columns are available in this dataset?"},
    ).get_json()

    assert res["status"] == "ok"
    assert res["datasetName"] == "customers 1000"
    assert "Customer Id" in res["columns"]
