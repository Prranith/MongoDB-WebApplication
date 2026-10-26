import json
from io import BytesIO
from unittest.mock import patch

import pytest

from services.proctoring.proctoring_service import ProctoringService
from services.submission.submission_service import SubmissionService


def _javascript_question(expected_output="16"):
    return {
        "id": "q-js",
        "type": "coding",
        "marks": 10,
        "templateType": "scratch",
        "testCases": [{"input": "8", "expectedOutput": expected_output}],
        "templates": {
            "javascript": {
                "starterCode": "const value = Number(readline()); console.log(value * 2);",
                "driverCode": "",
                "editorialCode": "const value = Number(readline()); console.log(value * 2);",
            }
        },
    }


def test_exam_run_endpoint_executes_javascript_cases_in_api_process():
    from api.index import handler
    from api.routes import exam_routes

    def execute_directly(_kind, _payload, direct, **_kwargs):
        return direct()

    with patch.object(exam_routes, "_assert_student_account"):
        with patch.object(exam_routes.RoomService, "get_room_status", return_value={"roomStatus": "live"}):
            with patch.object(exam_routes, "execute_job", side_effect=execute_directly):
                response = handler.test_client().post(
                    "/api/exam/room/MNG-JS1/run",
                    json={
                        "studentId": "student-1",
                        "language": "javascript",
                        "code": "const value = Number(readline()); console.log(value * 2);",
                        "stdins": ["8", "12"],
                    },
                )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["status"] == "ok"
    assert [result["stdout"] for result in payload["results"]] == ["16", "24"]
    assert [result["code"] for result in payload["results"]] == [0, 0]


def test_javascript_exam_test_generation_and_custom_verification():
    question = _javascript_question()
    with patch(
        "services.submission.submission_service.redis_one",
        return_value=json.dumps([question]),
    ):
        cases = SubmissionService.generate_test_cases(
            "javascript",
            "const value = Number(readline()); console.log(value * 2);",
            ["8", "12"],
            "scratch",
            "",
        )
        verification = SubmissionService.verify_custom_input(
            "MNG-JS1",
            "q-js",
            "javascript",
            "const value = Number(readline()); console.log(value * 2);",
            "15",
        )

    assert cases == ["16", "24"]
    assert verification["verdict"] == "accepted"
    assert verification["student"]["stdout"] == "30"
    assert verification["expectedOutput"] == "30"


@pytest.mark.parametrize(
    ("source", "expected_score", "expected_passed"),
    [
        ("const value = Number(readline()); console.log(value * 2);", 10, 1),
        ("const value = Number(readline()); console.log(value * 3);", 0, 0),
    ],
)
def test_javascript_exam_submission_is_graded_by_server_execution(source, expected_score, expected_passed):
    from services.execution import job_queue

    question = _javascript_question()

    def read_room(command):
        if command[0] == "HMGET":
            return ["live", json.dumps([question]), None, None]
        if command[0] == "HGET" and command[-1] == "questions":
            return json.dumps([question])
        return None

    def execute_directly(_kind, _payload, direct, **_kwargs):
        return direct()

    with patch("services.submission.submission_service.redis_one", side_effect=read_room):
        with patch("services.submission.submission_service.redis_cmd"):
            with patch("services.submission.submission_service.get_room_kicked_dict", return_value={}):
                with patch.object(job_queue, "execute", side_effect=execute_directly):
                    result = SubmissionService.submit_answer(
                        "MNG-JS1",
                        "student-1",
                        "q-js",
                        "coding",
                        10,
                        {"language": "javascript", "code": source},
                    )

    assert result["score"] == expected_score
    assert result["passedCount"] == expected_passed
    assert result["totalCount"] == 1


def test_fullscreen_violation_uses_persisted_server_threshold_and_kicks():
    participant = json.dumps({"fullscreenExits": 2, "copyPasteAttempts": 0})

    def read_room(command):
        return {
            "participant:student-1": participant,
            "maxFullscreenExits": "3",
            "maxCopyPasteAttempts": "4",
        }.get(command[-1])

    with patch("services.proctoring.proctoring_service.redis_one", side_effect=read_room):
        with patch("services.proctoring.proctoring_service.redis_cmd"):
            with patch.object(ProctoringService, "self_kick", return_value=True) as self_kick:
                result = ProctoringService.record_violation("MNG-JS1", "student-1", "fullscreen_exit")

    assert result["fullscreenExits"] == 3
    assert result["fullscreenLimit"] == 3
    assert result["blocked"] is True
    assert result["blockedReason"] == "Fullscreen exit limit reached (3)."
    self_kick.assert_called_once_with("MNG-JS1", "student-1", "Fullscreen exit limit reached (3).")


def test_fullscreen_violation_does_not_kick_before_persisted_threshold():
    participant = json.dumps({"fullscreenExits": 1, "copyPasteAttempts": 0})

    def read_room(command):
        return {
            "participant:student-1": participant,
            "maxFullscreenExits": "3",
            "maxCopyPasteAttempts": "4",
        }.get(command[-1])

    with patch("services.proctoring.proctoring_service.redis_one", side_effect=read_room):
        with patch("services.proctoring.proctoring_service.redis_cmd"):
            with patch.object(ProctoringService, "self_kick") as self_kick:
                result = ProctoringService.record_violation("MNG-JS1", "student-1", "fullscreen_exit")

    assert result["fullscreenExits"] == 2
    assert result["blocked"] is False
    self_kick.assert_not_called()


def test_media_chunk_endpoint_reads_mentor_identity_from_multipart_form():
    from api.index import handler
    from api.routes import exam_routes

    with patch.object(exam_routes, "_media_mentor_guard", return_value=None) as guard:
        with patch.object(
            exam_routes.QuestionMediaService,
            "store_chunk",
            return_value={"uploadId": "upload-1", "seq": 0, "size": 4},
        ) as store_chunk:
            response = handler.test_client().post(
                "/api/exam/room/MNG-JS1/question/q1/media/chunk",
                data={
                    "mentorId": "mentor-1",
                    "uploadId": "upload-1",
                    "seq": "0",
                    "file": (BytesIO(b"data"), "question.png"),
                },
                content_type="multipart/form-data",
            )

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    guard.assert_called_once_with("MNG-JS1", "mentor-1")
    store_chunk.assert_called_once()


def test_media_abort_endpoint_accepts_client_json_identity():
    from api.index import handler
    from api.routes import exam_routes

    with patch.object(exam_routes, "_media_mentor_guard", return_value=None) as guard:
        with patch.object(exam_routes.QuestionMediaService, "abort_upload", return_value=2) as abort_upload:
            response = handler.test_client().post(
                "/api/exam/room/MNG-JS1/question/q1/media/abort",
                json={"mentorId": "mentor-1", "uploadId": "upload-1"},
            )

    assert response.status_code == 200
    assert response.get_json()["removed"] == 2
    guard.assert_called_once_with("MNG-JS1", "mentor-1")
    abort_upload.assert_called_once_with("MNG-JS1", "upload-1")


def test_media_delete_endpoint_accepts_mentor_query_parameter():
    from api.index import handler
    from api.routes import exam_routes

    with patch.object(exam_routes, "redis_one", return_value="mentor-1"):
        with patch.object(
            exam_routes.QuestionMediaService,
            "delete",
            return_value={"id": "media-1"},
        ) as delete_media:
            response = handler.test_client().delete(
                "/api/exam/room/MNG-JS1/question/q1/media/media-1?mentorId=mentor-1"
            )

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    delete_media.assert_called_once_with("MNG-JS1", "media-1")
