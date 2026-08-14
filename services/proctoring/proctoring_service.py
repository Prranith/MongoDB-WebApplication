import sys
import json
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.shared.redis_client import (
    redis_cmd, redis_one, get_room_participants, get_room_kicked_dict
)

class ProctoringService:
    @staticmethod
    def record_violation(room_id: str, student_id: str, violation_type: str) -> dict:
        p_val = redis_one(["HGET", f"room:{room_id}:participants", student_id])
        if not p_val:
            p_val = (get_room_participants(room_id) or {}).get(student_id)
        if not p_val:
            raise KeyError("Student not found")

        try:
            p = json.loads(p_val) if isinstance(p_val, str) else p_val
        except Exception:
            p = {}

        if "fullscreenExits" not in p:
            p["fullscreenExits"] = 0
        if "copyPasteAttempts" not in p:
            p["copyPasteAttempts"] = 0

        if violation_type == "fullscreen_exit":
            p["fullscreenExits"] += 1
        elif violation_type == "copy_paste_attempt":
            p["copyPasteAttempts"] += 1

        p["lastFlaggedAt"] = int(time.time())

        redis_cmd([
            ["HSET", f"room:{room_id}:participants", student_id, json.dumps(p)],
            ["EXPIRE", f"room:{room_id}:participants", str(60 * 60 * 24 * 7)],
        ])

        return {
            "fullscreenExits": p["fullscreenExits"],
            "copyPasteAttempts": p["copyPasteAttempts"],
            "lastFlaggedAt": p["lastFlaggedAt"]
        }

    @staticmethod
    def self_kick(room_id: str, student_id: str, reason: str = "Terminated: Proctoring Rules Violation") -> bool:
        p_val = redis_one(["HGET", f"room:{room_id}:participants", student_id])
        if not p_val:
            p_val = (get_room_participants(room_id) or {}).get(student_id)
        if p_val:
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
            except Exception:
                p = {}
            p["finished"] = True
            p["finishedAt"] = int(time.time())
            redis_cmd([
                ["HSET", f"room:{room_id}:participants", student_id, json.dumps(p)],
                ["EXPIRE", f"room:{room_id}:participants", str(60 * 60 * 24 * 7)],
            ])

        pipeline = [
            ["HSET", f"room:{room_id}:kicked", student_id, reason],
            ["HDEL", f"room:{room_id}:leaderboard", student_id],
            ["EXPIRE", f"room:{room_id}:kicked", str(60 * 60 * 24 * 7)],
        ]
        redis_cmd(pipeline)
        return True

    @staticmethod
    def kick_student(room_id: str, student_id: str, mentor_id: str, keep_leaderboard: bool) -> bool:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        pipeline = [
            ["HSET", f"room:{room_id}:kicked", student_id, "Removed by Mentor"],
            ["EXPIRE", f"room:{room_id}:kicked", str(60 * 60 * 24 * 7)],
        ]
        if not keep_leaderboard:
            pipeline.append(["HDEL", f"room:{room_id}:leaderboard", student_id])

        redis_cmd(pipeline)
        return True

    @staticmethod
    def reallow_student(room_id: str, student_id: str, mentor_id: str) -> bool:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        subs_json = redis_one(["HGET", f"room:{room_id}", f"submissions:{student_id}"])
        submissions = json.loads(subs_json) if subs_json else {}
        total_score = 0
        if submissions:
            for sub_val in submissions.values():
                try:
                    sub = json.loads(sub_val) if isinstance(sub_val, str) else sub_val
                    total_score += sub.get("score", 0)
                except Exception:
                    pass

        p_val = redis_one(["HGET", f"room:{room_id}:participants", student_id])
        if not p_val:
            p_val = (get_room_participants(room_id) or {}).get(student_id)
        if p_val:
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
                p["finished"] = False
                p.pop("finishedAt", None)
                redis_cmd([
                    ["HSET", f"room:{room_id}:participants", student_id, json.dumps(p)],
                    ["EXPIRE", f"room:{room_id}:participants", str(60 * 60 * 24 * 7)],
                ])
            except Exception:
                pass

        score_str = str(int(total_score) if isinstance(total_score, (int, float)) and float(total_score).is_integer() else total_score)
        pipeline = [
            ["HDEL", f"room:{room_id}:kicked", student_id],
            ["HSET", f"room:{room_id}:leaderboard", student_id, score_str],
            ["EXPIRE", f"room:{room_id}:leaderboard", str(60 * 60 * 24 * 7)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ]
        redis_cmd(pipeline)
        return True

    @staticmethod
    def get_kicked_students(room_id: str, mentor_id: str) -> list:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        kicked_raw = get_room_kicked_dict(room_id)
        participants_raw = get_room_participants(room_id)

        kicked_students = []
        for sid, reason in kicked_raw.items():
            p_val = participants_raw.get(sid)
            if p_val:
                try:
                    p = json.loads(p_val) if isinstance(p_val, str) else p_val
                    p["studentId"] = sid
                    p["kickReason"] = reason
                    kicked_students.append(p)
                except Exception:
                    pass
            else:
                kicked_students.append({"studentId": sid, "name": "Unknown", "rollNo": "Unknown", "kickReason": reason})

        return kicked_students
