import sys
import re
import time
import requests
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

class CompilerService:
    @staticmethod
    def _sanitize_java_code(code: str) -> str:
        class_match = re.search(r"\b(?:public\s+)?class\s+(\w+)", code)
        if class_match:
            original_class_name = class_match.group(1)
            if original_class_name != "Main":
                code = re.sub(r"\bclass\s+" + re.escape(original_class_name) + r"\b", "class Main", code)
                code = re.sub(r"\b(public|private|protected)?\s*" + re.escape(original_class_name) + r"\s*\(", r"\1 Main(", code)
        return code

    @classmethod
    def run_piston_api(cls, language: str, code: str, stdin: str = ""):
        lang_map = {
            "python": "python",
            "cpp": "cpp",
            "c": "c",
            "java": "java"
        }
        piston_lang = lang_map.get(language, "python")
        
        filename = "main.py"
        if piston_lang == "java":
            filename = "Main.java"
            code = cls._sanitize_java_code(code)
        elif piston_lang == "cpp":
            filename = "main.cpp"
        elif piston_lang == "c":
            filename = "main.c"

        payload = {
            "language": piston_lang,
            "version": "*",
            "files": [
                {
                    "name": filename,
                    "content": code
                }
            ],
            "stdin": stdin
        }

        try:
            r = requests.post("https://emkc.org/api/v2/piston/execute", json=payload, timeout=8)
            if r.status_code == 200:
                res = r.json()
                compile_res = res.get("compile", {})
                run_res = res.get("run", {})
                
                if compile_res and compile_res.get("code", 0) != 0:
                    stderr = compile_res.get("stderr", "") or compile_res.get("output", "")
                    return {
                        "stdout": "",
                        "stderr": stderr,
                        "code": compile_res.get("code", 1),
                        "output": stderr
                    }
                
                stdout = run_res.get("stdout", "")
                stderr = run_res.get("stderr", "")
                exit_code = run_res.get("code")
                if exit_code is None:
                    exit_code = 0
                
                return {
                    "stdout": stdout,
                    "stderr": stderr,
                    "code": exit_code,
                    "output": stdout if stdout else stderr
                }
        except Exception:
            pass
        return None

    @classmethod
    def run_paiza_api(cls, language: str, code: str, stdin: str = ""):
        lang_map = {
            "python": "python3",
            "cpp": "cpp",
            "c": "c",
            "java": "java"
        }
        paiza_lang = lang_map.get(language, "python3")

        if paiza_lang == "java":
            code = cls._sanitize_java_code(code)

        payload = {
            "source_code": code,
            "language": paiza_lang,
            "input": stdin,
            "api_key": "guest"
        }

        try:
            r_create = requests.post("https://api.paiza.io/runners/create", json=payload, timeout=8)
            if r_create.status_code != 200:
                return {"error": "Failed to create runtime session", "stdout": "", "stderr": f"HTTP status: {r_create.status_code}", "code": 1, "output": ""}
                
            create_res = r_create.json()
            run_id = create_res.get("id")
            if not run_id:
                return {"error": "Failed to obtain runner ID", "stdout": "", "stderr": str(create_res), "code": 1, "output": ""}
                
            for _ in range(10):
                time.sleep(1)
                r_details = requests.get(f"https://api.paiza.io/runners/get_details?id={run_id}&api_key=guest", timeout=8)
                if r_details.status_code == 200:
                    res = r_details.json()
                    status = res.get("status")
                    if status == "completed":
                        build_stderr = res.get("build_stderr") or ""
                        stderr = res.get("stderr") or ""
                        if build_stderr:
                            stderr = build_stderr + ("\n" + stderr if stderr else "")
                        
                        exit_code = res.get("exit_code")
                        if exit_code is None:
                            exit_code = 0
                        try:
                            exit_code = int(exit_code)
                        except (ValueError, TypeError):
                            exit_code = 0
                            
                        if res.get("build_result") == "failure" and exit_code == 0:
                            exit_code = 1

                        return {
                            "stdout": res.get("stdout", ""),
                            "stderr": stderr,
                            "code": exit_code,
                            "output": res.get("stdout", "") or stderr
                        }
                    elif status == "running":
                        continue
                    else:
                        return {
                            "stdout": "",
                            "stderr": f"Execution status: {status}",
                            "code": 1,
                            "output": ""
                        }
            
            return {"error": "Execution timeout", "stdout": "", "stderr": "Program compilation or execution timed out.", "code": 1, "output": ""}
            
        except Exception as e:
            return {"error": str(e), "stdout": "", "stderr": f"Execution failed: {e}", "code": 1, "output": ""}

    @classmethod
    def run_piston_code(cls, language: str, code: str, stdin: str = ""):
        res = cls.run_piston_api(language, code, stdin)
        if res is not None:
            return res
        return cls.run_paiza_api(language, code, stdin)
