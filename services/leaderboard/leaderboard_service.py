import sys
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.shared.redis_client import (
    redis_one, get_room_participants, get_room_leaderboard_dict, get_room_kicked_dict
)

class LeaderboardService:
    @staticmethod
    def _extract_sub_metrics(subs_raw: dict):
        """Safely extract answered count, correct count, and last submission timestamp."""
        if not subs_raw or not isinstance(subs_raw, dict):
            return 0, 0, 0
        answered = len(subs_raw)
        correct = 0
        last_sub_time = 0
        for v in subs_raw.values():
            try:
                sub = json.loads(v) if isinstance(v, str) else v
                if isinstance(sub, dict):
                    if sub.get("score", 0) > 0:
                        correct += 1
                    t = sub.get("submittedAt", 0)
                    if t and t > last_sub_time:
                        last_sub_time = t
            except Exception:
                pass
        return answered, correct, last_sub_time

    @classmethod
    def get_room_leaderboard(cls, room_id: str) -> dict:
        leaderboard_raw = get_room_leaderboard_dict(room_id)
        participants_raw = get_room_participants(room_id)
        kicked_raw = get_room_kicked_dict(room_id)

        ranked = []
        for sid, score in leaderboard_raw.items():
            try:
                total_score = float(score)
            except Exception:
                total_score = 0.0

            p_val = participants_raw.get(sid)
            student_info = {"name": "Unknown", "rollNo": "-", "branch": "-", "joinedAt": 0}
            if p_val:
                try:
                    student_info = json.loads(p_val) if isinstance(p_val, str) else p_val
                except Exception:
                    pass

            subs_json = redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
            subs_raw = json.loads(subs_json) if subs_json else {}
            answered, correct, last_sub_time = cls._extract_sub_metrics(subs_raw)

            ranked.append({
                "studentId": sid,
                "name": student_info.get("name", "Unknown"),
                "rollNo": student_info.get("rollNo", "-"),
                "branch": student_info.get("branch", "-"),
                "totalScore": int(total_score),
                "answered": answered,
                "correct": correct,
                "lastSubmission": last_sub_time,
                "isBlocked": sid in kicked_raw,
                "blockReason": kicked_raw.get(sid, ""),
            })

        for sid, p_val in participants_raw.items():
            if not any(r["studentId"] == sid for r in ranked):
                student_info = {"name": "Unknown", "rollNo": "-", "branch": "-", "joinedAt": 0}
                if p_val:
                    try:
                        student_info = json.loads(p_val) if isinstance(p_val, str) else p_val
                    except Exception:
                        pass
                subs_json = redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
                subs_raw = json.loads(subs_json) if subs_json else {}
                answered, correct, last_sub_time = cls._extract_sub_metrics(subs_raw)
                ranked.append({
                    "studentId": sid,
                    "name": student_info.get("name", "Unknown"),
                    "rollNo": student_info.get("rollNo", "-"),
                    "branch": student_info.get("branch", "-"),
                    "totalScore": 0,
                    "answered": answered,
                    "correct": correct,
                    "lastSubmission": last_sub_time,
                    "isBlocked": sid in kicked_raw,
                    "blockReason": kicked_raw.get(sid, ""),
                })

        ranked.sort(key=lambda r: (-r["totalScore"], r["studentId"]))

        questions_json = redis_one(["HGET", f"room:{room_id}", "questions"])
        max_score = 0
        total_questions = 0
        if questions_json:
            try:
                questions = json.loads(questions_json)
                total_questions = len(questions)
                max_score = sum(int(q.get("marks", 0)) for q in questions)
            except Exception:
                pass

        return {
            "leaderboard": ranked,
            "maxScore": max_score,
            "totalQuestions": total_questions,
        }

    @staticmethod
    def get_student_submissions(room_id: str, student_id: str, mentor_id: str, is_student: bool) -> dict:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor:
            raise KeyError("Room not found")
        if not is_student and raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        subs_json = redis_one(["HGET", f"room:{room_id}", f"submissions:{student_id}"])
        submissions_raw = json.loads(subs_json) if subs_json else {}
        submissions = {}
        if submissions_raw:
            for q_id, sub_val in submissions_raw.items():
                try:
                    submissions[q_id] = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
                except Exception:
                    pass
        return submissions

    @staticmethod
    def get_room_archive(room_id: str, mentor_id: str) -> dict:
        fields = ["title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt", "questions", "participants", "datasets", "kicked", "leaderboard"]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or raw[1] is None:
            raise KeyError("Room not found")
        if raw[1] != mentor_id:
            raise PermissionError("Unauthorized")

        meta_keys = ["title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt"]
        meta = {}
        for k, v in zip(meta_keys, raw[:8]):
            if v is not None:
                meta[k] = v

        questions = json.loads(raw[8]) if raw[8] else []
        participants_raw = get_room_participants(room_id)
        datasets_raw = json.loads(raw[10]) if raw[10] else {}
        kicked = get_room_kicked_dict(room_id)
        leaderboard = get_room_leaderboard_dict(room_id)

        submissions = {}
        for sid in participants_raw.keys():
            subs_json = redis_one(["HGET", f"room:{room_id}", f"submissions:{sid}"])
            if subs_json:
                try:
                    raw_subs = json.loads(subs_json)
                    parsed_subs = {}
                    for qid, sub_val in raw_subs.items():
                        try:
                            parsed_subs[qid] = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
                        except Exception:
                            parsed_subs[qid] = sub_val
                    submissions[sid] = parsed_subs
                except Exception:
                    pass

        return {
            "roomId": room_id,
            "meta": meta,
            "questions": questions,
            "datasets": datasets_raw,
            "participants": participants_raw,
            "kicked": kicked,
            "leaderboard": leaderboard,
            "submissions": submissions,
        }
