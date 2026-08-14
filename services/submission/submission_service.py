import sys
import json
import time
import uuid
import mongomock
import traceback
from pathlib import Path
from bson import json_util

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

from core.web_executor import execute as web_execute
from services.shared.redis_client import (
    redis_cmd, redis_one, get_room_kicked_dict, get_room_participants
)
from services.compiler.compiler_service import CompilerService

class SubmissionService:
    @classmethod
    def _normalize_value(cls, val):
        """Recursively normalize values, handling floats, ints, dates, and nested containers."""
        if isinstance(val, dict):
            return {
                k: cls._normalize_value(v) for k, v in val.items()
                if k != "_id" and not (isinstance(k, str) and k.startswith("$"))
            }
        elif isinstance(val, list):
            return [cls._normalize_value(v) for v in val]
        elif isinstance(val, float):
            if val.is_integer():
                return int(val)
            return round(val, 6)
        return val

    @classmethod
    def _normalize_doc(cls, doc: dict) -> dict:
        """Strip _id and normalize types/numbers for comparison."""
        if not isinstance(doc, dict):
            return doc
        return cls._normalize_value(doc)

    @classmethod
    def _sort_key(cls, doc) -> str:
        """Deterministic sort key for a document."""
        if not isinstance(doc, dict):
            return str(doc)
        for v in doc.values():
            if isinstance(v, str):
                return v
        return json.dumps(doc, sort_keys=True, default=str)

    @classmethod
    def grade_query_answer(cls, student_output: list, frozen_answer: list) -> dict:
        """
        Server-side grading: order-insensitive document-level equality.
        Returns { match: bool, score: int }
        """
        if not isinstance(student_output, list) or not isinstance(frozen_answer, list):
            return {"match": False, "score": 0}
        if len(student_output) != len(frozen_answer):
            return {"match": False, "score": 0}
        try:
            norm_student = sorted([cls._normalize_doc(d) for d in student_output], key=cls._sort_key)
            norm_answer = sorted([cls._normalize_doc(d) for d in frozen_answer], key=cls._sort_key)
            match = json.dumps(norm_student, sort_keys=True, default=str) == \
                    json.dumps(norm_answer, sort_keys=True, default=str)
            return {"match": match, "score": 1 if match else 0}
        except Exception:
            return {"match": False, "score": 0}

    @staticmethod
    def execute_room_query(room_id: str, dataset_ids, query: str, max_results: int = 100000):
        """Load datasets from Redis and execute query against them."""
        import json as _json
        from bson import json_util

        try:
            if not isinstance(dataset_ids, list):
                if dataset_ids:
                    dataset_ids = [dataset_ids]
                else:
                    dataset_ids = []

            # Build temp mongomock DB
            temp_client = mongomock.MongoClient()
            temp_db = temp_client["exam_db"]

            # Batch HMGET for all dataset docs and metadata to optimize DB roundtrips
            hmget_fields = []
            for d_id in dataset_ids:
                if d_id:
                    hmget_fields.extend([f"dataset_docs:{d_id}", f"dataset_meta:{d_id}"])
            
            raw_data = []
            if hmget_fields:
                raw_data = redis_one(["HMGET", f"room:{room_id}"] + hmget_fields) or []

            loaded_count = 0
            idx = 0
            for d_id in dataset_ids:
                if not d_id:
                    continue
                docs_json = raw_data[idx] if idx < len(raw_data) else None
                meta_json = raw_data[idx+1] if idx+1 < len(raw_data) else None
                idx += 2

                if not docs_json:
                    continue
                try:
                    docs = json.loads(docs_json)
                except Exception:
                    continue

                meta = {}
                if meta_json:
                    try:
                        meta = json.loads(meta_json)
                    except Exception:
                        pass
                raw_name = meta.get("name", "")
                raw_coll = meta.get("collection", "")

                names_to_register = set()
                if raw_name:
                    names_to_register.add(raw_name)
                    names_to_register.add(raw_name.lower())
                    names_to_register.add("".join(c for c in raw_name.lower() if c.isalnum() or c == "_"))
                if raw_coll:
                    names_to_register.add(raw_coll)
                    names_to_register.add(raw_coll.lower())
                names_to_register.add(d_id)

                if docs:
                    for coll in names_to_register:
                        if coll:
                            try:
                                parsed_docs = json_util.loads(_json.dumps(docs))
                                for d in parsed_docs:
                                    if isinstance(d, dict):
                                        d.pop("_id", None)
                                if parsed_docs:
                                    temp_db[coll].insert_many(parsed_docs)
                            except Exception:
                                pass
                    loaded_count += 1

            if loaded_count == 0:
                return {"status": "error", "error": "No datasets found/loaded in room"}

            result = web_execute(query, max_results=max_results, db=temp_db)
            res_dict = result.to_dict()
            res_dict["results"] = res_dict.get("data") if res_dict.get("data") is not None else []
            return res_dict
        except Exception as e:
            return {"status": "error", "error": f"Execution error: {str(e)}", "traceback": traceback.format_exc()}

    @classmethod
    def submit_answer(cls, room_id: str, student_id: str, question_id: str, q_type: str, marks: int, body: dict) -> dict:
        fields = [
            "status", "questions",
            f"q_answer:{question_id}", f"submissions:{student_id}"
        ]
        raw = redis_one(["HMGET", f"room:{room_id}"] + fields)
        if not raw or all(v is None for v in raw):
            raise KeyError("Room not found")

        status = raw[0]
        questions_json = raw[1]
        frozen_json = raw[2]
        subs_json = raw[3]

        # Validate room is live
        if status != "live":
            raise ValueError("Exam is not live")

        # Validate student is not kicked
        kicked_raw = get_room_kicked_dict(room_id)
        if student_id in kicked_raw:
            reason = kicked_raw.get(student_id, "Removed by Mentor")
            raise PermissionError(f"kicked:{reason}")

        score = 0
        now = int(time.time())
        passed_count = 0
        total_count = 0
        all_passed = False

        # Fetch previous submission early to support auto-save or delta calculations
        submissions = json.loads(subs_json) if subs_json else {}
        prev_submission_json = submissions.get(question_id)
        prev_score = 0
        prev_sub = {}
        if prev_submission_json:
            try:
                prev_sub = json.loads(prev_submission_json) if isinstance(prev_submission_json, str) else prev_submission_json
                prev_score = prev_sub.get("score", 0)
            except Exception:
                pass

        is_auto_save = body.get("isAutoSave", False) in [True, "true", "True", 1, "1"]
        if is_auto_save:
            if q_type == "mcq":
                is_multi = False
                if questions_json:
                    try:
                        questions = json.loads(questions_json)
                        for q in questions:
                          if q.get("id") == question_id:
                              is_multi = q.get("isMultiSelect", False) in [True, "true", "True", 1, "1"]
                              break
                    except Exception:
                        pass
                if is_multi:
                    student_choices = []
                    for x in body.get("selectedOptions", []):
                        try:
                            student_choices.append(int(x))
                        except Exception:
                            pass
                    submission = json.dumps({
                        "type": "mcq",
                        "selectedOptions": student_choices,
                        "score": prev_score,
                        "isAutoSave": True,
                        "submittedAt": now,
                    })
                else:
                    student_choice = None
                    if body.get("selectedOption") is not None:
                        try:
                            student_choice = int(body.get("selectedOption"))
                        except Exception:
                            pass
                    submission = json.dumps({
                        "type": "mcq",
                        "selectedOption": student_choice,
                        "score": prev_score,
                        "isAutoSave": True,
                        "submittedAt": now,
                    })
            elif q_type == "coding":
                code = body.get("code", "")
                language = body.get("language", "python")
                submission = json.dumps({
                    "type": "coding",
                    "code": code,
                    "language": language,
                    "score": prev_score,
                    "allPassed": prev_sub.get("allPassed", False),
                    "passedCount": prev_sub.get("passedCount", 0),
                    "totalCount": prev_sub.get("totalCount", 0),
                    "isAutoSave": True,
                    "submittedAt": now,
                })
            else:  # query
                query = body.get("query", "")
                submission = json.dumps({
                    "type": "query",
                    "query": query,
                    "score": prev_score,
                    "isAutoSave": True,
                    "submittedAt": now,
                })

            submissions[question_id] = submission
            pipeline = [
                ["HSET", f"room:{room_id}", f"submissions:{student_id}", json.dumps(submissions)],
                ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
            ]
            redis_cmd(pipeline)

            return {
                "score": prev_score,
                "maxMarks": marks,
                "autoSaved": True
            }

        if q_type == "mcq":
            is_multi = False
            correct_options = []
            correct_option = ""
            partial_grading = False

            if questions_json:
                try:
                    questions = json.loads(questions_json)
                    for q in questions:
                        if q.get("id") == question_id:
                            is_multi = q.get("isMultiSelect", False) in [True, "true", "True", 1, "1"]
                            correct_options = q.get("correctOptions", [])
                            correct_option = q.get("correctOption", "")
                            partial_grading = q.get("partialGrading") in [True, "true", "True", 1, "1"]
                            try:
                                marks = int(q.get("marks", marks))
                            except Exception:
                                pass
                            break
                except Exception:
                    pass

            if is_multi:
                student_choices = []
                for x in body.get("selectedOptions", []):
                    try:
                        student_choices.append(int(x))
                    except Exception:
                        pass
                        
                correct_choices = []
                for x in correct_options:
                    try:
                        correct_choices.append(int(x))
                    except Exception:
                        pass
                
                if not correct_choices and correct_option != "":
                    try:
                        correct_choices = [int(correct_option)]
                    except Exception:
                        pass

                if correct_choices and set(student_choices) == set(correct_choices):
                    score = marks
                elif partial_grading and correct_choices and student_choices:
                    incorrect = set(student_choices) - set(correct_choices)
                    if incorrect:
                        score = 0
                    else:
                        score = float(marks) * (len(student_choices) / len(correct_choices))
                        score = round(score, 2)
                else:
                    score = 0

                submission = json.dumps({
                    "type": "mcq",
                    "selectedOptions": student_choices,
                    "score": score,
                    "isAutoSave": False,
                    "submittedAt": now,
                })
            else:
                raw_selected = body.get("selectedOption")
                student_choice = str(raw_selected).strip() if raw_selected is not None else ""
                correct_choice = str(correct_option).strip() if correct_option is not None else ""
                score = marks if student_choice != "" and student_choice == correct_choice else 0
                submission = json.dumps({
                    "type": "mcq",
                    "selectedOption": raw_selected,
                    "score": score,
                    "isAutoSave": False,
                    "submittedAt": now,
                })

        elif q_type == "coding":
            code = body.get("code", "")
            language = body.get("language", "python")

            test_cases = []
            template_type = "scratch"
            driver_code = ""
            if questions_json:
                try:
                    questions = json.loads(questions_json)
                    for q in questions:
                        if q.get("id") == question_id:
                            test_cases = q.get("testCases", [])
                            template_type = q.get("templateType", "scratch")
                            driver_code = q.get("templates", {}).get(language, {}).get("driverCode", "")
                            break
                except Exception:
                    pass

            if template_type == "solve_function" and driver_code:
                code = code + "\n\n" + driver_code

            passed_count = 0
            total_count = len(test_cases)
            for tc in test_cases:
                tc_input = tc.get("input", "")
                tc_expected = tc.get("expectedOutput", "")

                run_res = CompilerService.run_piston_code(language, code, tc_input)
                actual_out = run_res.get("stdout", "")
                if run_res.get("stderr"):
                    actual_out += "\n" + run_res.get("stderr")

                actual_lines = [line.strip() for line in actual_out.strip().splitlines() if line.strip()]
                expected_lines = [line.strip() for line in tc_expected.strip().splitlines() if line.strip()]

                try:
                    res_code = int(run_res.get("code", 0))
                except (ValueError, TypeError):
                    res_code = 0

                matched = (actual_lines == expected_lines) and (res_code == 0)
                if matched:
                    passed_count += 1

            all_passed = (passed_count == total_count) if total_count > 0 else True
            if total_count > 0:
                score = round((float(marks) / total_count) * passed_count, 2)
            else:
                score = marks

            submission = json.dumps({
                "type": "coding",
                "code": code,
                "language": language,
                "score": score,
                "allPassed": all_passed,
                "passedCount": passed_count,
                "totalCount": total_count,
                "isAutoSave": False,
                "submittedAt": now,
            })

        else:  # query question
            query = body.get("query", "").strip()
            dataset_ids = body.get("datasetIds", [])
            if not dataset_ids and body.get("datasetId"):
                dataset_ids = [body.get("datasetId")]
            student_output = body.get("studentOutput", [])

            # Run student query server-side for grading
            if query and dataset_ids:
                result = cls.execute_room_query(room_id, dataset_ids, query, max_results=100000)
                if result.get("status") == "ok":
                    student_output = result.get("results", [])

            # Fetch frozen answer
            frozen_answer = []
            if frozen_json:
                try:
                    frozen_answer = json.loads(frozen_json)
                except Exception:
                    pass

            grade = cls.grade_query_answer(student_output, frozen_answer)
            score = marks if grade["match"] else 0

            submission = json.dumps({
                "type": "query",
                "query": query,
                "score": score,
                "isAutoSave": False,
                "submittedAt": now,
            })

        score_delta = score - prev_score

        # Calculate total student score across all their submissions directly
        submissions[question_id] = submission
        total_student_score = 0
        for sub_item in submissions.values():
            try:
                sub_parsed = json.loads(sub_item) if isinstance(sub_item, str) else sub_item
                total_student_score += sub_parsed.get("score", 0)
            except Exception:
                pass

        score_val_str = str(int(total_student_score) if isinstance(total_student_score, (int, float)) and float(total_student_score).is_integer() else total_student_score)

        pipeline = [
            ["HSET", f"room:{room_id}", f"submissions:{student_id}", json.dumps(submissions), f"score:{student_id}", score_val_str],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ]
        redis_cmd(pipeline)

        ret_data = {
            "score": score,
            "maxMarks": marks,
        }
        if q_type == "coding":
            ret_data["correct"] = all_passed
            ret_data["passedCount"] = passed_count
            ret_data["totalCount"] = total_count
        else:
            ret_data["correct"] = score > 0

        return ret_data

    @staticmethod
    def get_expected_preview(room_id: str, question_id: str) -> dict:
        frozen_json = redis_one(["HGET", f"room:{room_id}", f"q_answer:{question_id}"])
        if not frozen_json:
            raise KeyError("No frozen answer found")
        try:
            docs = json.loads(frozen_json)
        except Exception:
            raise ValueError("Failed to parse frozen answer")

        return {
            "docCount": len(docs),
            "preview": docs[:5],
        }

    @classmethod
    def freeze_answer(cls, room_id: str, mentor_id: str, question_id: str, dataset_ids: list, query: str) -> dict:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        result = cls.execute_room_query(room_id, dataset_ids, query, max_results=100000)
        if result.get("status") == "error":
            raise ValueError(result.get("error", "Query execution failed"))

        docs = result.get("results", [])
        stored_docs = docs[:2000]

        redis_cmd([
            ["HSET", f"room:{room_id}", f"q_answer:{question_id}", json.dumps(stored_docs)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ])

        return {
            "questionId": question_id,
            "docCount": len(docs),
            "preview": docs[:3]
        }

    @staticmethod
    def finish_exam(room_id: str, student_id: str) -> bool:
        p_val = redis_one(["HGET", f"room:{room_id}", f"participant:{student_id}"])
        if not p_val:
            p_val = (get_room_participants(room_id) or {}).get(student_id)
        if not p_val:
            raise KeyError("Student not found")
        try:
            p = json.loads(p_val) if isinstance(p_val, str) else p_val
        except Exception:
            p = {}

        p["finished"] = True
        p["finishedAt"] = int(time.time())

        redis_cmd([
            ["HSET", f"room:{room_id}", f"participant:{student_id}", json.dumps(p)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ])
        return True

    @staticmethod
    def upload_dataset(room_id: str, mentor_id: str, name: str, docs: list) -> dict:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        dataset_id = str(uuid.uuid4())[:8]
        safe_name = "".join(c for c in name.lower() if c.isalnum() or c == "_")
        collection_name = safe_name

        datasets_json = redis_one(["HGET", f"room:{room_id}", "datasets"])
        datasets_dict = json.loads(datasets_json) if datasets_json else {}
        datasets_dict[dataset_id] = {
            "name": name,
            "collection": collection_name,
            "docCount": len(docs)
        }

        pipeline = [
            ["HSET", f"room:{room_id}",
             f"dataset_meta:{dataset_id}", json.dumps({"name": name, "collection": collection_name, "docCount": len(docs)}),
             f"dataset_docs:{dataset_id}", json.dumps(docs),
             "datasets", json.dumps(datasets_dict)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)],
        ]
        redis_cmd(pipeline)

        return {
            "datasetId": dataset_id,
            "name": name,
            "collection": collection_name,
            "docCount": len(docs)
        }

    @staticmethod
    def delete_dataset(room_id: str, mentor_id: str, dataset_id: str) -> bool:
        raw_mentor = redis_one(["HGET", f"room:{room_id}", "mentorId"])
        if not raw_mentor or raw_mentor != mentor_id:
            raise PermissionError("Unauthorized")

        datasets_json = redis_one(["HGET", f"room:{room_id}", "datasets"])
        datasets_dict = json.loads(datasets_json) if datasets_json else {}
        datasets_dict.pop(dataset_id, None)

        redis_cmd([
            ["HDEL", f"room:{room_id}", f"dataset_meta:{dataset_id}", f"dataset_docs:{dataset_id}"],
            ["HSET", f"room:{room_id}", "datasets", json.dumps(datasets_dict)],
            ["EXPIRE", f"room:{room_id}", str(60 * 60 * 24 * 7)]
        ])
        return True

    @staticmethod
    def get_dataset_schema(room_id: str, dataset_id: str) -> dict:
        docs_json = redis_one(["HGET", f"room:{room_id}", f"dataset_docs:{dataset_id}"])
        if not docs_json:
            raise KeyError("Dataset not found")

        try:
            docs = json.loads(docs_json)
        except Exception:
            raise ValueError("Parse error")

        schema = {}
        sample = docs[:50]
        for doc in sample:
            if isinstance(doc, dict):
                for k, v in doc.items():
                    if k not in schema:
                        schema[k] = type(v).__name__

        meta_json = redis_one(["HGET", f"room:{room_id}", f"dataset_meta:{dataset_id}"])
        meta = json.loads(meta_json) if meta_json else {}

        return {
            "schema": schema,
            "collection": meta.get("collection", ""),
            "docCount": len(docs),
            "sampleDocs": docs[:5]
        }

    @staticmethod
    def run_piston_code(room_id: str, question_id: str, language: str, code: str, stdins) -> list:
        if question_id:
            questions_json = redis_one(["HGET", f"room:{room_id}", "questions"])
            if questions_json:
                try:
                    questions = json.loads(questions_json)
                    for q in questions:
                        if q.get("id") == question_id:
                            if q.get("templateType") == "solve_function":
                                driver = q.get("templates", {}).get(language, {}).get("driverCode", "")
                                if driver:
                                    code = code + "\n\n" + driver
                            break
                except Exception:
                    pass

        if isinstance(stdins, list):
            from concurrent.futures import ThreadPoolExecutor
            
            def run_single(inp):
                res = CompilerService.run_piston_code(language, code, inp)
                try:
                    code_val = int(res.get("code", 0))
                except (ValueError, TypeError):
                    code_val = 0
                return {
                    "stdout": res.get("stdout", ""),
                    "stderr": res.get("stderr", ""),
                    "code": code_val,
                    "output": res.get("output", "")
                }
                
            with ThreadPoolExecutor(max_workers=min(len(stdins), 6)) as executor:
                results = list(executor.map(run_single, stdins))
            return results
        else:
            stdin = stdins or ""
            res = CompilerService.run_piston_code(language, code, stdin)
            try:
                code_val = int(res.get("code", 0))
            except (ValueError, TypeError):
                code_val = 0
            return [{
                "stdout": res.get("stdout", ""),
                "stderr": res.get("stderr", ""),
                "code": code_val,
                "output": res.get("output", "")
            }]

    @staticmethod
    def generate_test_cases(language: str, code: str, inputs: list, template_type: str, driver_code: str) -> list:
        if template_type == "solve_function" and driver_code:
            code = code + "\n\n" + driver_code

        from concurrent.futures import ThreadPoolExecutor

        def gen_single(inp):
            res = CompilerService.run_piston_code(language, code, inp)
            try:
                code_val = int(res.get("code", 0))
            except (ValueError, TypeError):
                code_val = 0
            return {
                "stdout": res.get("stdout", ""),
                "stderr": res.get("stderr", ""),
                "code": code_val,
                "output": res.get("output", "")
            }

        with ThreadPoolExecutor(max_workers=min(len(inputs), 6)) as executor:
            task_results = list(executor.map(gen_single, inputs))

        outputs = []
        for tr in task_results:
            if tr["code"] != 0 or tr["stderr"]:
                raise ValueError(f"Execution failed: {tr['stderr'] or tr['stdout']}")
            outputs.append(tr["stdout"])

        return outputs
