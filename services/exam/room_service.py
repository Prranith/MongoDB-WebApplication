import sys
import json
import string
import random
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from services.shared.redis_client import (
    redis_cmd, redis_one, hgetall, room_key,
    get_room_participants, get_room_leaderboard_dict, get_room_kicked_dict
)

class RoomService:
    @staticmethod
    def _gen_room_id() -> str:
        """Generate a unique 6-char alphanumeric Room ID (e.g. MNG-4X9)."""
        chars = string.ascii_uppercase + string.digits
        for _ in range(20):  # max 20 attempts
            part1 = "MNG"
            part2 = "".join(random.choices(chars, k=3))
            room_id = f"{part1}-{part2}"
            # Collision check
            exists = redis_one(["EXISTS", f"room:{room_id}"])
            if not exists:
                return room_id
        # Fallback: longer random id
        return "MNG-" + "".join(random.choices(chars, k=4))

    @classmethod
    def create_room(cls, title: str, mentor_id: str, timed: bool, duration: int, fullscreen_mode: bool, block_copypaste: bool, max_exits: int) -> dict:
        room_id = cls._gen_room_id()
        now = int(time.time())

        fullscreen_val = "1" if fullscreen_mode else "0"
        block_cp_val = "1" if block_copypaste else "0"
        max_exits_val = str(max_exits)

        pipeline = [
            ["HSET", room_key(room_id),
             "title", title,
             "mentorId", mentor_id,
             "timed", "1" if timed else "0",
             "duration", str(duration),
             "status", "waiting",
             "createdAt", str(now),
             "fullscreenMode", fullscreen_val,
             "blockCopyPaste", block_cp_val,
             "maxFullscreenExits", max_exits_val],
            ["EXPIRE", room_key(room_id), str(60 * 60 * 24 * 7)],  # 7-day TTL
        ]
        res = redis_cmd(pipeline)
        if res is None:
            raise RuntimeError("Redis unavailable")

        return {
            "roomId": room_id,
            "mentorId": mentor_id,
            "title": title
        }

    @staticmethod
    def get_room(room_id: str, client_mentor_id: str = "") -> dict:
        fields = [
            "title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt",
            "questions", "datasets", "fullscreenMode", "blockCopyPaste", "maxFullscreenExits"
        ]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or all(v is None for v in raw):
            raise KeyError("Room not found")

        meta_keys = [
            "title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt",
            "fullscreenMode", "blockCopyPaste", "maxFullscreenExits"
        ]
        meta = {}
        for k, v in zip(meta_keys, raw[:8] + [raw[10], raw[11], raw[12]]):
            if v is not None:
                meta[k] = v
            else:
                if k in ["fullscreenMode", "blockCopyPaste"]:
                    meta[k] = "0"
                elif k == "maxFullscreenExits":
                    meta[k] = "5"

        questions_json = raw[8]
        datasets_json = raw[9]

        questions = []
        if questions_json:
            try:
                questions = json.loads(questions_json)
            except Exception:
                pass

        # Strip correctOption from questions if not mentor
        is_mentor = client_mentor_id == meta.get("mentorId", "")
        if not is_mentor:
            for q in questions:
                if q.get("type") == "mcq":
                    q.pop("correctOption", None)

        participants_raw = get_room_participants(room_id)
        participants = []
        for sid, p_val in participants_raw.items():
            try:
                p = json.loads(p_val) if isinstance(p_val, str) else p_val
                p["studentId"] = sid
                participants.append(p)
            except Exception:
                pass

        datasets_raw = json.loads(datasets_json) if datasets_json else {}
        datasets = []
        for ds_id, ds_val in datasets_raw.items():
            try:
                ds = json.loads(ds_val) if isinstance(ds_val, str) else ds_val
                ds["datasetId"] = ds_id
                datasets.append(ds)
            except Exception:
                pass

        kicked = get_room_kicked_dict(room_id)

        return {
            "roomId": room_id,
            "meta": meta,
            "questions": questions,
            "participants": participants,
            "datasets": datasets,
            "kicked": kicked
        }

    @staticmethod
    def get_room_status(room_id: str) -> dict:
        fields = ["status", "startedAt", "endedAt"]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or all(v is None for v in raw):
            raise KeyError("Room not found")

        status = raw[0] or "waiting"
        started_at = None
        if raw[1]:
            try:
                started_at = int(float(raw[1]))
            except Exception:
                started_at = None

        ended_at = None
        if raw[2]:
            try:
                ended_at = int(float(raw[2]))
            except Exception:
                ended_at = None

        kicked = get_room_kicked_dict(room_id)

        return {
            "roomStatus": status,
            "startedAt": started_at,
            "endedAt": ended_at,
            "kicked": kicked
        }

    @staticmethod
    def join_room(room_id: str, name: str, roll_no: str, branch: str) -> dict:
        fields = ["title", "mentorId", "timed", "duration", "status", "createdAt", "startedAt", "endedAt"]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or all(v is None for v in raw):
            raise KeyError("Room not found")

        meta = {}
        for k, v in zip(fields, raw):
            if v is not None:
                meta[k] = v

        status = meta.get("status", "")
        if status not in ("waiting", "live"):
            raise ValueError(f"Room is {status or 'closed'}")

        participants_raw = get_room_participants(room_id)
        existing_student_id = None
        
        if participants_raw:
            for sid, p_val in participants_raw.items():
                try:
                    p = json.loads(p_val) if isinstance(p_val, str) else p_val
                    if p.get("rollNo") == roll_no:
                        if p.get("name", "").lower() == name.lower():
                            existing_student_id = sid
                        else:
                            raise PermissionError("Roll number already in use by another name")
                except PermissionError:
                    raise
                except Exception:
                    pass

        kicked_raw = get_room_kicked_dict(room_id)

        if existing_student_id:
            student_id = existing_student_id
            if student_id in kicked_raw:
                reason = kicked_raw.get(student_id, "Removed by Mentor")
                raise PermissionError(f"kicked:{reason}")

            p_val = participants_raw.get(student_id)
            if p_val:
                try:
                    p = json.loads(p_val) if isinstance(p_val, str) else p_val
                except Exception:
                    p = {}
                if p.get("finished"):
                    raise FileExistsError("already_submitted")
        else:
            student_id = str(uuid.uuid4())[:8]

        now = int(time.time())
        student_data = {
            "name": name,
            "rollNo": roll_no,
            "branch": branch,
            "joinedAt": now
        }

        # Atomic per-student Redis writes (eliminates concurrent join clobbering)
        pipeline = [
            ["HSET", f"room:{room_id}:participants", student_id, json.dumps(student_data)],
            ["HSETNX", f"room:{room_id}:leaderboard", student_id, "0"],
            ["EXPIRE", f"room:{room_id}:participants", str(60 * 60 * 24 * 7)],
            ["EXPIRE", f"room:{room_id}:leaderboard", str(60 * 60 * 24 * 7)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)]
        ]
        redis_cmd(pipeline)

        return {
            "studentId": student_id,
            "roomId": room_id,
            "roomTitle": meta.get("title", ""),
            "roomStatus": meta.get("status", "waiting")
        }
        redis_cmd(pipeline)

        return {
            "studentId": student_id,
            "roomId": room_id,
            "roomTitle": meta.get("title", ""),
            "roomStatus": meta.get("status", "waiting")
        }

    @staticmethod
    def start_room(room_id: str, mentor_id: str) -> int:
        meta = hgetall(room_key(room_id))
        if not meta:
            raise KeyError("Room not found")
        if meta.get("mentorId") != mentor_id:
            raise PermissionError("Unauthorized")

        now = int(time.time())
        redis_cmd([
            ["HSET", room_key(room_id), "status", "live", "startedAt", str(now)]
        ])
        return now

    @staticmethod
    def end_room(room_id: str, mentor_id: str) -> int:
        meta = hgetall(room_key(room_id))
        if not meta:
            raise KeyError("Room not found")
        if meta.get("mentorId") != mentor_id:
            raise PermissionError("Unauthorized")

        now = int(time.time())
        redis_cmd([
            ["HSET", room_key(room_id), "status", "ended", "endedAt", str(now)]
        ])
        return now

    @staticmethod
    def save_questions(room_id: str, mentor_id: str, questions: list) -> int:
        from services.submission.submission_service import SubmissionService

        raw = redis_one(["HMGET", f"room:{room_id}", "mentorId", "questions"])
        if not raw or raw[0] is None:
            raise KeyError("Room not found")
        if raw[0] != mentor_id:
            raise PermissionError("Unauthorized")

        old_questions = []
        if raw[1]:
            try:
                old_questions = json.loads(raw[1])
            except Exception:
                pass

        old_ids = {q.get("id") for q in old_questions if q.get("id")}
        new_ids = {q.get("id") for q in questions if q.get("id")}
        deleted_ids = old_ids - new_ids

        pipeline = [
            ["HSET", f"room:{room_id}", "questions", json.dumps(questions)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)]
        ]

        # Auto-freeze query expected answers
        for q in questions:
            q_id = q.get("id")
            q_type = q.get("type", "query")
            if q_type == "query" and q_id:
                exists = redis_one(["HEXISTS", f"room:{room_id}", f"q_answer:{q_id}"])
                if not exists or str(exists) in ("0", "None"):
                    query = q.get("expectedQuery", "").strip()
                    dataset_ids = q.get("datasetIds", [])
                    if not dataset_ids and q.get("datasetId"):
                        dataset_ids = [q.get("datasetId")]
                    if query and dataset_ids:
                        res = SubmissionService.execute_room_query(room_id, dataset_ids, query, max_results=100000)
                        if res.get("status") == "ok":
                            docs = res.get("results", [])
                            pipeline.append(["HSET", f"room:{room_id}", f"q_answer:{q_id}", json.dumps(docs[:2000])])

        if deleted_ids:
            hdel_cmd = ["HDEL", f"room:{room_id}"]
            for q_id in deleted_ids:
                hdel_cmd.append(f"q_answer:{q_id}")
            pipeline.append(hdel_cmd)

        redis_cmd(pipeline)
        return len(questions)

    @staticmethod
    def get_paper(room_id: str, mentor_id: str) -> dict:
        fields = [
            "title", "mentorId", "timed", "duration", "fullscreenMode",
            "blockCopyPaste", "maxFullscreenExits", "questions", "datasets"
        ]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or raw[1] is None:
            raise KeyError("Room not found")
        if raw[1] != mentor_id:
            raise PermissionError("Unauthorized")

        questions = json.loads(raw[7]) if raw[7] else []
        datasets_dict = json.loads(raw[8]) if raw[8] else {}

        datasets_list = []
        for d_id, d_meta in datasets_dict.items():
            docs_json = redis_one(["HGET", f"room:{room_id}", f"dataset_docs:{d_id}"])
            docs = json.loads(docs_json) if docs_json else []
            datasets_list.append({
                "datasetId": d_id,
                "name": d_meta.get("name", ""),
                "collection": d_meta.get("collection", ""),
                "docs": docs
            })

        return {
            "title": raw[0] or "Quiz",
            "timed": raw[2] or "0",
            "duration": raw[3] or "60",
            "fullscreenMode": raw[4] or "0",
            "blockCopyPaste": raw[5] or "0",
            "maxFullscreenExits": raw[6] or "5",
            "questions": questions,
            "datasets": datasets_list
        }

    @staticmethod
    def cleanup_room(room_id: str, mentor_id: str) -> bool:
        meta = hgetall(room_key(room_id))
        if not meta:
            raise KeyError("Room not found")
        if meta.get("mentorId") != mentor_id:
            raise PermissionError("Unauthorized")

        redis_one(["DEL", f"room:{room_id}"])
        return True
