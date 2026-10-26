import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import mongomock
import pymongo
import pytest

from services.exam import room_service as exam_module
from services.exam.room_service import RoomService
from services.execution import job_queue
from services.meeting import meeting_service as meeting_module
from services.meeting.meeting_service import MeetingService
from services.shared import redis_client


def test_room_id_generation_checks_existing_candidates():
    with patch.object(exam_module.random, "choices", side_effect=[list("AAA"), list("BBB")]):
        with patch.object(exam_module, "redis_one", side_effect=[1, 0]) as exists:
            assert RoomService._gen_room_id() == "MNG-BBB"

    assert exists.call_count == 2


def test_exam_creation_retries_atomic_id_collision():
    with patch.object(RoomService, "_gen_room_id", side_effect=["MNG-AAA", "MNG-BBB"]):
        with patch.object(exam_module, "create_room_document", side_effect=[False, True]) as insert:
            room = RoomService.create_room("Review", "mentor-1", True, 30, False, False, 5)

    assert room["roomId"] == "MNG-BBB"
    assert [call.args[0] for call in insert.call_args_list] == ["MNG-AAA", "MNG-BBB"]


def test_atomic_room_insert_reports_duplicate_ids():
    collection = MagicMock()
    collection.insert_one.side_effect = pymongo.errors.DuplicateKeyError("duplicate")
    with patch.object(redis_client, "_get_rooms_coll", return_value=collection):
        assert redis_client.create_room_document("MNG-AAA", {"status": "waiting"}) is False


def test_meeting_creation_retries_generated_id_collision():
    collection = MagicMock()
    collection.insert_one.side_effect = [
        pymongo.errors.DuplicateKeyError("duplicate"),
        MagicMock(),
    ]
    candidates = iter([
        SimpleNamespace(hex="taken0000000000"),
        SimpleNamespace(hex="fresh000000000"),
    ])
    with patch.object(MeetingService, "_collection", return_value=collection):
        with patch.object(meeting_module.uuid, "uuid4", side_effect=lambda: next(candidates)):
            room = MeetingService.create_room(host_name="Host")

    assert room["roomId"] == "MTG-FRESH000"
    assert collection.insert_one.call_count == 2
    MeetingService._rooms.pop(room["roomId"], None)


def test_live_paper_save_publishes_new_version_and_audit():
    old_questions = [{"id": "q1", "type": "mcq", "title": "Original"}]
    new_questions = [{"id": "q1", "type": "mcq", "title": "Updated"}]
    room_fields = ["mentor-1", json.dumps(old_questions), "old-version", "[]"]
    with patch.object(exam_module, "redis_one", return_value=room_fields):
        with patch.object(exam_module, "redis_cmd") as save:
            assert RoomService.save_questions("MNG-AAA", "mentor-1", new_questions) == 1

    pipeline = save.call_args.args[0]
    paper_write = next(command for command in pipeline if command[0] == "HSET" and "questions" in command)
    assert json.loads(paper_write[3]) == new_questions
    assert paper_write[5] != "old-version"
    audit = json.loads(paper_write[7])
    assert audit[-1]["changedQuestionIds"] == ["q1"]
    assert audit[-1]["paperVersion"] == paper_write[5]


def test_live_query_edit_refreshes_frozen_answer_before_publishing_paper():
    old_questions = [{"id": "q1", "type": "query", "expectedQuery": "{}", "datasetId": "ds1"}]
    new_questions = [{"id": "q1", "type": "query", "expectedQuery": "{active: true}", "datasetId": "ds1"}]
    room_fields = ["mentor-1", json.dumps(old_questions), "old-version", "[]"]
    with patch.object(exam_module, "redis_one", side_effect=[room_fields, 1]):
        with patch("services.submission.submission_service.SubmissionService.execute_room_query",
                   return_value={"status": "ok", "results": [{"active": True}]}):
            with patch.object(exam_module, "redis_cmd") as save:
                RoomService.save_questions("MNG-AAA", "mentor-1", new_questions)

    pipeline = save.call_args.args[0]
    answer_index = next(i for i, command in enumerate(pipeline) if command[0] == "HSET" and command[2] == "q_answer:q1")
    paper_index = next(i for i, command in enumerate(pipeline) if command[0] == "HSET" and "questions" in command)
    assert answer_index < paper_index
    assert json.loads(pipeline[answer_index][3]) == [{"active": True}]


def test_queue_timeout_explains_missing_worker_and_job_state():
    jobs = MagicMock()
    jobs.find_one.return_value = {"status": "queued", "kind": "playground_python"}
    with patch.object(job_queue, "_jobs", return_value=jobs):
        with patch.object(job_queue, "active_workers", return_value=[]):
            result = job_queue.wait_for_result("job-1", timeout=-1)

    assert result["code"] == "EXECUTION_QUEUE_TIMEOUT"
    assert result["jobStatus"] == "queued"
    assert result["activeWorkers"] == 0
    assert "No execution worker" in result["error"]


def test_queue_connection_failure_is_reported_as_service_unavailable():
    jobs = MagicMock()
    with patch.object(job_queue, "_jobs", return_value=jobs):
        with patch.object(job_queue, "_connection", side_effect=OSError("broker unavailable")):
            with patch.object(job_queue, "enabled", return_value=True):
                result = job_queue._execute_uncached(
                    "playground_code",
                    {"language": "python", "code": "print(1)"},
                    lambda: {},
                )

    assert result["status"] == "error"
    assert result["code"] == "EXECUTION_QUEUE_UNAVAILABLE"
    assert "CloudAMQP" in result["error"]
    assert jobs.update_one.call_args.args[0] == {"_id": jobs.insert_one.call_args.args[0]["_id"]}


def test_jobs_migrates_legacy_sparse_compound_idempotency_index():
    db = mongomock.MongoClient().exam_system
    collection = db.execution_jobs
    collection.create_index(
        [("kind", 1), ("idempotencyKey", 1)],
        unique=True,
        sparse=True,
    )
    collection.insert_one({"_id": "legacy-job", "kind": "playground_sql"})

    with patch.object(job_queue, "_job_indexes_ready", False):
        with patch.object(job_queue, "get_exam_db", return_value=db):
            jobs = job_queue._jobs()

    jobs.insert_one({"_id": "sql-job-1", "kind": "playground_sql"})
    jobs.insert_one({"_id": "sql-job-2", "kind": "playground_sql"})
    jobs.insert_one({"_id": "null-key-1", "kind": "playground_sql", "idempotencyKey": None})
    jobs.insert_one({"_id": "null-key-2", "kind": "playground_sql", "idempotencyKey": None})
    jobs.insert_one({
        "_id": "idempotent-job",
        "kind": "playground_sql",
        "idempotencyKey": "stable-request-key",
    })

    with pytest.raises(pymongo.errors.DuplicateKeyError):
        jobs.insert_one({
            "_id": "duplicate-idempotent-job",
            "kind": "playground_sql",
            "idempotencyKey": "stable-request-key",
        })

    indexes = jobs.index_information()
    assert "kind_1_idempotencyKey_1" not in indexes
    assert indexes["execution_idempotency_key_unique"]["unique"] is True
    assert indexes["execution_idempotency_key_unique"]["partialFilterExpression"] == {
        "idempotencyKey": {"$type": "string"}
    }


def test_sandbox_route_returns_json_for_execution_service_failure():
    from api.routes.database_routes import database_bp
    from api.routes.sql_routes import sql_bp
    from flask import Flask

    app = Flask(__name__)
    app.register_blueprint(database_bp)
    app.register_blueprint(sql_bp)
    error = {
        "status": "error",
        "code": "EXECUTION_QUEUE_UNAVAILABLE",
        "error": "Execution queue is unavailable.",
    }
    with patch("api.routes.database_routes.execute_job", return_value=error):
        sandbox_response = app.test_client().post(
            "/api/sandbox/run",
            json={"language": "python", "code": "print(1)"},
        )
        mongo_response = app.test_client().post(
            "/api/query",
            json={"query": "db.users.find()"},
        )
    with patch("api.routes.sql_routes.execute_job", return_value=error):
        sql_response = app.test_client().post(
            "/api/sql/run",
            json={"query": "select * from users"},
        )

    for response in (sandbox_response, mongo_response, sql_response):
        assert response.status_code == 503
        assert response.is_json
        assert response.get_json()["code"] == "EXECUTION_QUEUE_UNAVAILABLE"
