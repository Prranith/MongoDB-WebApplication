import unittest
from unittest.mock import MagicMock, patch

from services.exam.room_service import RoomService
from services.submission.submission_service import SubmissionService
from services.leaderboard.leaderboard_service import LeaderboardService
from services.proctoring.proctoring_service import ProctoringService
from services.compiler.compiler_service import CompilerService

class TestServices(unittest.TestCase):
    def test_normalize_values(self):
        doc1 = {"_id": "123", "score": 100.0, "details": {"active": True, "$oid": "xyz"}}
        doc2 = {"score": 100, "details": {"active": True}}
        norm1 = SubmissionService._normalize_doc(doc1)
        norm2 = SubmissionService._normalize_doc(doc2)
        self.assertEqual(norm1, norm2)

    def test_query_grading(self):
        res1 = [{"name": "Alice", "age": 25.0}, {"name": "Bob", "age": 30}]
        res2 = [{"name": "Bob", "age": 30.0}, {"name": "Alice", "age": 25}]
        grade = SubmissionService.grade_query_answer(res1, res2)
        self.assertTrue(grade["match"])
        self.assertEqual(grade["score"], 1)

    def test_java_sanitizer(self):
        code = "public class Solution { public Solution() {} public void solve() {} }"
        sanitized = CompilerService._sanitize_java_code(code)
        self.assertEqual(sanitized, code)

    def test_java_entry_class_preserves_submitted_name(self):
        code = "public class Solution { public static void main(String[] args) {} }"
        self.assertEqual(CompilerService._java_entry_class(code), "Solution")

    def test_java_entry_class_uses_main_method_class(self):
        code = "class Solution {} public class Runner { public static void main(String[] args) {} }"
        self.assertEqual(CompilerService._java_entry_class(code), "Runner")

    def test_java_entry_class_preserves_arbitrary_submitted_class(self):
        code = "public class ContestEntry { public static void main(String[] args) {} }"
        self.assertEqual(CompilerService._java_entry_class(code), "ContestEntry")

    def test_java_entry_class_uses_workspace_filename_without_source_rewrite(self):
        code = "public class Test { public static void main(String[] args) {} }"
        self.assertEqual(CompilerService._java_entry_class(code, "Dynamic Programming/Test.java"), "Test")
        launcher = CompilerService._java_launcher_source(code, "Test")
        self.assertIn("class Test", launcher)
        self.assertIn("Test.main(args)", launcher)
        self.assertNotIn("public class Test", launcher)

    def test_java_entry_class_does_not_fallback_to_main(self):
        self.assertEqual(CompilerService._java_entry_class("System.out.println(1);"), "")

    def test_java_playground_rejects_public_class_filename_mismatch(self):
        result = CompilerService.run_local_code(
            "java", "public class Test { public static void main(String[] args) {} }",
            filename="solution.java", strict_java_filename=True,
        )
        self.assertNotEqual(result["code"], 0)
        self.assertIn("filename/class mismatch", result["stderr"])

    def test_java_playground_uses_submitted_filename(self):
        result = CompilerService.run_local_code(
            "java", "public class Solution { public static void main(String[] args) { System.out.print(\"OK\"); } }",
            filename="Solution.java", strict_java_filename=True,
        )
        self.assertEqual(result["code"], 0)
        self.assertEqual(result["stdout"], "OK")

    @patch("services.compiler.compiler_service.requests.post")
    def test_code_execution_uses_piston_external_api(self, post):
        response = MagicMock(status_code=200)
        response.json.return_value = {
            "compile": {"code": 0},
            "run": {"stdout": "external output", "stderr": "", "code": 0},
        }
        post.return_value = response

        result = CompilerService.run_piston_code(
            "java",
            "public class Solution { public static void main(String[] args) { System.out.print(\"ok\"); } }",
            filename="Solution.java",
            strict_java_filename=True,
        )

        self.assertEqual(result["stdout"], "external output")
        self.assertEqual(result["code"], 0)
        self.assertEqual(post.call_args.args[0], "https://emkc.org/api/v2/piston/execute")
        self.assertEqual(post.call_args.kwargs["json"]["language"], "java")
        self.assertEqual(post.call_args.kwargs["json"]["stdin"], "")

    @patch("services.compiler.compiler_service.requests.post")
    def test_code_execution_sends_all_playground_languages_to_piston(self, post):
        response = MagicMock(status_code=200)
        response.json.return_value = {
            "run": {"stdout": "ok", "stderr": "", "code": 0},
        }
        post.return_value = response
        examples = {
            "python": ("print('ok')", "python"),
            "c": ("int main(void) { return 0; }", "c"),
            "cpp": ("int main() { return 0; }", "cpp"),
        }

        for language, (source, expected_provider_language) in examples.items():
            with self.subTest(language=language):
                result = CompilerService.run_piston_code(language, source)
                self.assertEqual(result["code"], 0)
                self.assertEqual(post.call_args.kwargs["json"]["language"], expected_provider_language)

    @patch("services.compiler.compiler_service.requests.get")
    @patch("services.compiler.compiler_service.requests.post")
    def test_code_execution_falls_back_from_piston_to_paiza(self, post, get):
        piston_unavailable = MagicMock(status_code=503)
        paiza_created = MagicMock(status_code=200)
        paiza_created.json.return_value = {"id": "runner-1"}
        paiza_details = MagicMock(status_code=200)
        paiza_details.json.return_value = {
            "status": "completed",
            "stdout": "paiza output",
            "stderr": "",
            "build_stderr": "",
            "exit_code": 0,
            "build_result": "success",
        }
        post.side_effect = [piston_unavailable, paiza_created]
        get.return_value = paiza_details

        result = CompilerService.run_piston_code("python", "print('ok')")

        self.assertEqual(result["stdout"], "paiza output")
        self.assertEqual(result["code"], 0)
        self.assertEqual(post.call_args_list[0].args[0], "https://emkc.org/api/v2/piston/execute")
        self.assertEqual(post.call_args_list[1].args[0], "https://api.paiza.io/runners/create")
        self.assertEqual(get.call_args.args[0], "https://api.paiza.io/runners/get_details")

    @patch("services.compiler.compiler_service.requests.post")
    def test_java_filename_mismatch_is_rejected_before_external_request(self, post):
        result = CompilerService.run_piston_code(
            "java",
            "public class Solution { public static void main(String[] args) {} }",
            filename="main.java",
            strict_java_filename=True,
        )

        self.assertNotEqual(result["code"], 0)
        self.assertIn("filename/class mismatch", result["stderr"])
        post.assert_not_called()

    def test_extract_sub_metrics(self):
        subs = {
            "q1": '{"score": 10, "submittedAt": 1000}',
            "q2": '{"score": 0, "submittedAt": 2000}',
            "q3": 'malformed json'
        }
        answered, correct, last_time = LeaderboardService._extract_sub_metrics(subs)
        self.assertEqual(answered, 3)
        self.assertEqual(correct, 1)
        self.assertEqual(last_time, 2000)

if __name__ == "__main__":
    unittest.main()
