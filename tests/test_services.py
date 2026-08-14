import unittest
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
        self.assertIn("class Main", sanitized)
        self.assertIn("public Main(", sanitized)

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
