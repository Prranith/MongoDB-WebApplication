import sys
import json
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.shared.redis_client import redis_cmd, redis_one

class ProctoringService:
    @staticmethod
    def record_violation(room_id: str, student_id: str, violation_type: str) -> dict:
        participants_json = redis_one(["HGET", f"room:{room_id}", "participants"])
        participants_raw = json.loads(participants_json) if participants_json else {}
        p_val = participants_raw.get(student_id)
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
        participants_raw[student_id] = p

        redis_cmd([
            ["HSET", f"room:{room_id}", "participants", json.dumps(participants_raw)],
        ])

        return {
            "fullscreenExits": p["fullscreenExits"],
            "copyPasteAttempts": p["copyPasteAttempts"],
            "lastFlaggedAt": p["lastFlaggedAt"]
        }

    @staticmethod
    def self_kick(room_id: str, student_id: str, reason: str = "Terminated: Proctoring Rules Violation") -> bool:
        participants_json = redis_one(["HGET", f"room:{room_id}", "participants"])
        participants_raw = json.loads(participants_json) if participants_json else {}
        p_val = participants_raw.get(student_id)
        if p_val:
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
            except Exception:
                p = {}
            p["finished"] = True
            p["finishedAt"] = int(time.time())
            participants_raw[student_id] = p

        kicked_json = redis_one(["HGET", f"room:{room_id}", "kicked"])
        kicked_raw = json.loads(kicked_json) if kicked_json else {}
        if isinstance(kicked_raw, list):
            kicked_raw = {sid: "Terminated by System" for sid in kicked_raw}
        
        kicked_raw[student_id] = reason

        leaderboard_json = redis_one(["HGET", f"room:{room_id}", "leaderboard"])
        leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
        leaderboard_raw.pop(student_id, None)

        redis_cmd([
            ["HSET", f"room:{room_id}", 
             "participants", json.dumps(participants_raw),
             "kicked", json.dumps(kicked_raw),
             "leaderboard", json.dumps(leaderboard_raw)],
        ])
        return True

    @staticmethod
    def kick_student(room_id: str, student_id: str, mentor_id: str, keep_leaderboard: bool) -> bool:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        leaderboard_json = redis_one(["HGET", f"room:{room_id}", "leaderboard"])
        leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
        if not keep_leaderboard:
            leaderboard_raw.pop(student_id, None)

        kicked_json = redis_one(["HGET", f"room:{room_id}", "kicked"])
        kicked_raw = json.loads(kicked_json) if kicked_json else {}
        if isinstance(kicked_raw, list):
            kicked_raw = {sid: "Removed by Mentor" for sid in kicked_raw}
        
        kicked_raw[student_id] = "Removed by Mentor"

        pipeline = [
            ["HSET", f"room:{room_id}",
             "leaderboard", json.dumps(leaderboard_raw),
             "kicked", json.dumps(kicked_raw)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ]
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

        leaderboard_json = redis_one(["HGET", f"room:{room_id}", "leaderboard"])
        leaderboard_raw = json.loads(leaderboard_json) if leaderboard_json else {}
        leaderboard_raw[student_id] = total_score

        kicked_json = redis_one(["HGET", f"room:{room_id}", "kicked"])
        kicked_raw = json.loads(kicked_json) if kicked_json else {}
        if isinstance(kicked_raw, list):
            if student_id in kicked_raw:
                kicked_raw.remove(student_id)
        else:
            kicked_raw.pop(student_id, None)

        pipeline = [
            ["HSET", f"room:{room_id}",
             "leaderboard", json.dumps(leaderboard_raw),
             "kicked", json.dumps(kicked_raw)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ]
        redis_cmd(pipeline)
        return True

    @staticmethod
    def get_kicked_students(room_id: str, mentor_id: str) -> list:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        kicked_json = redis_one(["HGET", f"room:{room_id}", "kicked"])
        kicked_raw = json.loads(kicked_json) if kicked_json else {}
        if isinstance(kicked_raw, list):
            kicked_raw = {sid: "Removed by Mentor" for sid in kicked_raw}

        kicked_students = []
        participants_json = redis_one(["HGET", f"room:{room_id}", "participants"])
        participants_raw = json.loads(participants_json) if participants_json else {}

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
