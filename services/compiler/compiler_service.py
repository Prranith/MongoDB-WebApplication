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
        # Kept as a compatibility shim for callers that used the old helper.
        # Java source must be executed exactly as submitted; renaming classes
        # breaks constructors, references, and public-class/file-name rules.
        return code

    @staticmethod
    def _java_entry_class(code: str, filename: str = "") -> str:
        """Return the submitted Java class containing ``main``.

        A real workspace filename is authoritative, so ``Test.java`` runs as
        ``Test`` without inspecting or rewriting the source. The source scan
        is only a fallback for exam submissions, which historically did not
        include a filename in their execution request.
        """
        stem = Path(str(filename or "")).stem
        if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", stem or ""):
            return stem
        # Ignore comments so a commented example such as ``class Main`` does
        # not get selected over the actual submitted class.
        source = re.sub(r"/\*.*?\*/|//[^\n]*", "", code, flags=re.DOTALL)
        declarations = list(re.finditer(
            r"\b(?:public\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)",
            source,
        ))
        if not declarations:
            return ""

        for index, match in enumerate(declarations):
            end = declarations[index + 1].start() if index + 1 < len(declarations) else len(source)
            body = source[match.end():end]
            if re.search(r"\bstatic\s+void\s+main\s*\(", body):
                return match.group(1)
        return declarations[0].group(1)

    @staticmethod
    def _java_launcher_source(code: str, entry_class: str) -> str:
        """Prepare source for providers whose Java runtime launches Main.

        The user's class and its name remain unchanged. Only a package-local
        launcher is added, and a matching public modifier is relaxed when the
        provider compiles the combined source as ``Main.java``.
        """
        if not entry_class or entry_class == "Main":
            return code
        source = re.sub(
            r"\bpublic\s+(?=(?:class|interface|enum)\s+" + re.escape(entry_class) + r"\b)",
            "",
            code,
            count=1,
        )
        launcher = (
            "class Main {\n"
            "    public static void main(String[] args) {\n"
            f"        {entry_class}.main(args);\n"
            "    }\n"
            "}\n"
        )
        lines = source.splitlines()
        insert_at = 0
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("package ") or stripped.startswith("import ") or not stripped:
                insert_at = index + 1
                continue
            break
        lines.insert(insert_at, launcher.rstrip("\n"))
        return "\n".join(lines)

    @staticmethod
    def merge_driver_code(language: str, code: str, driver_code: str) -> str:
        if not driver_code:
            return code
        if language != "java":
            return code + "\n\n" + driver_code

        import_re = re.compile(r"^\s*import\s+[\w.\*]+\s*;")

        def split_imports(src):
            imports, body = [], []
            for line in src.splitlines():
                if import_re.match(line):
                    stmt = line.strip()
                    if stmt not in imports:
                        imports.append(stmt)
                else:
                    body.append(line)
            return imports, "\n".join(body).strip("\n")

        user_imports, user_body = split_imports(code)
        driver_imports, driver_body = split_imports(driver_code)
        all_imports = user_imports + [s for s in driver_imports if s not in user_imports]

        user_body = re.sub(r"\bpublic\s+(?=(?:class|interface|enum)\s+\w+)", "", user_body)

        user_cls_m = re.search(r"\b(?:class|interface|enum)\s+(\w+)", user_body)
        driver_classes = set(re.findall(r"\b(?:class|interface|enum)\s+(\w+)", driver_body))
        if user_cls_m:
            user_cls = user_cls_m.group(1)
            if (user_cls == "Main" and "Main" in driver_classes) or (user_cls != "Main" and user_cls in driver_classes):
                new_cls = "UserSolution"
                n = 2
                while new_cls in driver_classes:
                    new_cls = f"UserSolution{n}"
                    n += 1
                user_body = re.sub(r"\b(class|interface|enum)\s+" + re.escape(user_cls) + r"\b", r"\1 " + new_cls, user_body)
                user_body = re.sub(r"\b(public|private|protected)?\s*" + re.escape(user_cls) + r"\s*\(", lambda m: (m.group(1) or "") + " " + new_cls + "(", user_body)

        parts = []
        if all_imports:
            parts.append("\n".join(all_imports))
        if user_body:
            parts.append(user_body)
        if driver_body:
            parts.append(driver_body)
        return "\n\n".join(parts)

    @classmethod
    def run_piston_api(cls, language: str, code: str, stdin: str = "", filename: str = ""):
        lang_map = {
            "python": "python",
            "cpp": "cpp",
            "c": "c",
            "java": "java"
        }
        piston_lang = lang_map.get(language, "python")
        
        upload_filename = "main.py"
        if piston_lang == "java":
            entry_class = cls._java_entry_class(code, filename)
            if not entry_class:
                return {
                    "stdout": "",
                    "stderr": "No Java class declaration was found in the submitted source.",
                    "code": 1,
                    "output": "No Java class declaration was found in the submitted source.",
                }
            source_filename = f"{entry_class}.java"
            if entry_class == "Main":
                files = [{"name": "Main.java", "content": code}]
            else:
                files = [
                    {"name": "Main.java", "content": cls._java_launcher_source(code, entry_class)},
                    {"name": source_filename, "content": code},
                ]
        elif piston_lang == "cpp":
            upload_filename = "main.cpp"
        elif piston_lang == "c":
            upload_filename = "main.c"

        if piston_lang != "java":
            files = [{"name": upload_filename, "content": code}]
        payload = {
            "language": piston_lang,
            "version": "*",
            "files": files,
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
    def run_paiza_api(cls, language: str, code: str, stdin: str = "", filename: str = ""):
        lang_map = {
            "python": "python3",
            "cpp": "cpp",
            "c": "c",
            "java": "java"
        }
        paiza_lang = lang_map.get(language, "python3")

        if paiza_lang == "java":
            entry_class = cls._java_entry_class(code, filename)
            if not entry_class:
                return {"stdout": "", "stderr": "No Java class declaration was found in the submitted source.", "code": 1, "output": ""}
            code = cls._java_launcher_source(code, entry_class)

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
    def run_piston_code(cls, language: str, code: str, stdin: str = "", filename: str = ""):
        res = cls.run_piston_api(language, code, stdin, filename)
        if res is not None:
            return res
        return cls.run_paiza_api(language, code, stdin, filename)
