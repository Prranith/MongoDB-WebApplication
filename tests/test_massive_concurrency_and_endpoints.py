"""
tests/test_massive_concurrency_and_endpoints.py
Comprehensive real-time stress testing, end-to-end endpoint verification,
edge case validation, and 100+ concurrent student simulation.
"""

import sys
import json
import time
import uuid
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from api.index import app
from services.shared.redis_client import redis_cmd, redis_one

class TestMassiveConcurrencyAndEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.testing = True
        cls.client = app.test_client()

    # ──────────────────────────────────────────────────────────────────────────
    # SECTION 1: Core Database, Query & Filesystem Endpoints & Edge Cases
    # ──────────────────────────────────────────────────────────────────────────

    def test_01_database_and_schema_endpoints(self):
        """Test collections, schemas, samples and edge cases."""
        # Collections list
        res = self.client.get("/api/collections")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertIn("collections", data)
        self.assertTrue(len(data["collections"]) > 0)

        # Valid collection schema
        first_coll = data["collections"][0]["name"]
        res_schema = self.client.get(f"/api/schema/{first_coll}")
        self.assertEqual(res_schema.status_code, 200)
        schema_data = res_schema.get_json()
        self.assertEqual(schema_data["collection"], first_coll)
        self.assertIn("schema", schema_data)

        # Non-existent collection sample (Edge case)
        res_bad_sample = self.client.get("/api/sample/non_existent_coll_12345")
        self.assertEqual(res_bad_sample.status_code, 404)

        # Snippets endpoint
        res_snippets = self.client.get("/api/snippets")
        self.assertEqual(res_snippets.status_code, 200)
        self.assertIn("snippets", res_snippets.get_json())

    def test_02_query_execution_edge_cases(self):
        """Test query engine with normal queries, malformed syntax, and custom datasets."""
        # 1. Normal valid query
        res = self.client.post("/api/query", json={"query": "db.users.find().limit(2)"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["status"], "ok")

        # 2. Empty query (Edge Case)
        res_empty = self.client.post("/api/query", json={"query": ""})
        self.assertEqual(res_empty.status_code, 400)

        # 3. Malformed syntax query (Edge Case)
        res_bad = self.client.post("/api/query", json={"query": "db.users.find({bad syntax: })"})
        self.assertEqual(res_bad.status_code, 200)
        self.assertEqual(res_bad.get_json()["status"], "error")

        # 4. Custom collections injection
        custom_coll = {
            "test_students": [
                {"id": 1, "name": "Student A", "marks": 85},
                {"id": 2, "name": "Student B", "marks": 92}
            ]
        }
        res_custom = self.client.post("/api/query", json={
            "query": "db.test_students.find({marks: {$gt: 90}})",
            "custom_collections": custom_coll
        })
        self.assertEqual(res_custom.status_code, 200)
        res_custom_data = res_custom.get_json()
        self.assertEqual(res_custom_data["status"], "ok")
        self.assertEqual(len(res_custom_data["data"]), 1)

    def test_03_file_routes_and_traversal_guards(self):
        """Test file creation, traversal guard, listing, saving, renaming, deleting."""
        # Path traversal rejection (Security Edge Case)
        res_traversal = self.client.post("/api/files/save", json={
            "path": "../../secret.txt",
            "content": "hacked"
        })
        self.assertEqual(res_traversal.status_code, 400)

        # Valid file save
        res_save = self.client.post("/api/files/save", json={
            "path": "test_query_stress.mongo",
            "content": "db.users.find()"
        })
        self.assertEqual(res_save.status_code, 200)

        # Rename
        res_rename = self.client.post("/api/files/rename", json={
            "old_path": "test_query_stress.mongo",
            "new_path": "test_query_stress_renamed.mongo"
        })
        self.assertEqual(res_rename.status_code, 200)

        # Delete
        res_delete = self.client.post("/api/files/delete", json={
            "path": "test_query_stress_renamed.mongo"
        })
        self.assertEqual(res_delete.status_code, 200)

    # ──────────────────────────────────────────────────────────────────────────
    # SECTION 2: Exam Lifecycle & Full Flow Edge Cases
    # ──────────────────────────────────────────────────────────────────────────

    def test_04_exam_room_lifecycle_and_security(self):
        """Test exam room creation, question upload, dataset attachment, freezing, unauthorized attempts."""
        mentor_id = f"mentor-{uuid.uuid4().hex[:6]}"
        attacker_id = f"attacker-{uuid.uuid4().hex[:6]}"

        # 1. Create room
        res_create = self.client.post("/api/exam/room/create", json={
            "title": "Real-Time Concurrency Exam",
            "mentorId": mentor_id,
            "timed": True,
            "duration": 45,
            "fullscreenMode": True,
            "blockCopyPaste": True,
            "maxFullscreenExits": 3
        })
        self.assertEqual(res_create.status_code, 200)
        room_data = res_create.get_json()
        room_id = room_data["roomId"]
        self.assertIsNotNone(room_id)

        # 2. Upload dataset
        sample_dataset = [
            {"product": "Laptop", "price": 1000, "category": "Tech"},
            {"product": "Mouse", "price": 25, "category": "Tech"},
            {"product": "Chair", "price": 150, "category": "Office"}
        ]
        res_ds = self.client.post(f"/api/exam/room/{room_id}/dataset", json={
            "mentorId": mentor_id,
            "name": "products",
            "docs": sample_dataset
        })
        self.assertEqual(res_ds.status_code, 200)
        ds_id = res_ds.get_json()["datasetId"]

        # 3. Unauthorized dataset deletion attempt by attacker (Security Edge Case)
        res_unauth = self.client.delete(f"/api/exam/room/{room_id}/dataset/{ds_id}", json={
            "mentorId": attacker_id
        })
        self.assertEqual(res_unauth.status_code, 403)

        # 4. Save Questions (MCQ, Query, Coding)
        questions = [
            {
                "id": "q1",
                "type": "mcq",
                "text": "What is MongoDB?",
                "options": ["A relational DB", "A document DB", "A graph DB"],
                "correctOption": 1,
                "marks": 5
            },
            {
                "id": "q2",
                "type": "query",
                "text": "Find tech items",
                "datasetIds": [ds_id],
                "expectedQuery": "db.products.find({category: 'Tech'})",
                "marks": 10
            },
            {
                "id": "q3",
                "type": "coding",
                "text": "Return square of n",
                "templateType": "scratch",
                "marks": 10,
                "testCases": [
                    {"input": "4", "expectedOutput": "16"},
                    {"input": "5", "expectedOutput": "25"}
                ]
            }
        ]
        res_q = self.client.post(f"/api/exam/room/{room_id}/questions", json={
            "mentorId": mentor_id,
            "questions": questions
        })
        self.assertEqual(res_q.status_code, 200)

        # 5. Freeze Answer for Query question
        res_freeze = self.client.post(f"/api/exam/room/{room_id}/freeze", json={
            "mentorId": mentor_id,
            "questionId": "q2",
            "datasetIds": [ds_id],
            "query": "db.products.find({category: 'Tech'})"
        })
        self.assertEqual(res_freeze.status_code, 200)

        # 6. Verify room status is 'waiting'
        res_status = self.client.get(f"/api/exam/room/{room_id}/status")
        self.assertEqual(res_status.status_code, 200)
        self.assertEqual(res_status.get_json()["roomStatus"], "waiting")

        # 7. Start the exam
        res_start = self.client.post(f"/api/exam/room/{room_id}/start", json={
            "mentorId": mentor_id
        })
        self.assertEqual(res_start.status_code, 200)

        # 8. Verify room status is now 'live'
        res_live_status = self.client.get(f"/api/exam/room/{room_id}/status")
        self.assertEqual(res_live_status.get_json()["roomStatus"], "live")

    # ──────────────────────────────────────────────────────────────────────────
    # SECTION 3: MASSIVE CONCURRENCY (100+ Concurrent Students)
    # ──────────────────────────────────────────────────────────────────────────

    def test_05_mass_concurrent_students_join_submit_leaderboard(self):
        """
        SIMULATE 120 CONCURRENT STUDENTS:
        - Simultaneously joining the room
        - Simultaneously submitting answers to MCQ and Query questions
        - Simultaneously reporting proctoring violations
        - Concurrently reading the leaderboard while scores are being updated
        - Testing Kick, Re-allow, and Re-join under load
        """
        mentor_id = f"mentor-mass-{uuid.uuid4().hex[:6]}"

        # 1. Create Room & Setup
        res_create = self.client.post("/api/exam/room/create", json={
            "title": "High Concurrency Mass Assessment",
            "mentorId": mentor_id,
            "timed": True,
            "duration": 60,
            "fullscreenMode": True,
            "blockCopyPaste": True,
            "maxFullscreenExits": 3
        })
        self.assertEqual(res_create.status_code, 200)
        room_id = res_create.get_json()["roomId"]

        # 2. Upload dataset & questions
        ds_sample = [
            {"dept": "CSE", "score": 90, "student": "A"},
            {"dept": "CSE", "score": 80, "student": "B"},
            {"dept": "ECE", "score": 85, "student": "C"}
        ]
        res_ds = self.client.post(f"/api/exam/room/{room_id}/dataset", json={
            "mentorId": mentor_id,
            "name": "scores",
            "docs": ds_sample
        })
        ds_id = res_ds.get_json()["datasetId"]

        questions = [
            {
                "id": "q1",
                "type": "mcq",
                "text": "What is 2+2?",
                "options": ["2", "3", "4", "5"],
                "correctOption": 2,
                "marks": 10
            },
            {
                "id": "q2",
                "type": "query",
                "text": "Find CSE records",
                "datasetIds": [ds_id],
                "expectedQuery": "db.scores.find({dept: 'CSE'})",
                "marks": 20
            }
        ]
        self.client.post(f"/api/exam/room/{room_id}/questions", json={
            "mentorId": mentor_id,
            "questions": questions
        })
        self.client.post(f"/api/exam/room/{room_id}/freeze", json={
            "mentorId": mentor_id,
            "questionId": "q2",
            "datasetIds": [ds_id],
            "query": "db.scores.find({dept: 'CSE'})"
        })

        # Start Room
        self.client.post(f"/api/exam/room/{room_id}/start", json={"mentorId": mentor_id})

        NUM_STUDENTS = 120
        student_records = []
        errors = []

        print(f"\n[STRESS TEST] Launching {NUM_STUDENTS} concurrent student joins...")

        # STEP A: Concurrent Join
        def student_join_worker(i):
            client = app.test_client()
            roll_no = f"21B91A{1000 + i}"
            name = f"Student_{i}"
            branch = "CSE" if i % 2 == 0 else "ECE"
            res = client.post(f"/api/exam/room/{room_id}/join", json={
                "name": name,
                "rollNo": roll_no,
                "branch": branch
            })
            return i, res.status_code, res.get_json(), roll_no, name

        with ThreadPoolExecutor(max_workers=20) as executor:
            futures = [executor.submit(student_join_worker, i) for i in range(NUM_STUDENTS)]
            for f in as_completed(futures):
                try:
                    idx, status, data, roll_no, name = f.result()
                    if status == 200 and data.get("status") == "ok":
                        student_records.append({
                            "idx": idx,
                            "studentId": data["studentId"],
                            "rollNo": roll_no,
                            "name": name
                        })
                    else:
                        errors.append(f"Join failed for student {idx}: {data}")
                except Exception as e:
                    errors.append(f"Join exception: {e}")

        self.assertEqual(len(errors), 0, f"Join errors encountered: {errors[:5]}")
        self.assertEqual(len(student_records), NUM_STUDENTS)
        print(f"[STRESS TEST] Successfully joined {len(student_records)} students concurrently without error.")

        # STEP B: Mass Concurrent Submissions & Violations
        print(f"[STRESS TEST] Launching concurrent submissions and violation reports across {NUM_STUDENTS} students...")
        sub_errors = []

        def student_submit_worker(student):
            client = app.test_client()
            sid = student["studentId"]
            idx = student["idx"]

            # Half students answer correctly, half incorrectly
            is_correct_student = (idx % 2 == 0)

            # 1. Submit MCQ Q1
            selected_opt = 2 if is_correct_student else 0
            res_mcq = client.post(f"/api/exam/room/{room_id}/submit", json={
                "studentId": sid,
                "questionId": "q1",
                "type": "mcq",
                "marks": 10,
                "selectedOption": selected_opt
            })
            if res_mcq.status_code != 200 or res_mcq.get_json().get("status") != "ok":
                return f"MCQ submit failed for {sid}: {res_mcq.get_json()}"

            # 2. Submit Query Q2
            query_str = "db.scores.find({dept: 'CSE'})" if is_correct_student else "db.scores.find({dept: 'XYZ'})"
            res_query = client.post(f"/api/exam/room/{room_id}/submit", json={
                "studentId": sid,
                "questionId": "q2",
                "type": "query",
                "marks": 20,
                "query": query_str,
                "datasetIds": [ds_id]
            })
            if res_query.status_code != 200 or res_query.get_json().get("status") != "ok":
                return f"Query submit failed for {sid}: {res_query.get_json()}"

            # 3. Report a violation
            client.post(f"/api/exam/room/{room_id}/student/{sid}/violation", json={
                "violationType": "fullscreen_exit"
            })

            return None

        with ThreadPoolExecutor(max_workers=20) as executor:
            sub_futures = [executor.submit(student_submit_worker, st) for st in student_records]
            for sf in as_completed(sub_futures):
                err = sf.result()
                if err:
                    sub_errors.append(err)

        self.assertEqual(len(sub_errors), 0, f"Submission errors: {sub_errors[:5]}")
        print(f"[STRESS TEST] {NUM_STUDENTS} students completed answers concurrently.")

        # STEP C: Concurrent Leaderboard Reads
        print("[STRESS TEST] Testing concurrent leaderboard reads under load...")
        def leaderboard_reader():
            client = app.test_client()
            res = client.get(f"/api/exam/room/{room_id}/leaderboard")
            return res.status_code, res.get_json()

        with ThreadPoolExecutor(max_workers=10) as executor:
            lb_futures = [executor.submit(leaderboard_reader) for _ in range(30)]
            for lbf in as_completed(lb_futures):
                st_code, lb_json = lbf.result()
                self.assertEqual(st_code, 200)
                self.assertEqual(lb_json["status"], "ok")
                self.assertEqual(len(lb_json["leaderboard"]), NUM_STUDENTS)

        # Verify correct scores: top student should have 30 points (10 MCQ + 20 Query)
        res_lb = self.client.get(f"/api/exam/room/{room_id}/leaderboard")
        lb_data = res_lb.get_json()["leaderboard"]
        self.assertEqual(lb_data[0]["totalScore"], 30)

        # STEP D: Test Kick -> Re-allow -> Re-join Cycle for a student under load
        test_student = student_records[0]
        ts_id = test_student["studentId"]
        ts_roll = test_student["rollNo"]
        ts_name = test_student["name"]

        # 1. Mentor kicks student
        res_kick = self.client.delete(f"/api/exam/room/{room_id}/student/{ts_id}?mentorId={mentor_id}")
        self.assertEqual(res_kick.status_code, 200)

        # 2. Student attempts re-join while kicked -> MUST be rejected with 'kicked'
        res_blocked = self.client.post(f"/api/exam/room/{room_id}/join", json={
            "name": ts_name,
            "rollNo": ts_roll,
            "branch": "CSE"
        })
        self.assertEqual(res_blocked.status_code, 403)
        self.assertEqual(res_blocked.get_json()["error"], "kicked")

        # 3. Mentor re-allows student
        res_reallow = self.client.post(f"/api/exam/room/{room_id}/student/{ts_id}/reallow", json={
            "mentorId": mentor_id
        })
        self.assertEqual(res_reallow.status_code, 200)

        # 4. Student re-joins room -> MUST succeed seamlessly
        res_rejoin = self.client.post(f"/api/exam/room/{room_id}/join", json={
            "name": ts_name,
            "rollNo": ts_roll,
            "branch": "CSE"
        })
        self.assertEqual(res_rejoin.status_code, 200)
        self.assertEqual(res_rejoin.get_json()["status"], "ok")

        # STEP E: Finish Exam & Export Paper & Archive
        res_finish = self.client.post(f"/api/exam/room/{room_id}/student/{ts_id}/finish")
        self.assertEqual(res_finish.status_code, 200)

        res_end = self.client.post(f"/api/exam/room/{room_id}/end", json={"mentorId": mentor_id})
        self.assertEqual(res_end.status_code, 200)

        res_archive = self.client.get(f"/api/exam/room/{room_id}/archive?mentorId={mentor_id}")
        self.assertEqual(res_archive.status_code, 200)
        self.assertEqual(len(res_archive.get_json()["participants"]), NUM_STUDENTS)

        print(f"[STRESS TEST] MASS CONCURRENCY TEST COMPLETED SUCCESSFULLY!")

if __name__ == "__main__":
    unittest.main()
