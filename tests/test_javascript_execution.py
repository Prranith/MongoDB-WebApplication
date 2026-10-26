import os
from unittest.mock import patch

import pytest

from services.compiler.javascript_service import JavaScriptService


@pytest.mark.parametrize(
    ("source", "expected_stdout"),
    [
        ("let value = 10; console.log(value);", "10"),
        ("console.log('sum', 2 + 3);", "sum 5"),
        ("console.log(JSON.stringify({ok: true}));", '{"ok":true}'),
    ],
)
def test_javascript_service_executes_code_and_captures_console(source, expected_stdout):
    result = JavaScriptService.run_code(source)

    assert result["code"] == 0
    assert result["stdout"] == expected_stdout
    assert result["stderr"] == ""


def test_javascript_service_reads_standard_input():
    result = JavaScriptService.run_code(
        "const name = readline(); console.log('Hello ' + name);",
        stdin="Ada\n",
    )

    assert result["code"] == 0
    assert result["stdout"] == "Hello Ada"


@pytest.mark.parametrize("language", ["javascript", "js"])
def test_compiler_service_routes_javascript_to_sandbox(language):
    from services.compiler.compiler_service import CompilerService

    result = CompilerService.run_piston_code(
        language,
        "const n = Number(readline()); console.log(n * 2);",
        stdin="21",
    )

    assert result["code"] == 0
    assert result["stdout"] == "42"


def test_javascript_service_returns_syntax_errors():
    result = JavaScriptService.run_code("int value = 10; console.log(value);")

    assert result["code"] != 0
    assert "SyntaxError" in result["stderr"]


def test_javascript_service_enforces_execution_timeout():
    with patch.dict(os.environ, {"JAVASCRIPT_EXECUTION_TIMEOUT_SECONDS": "0.1"}):
        result = JavaScriptService.run_code("while (true) {}")

    assert result["code"] == 124
    assert "timed out" in result["stderr"]


def test_javascript_service_rejects_oversized_source():
    result = JavaScriptService.run_code(" " * (JavaScriptService.MAX_SOURCE_LENGTH + 1))

    assert result["code"] != 0
    assert "128 KB" in result["stderr"]


def test_javascript_playground_route_uses_local_sandbox_not_provider_or_queue():
    from api.index import handler

    with patch("services.compiler.compiler_service.CompilerService.run_piston_code") as provider:
        with patch("services.execution.job_queue.enqueue") as enqueue:
            response = handler.test_client().post(
                "/api/sandbox/run",
                json={
                    "language": "javascript",
                    "code": "let value = 10; console.log(value);",
                    "stdin": "",
                },
            )

    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    assert response.get_json()["stdout"] == "10"
    assert response.get_json()["code"] == 0
    provider.assert_not_called()
    enqueue.assert_not_called()
