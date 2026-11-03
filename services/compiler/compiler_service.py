import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

from utils.logger import bind_component, get_logger

ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))
log = bind_component(get_logger(__name__), "compiler_service")

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

        A public top-level type is authoritative because Java requires the
        source filename to match it. A workspace filename is used only when
        the source has no public class declaration.
        """
        # Ignore comments so a commented example such as ``class Main`` does
        # not get selected over the actual submitted class.
        source = re.sub(r"/\*.*?\*/|//[^\n]*", "", code, flags=re.DOTALL)
        # A public Java type always owns the source filename. This takes
        # precedence over generic browser names such as ``main.java``.
        public_declaration = re.search(
            r"\bpublic\s+(?:abstract\s+|final\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            source,
        )
        if public_declaration:
            return public_declaration.group(1)

        stem = Path(str(filename or "")).stem
        if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", stem or ""):
            return stem
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
            "    public static void main(String[] args) throws Exception {\n"
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
    @staticmethod
    def _result(stdout="", stderr="", code=0):
        stdout = str(stdout or "")
        stderr = str(stderr or "")
        return {
            "stdout": stdout,
            "stderr": stderr,
            "code": int(code or 0),
            "output": stdout if stdout else stderr,
        }

    @classmethod
    def run_local_code(cls, language: str, code: str, stdin: str = "", filename: str = "", strict_java_filename: bool = False):
        """Compile and run code inside the process handling the execution request.

        This method deliberately has no network execution fallback. The
        process must have the requested language toolchain installed.
        """
        language = str(language or "").strip().lower()
        if language not in {"python", "c", "cpp", "java"}:
            return cls._result(stderr=f"Unsupported language: {language}", code=1)

        timeout = max(1, int(os.getenv("CODE_EXECUTION_TIMEOUT_SECONDS", "8")))
        source = str(code or "")
        stdin = str(stdin or "")
        with tempfile.TemporaryDirectory(prefix="codeleaf-exec-") as temp_dir:
            root = Path(temp_dir)
            if language == "python":
                source_path = root / "main.py"
                compile_cmd = None
                run_cmd = [sys.executable, str(source_path)]
            elif language == "c":
                source_path = root / "main.c"
                binary_path = root / "main"
                compile_cmd = [shutil.which("gcc") or "gcc", "-std=c11", "-O2", "-pipe", str(source_path), "-o", str(binary_path)]
                run_cmd = [str(binary_path)]
            elif language == "cpp":
                source_path = root / "main.cpp"
                binary_path = root / "main"
                compile_cmd = [shutil.which("g++") or "g++", "-std=c++17", "-O2", "-pipe", str(source_path), "-o", str(binary_path)]
                run_cmd = [str(binary_path)]
            else:
                supplied_name = Path(str(filename or "")).name
                if strict_java_filename:
                    if not supplied_name or supplied_name.lower() == ".java" or not supplied_name.lower().endswith(".java"):
                        return cls._result(stderr="Java playground code must be run from a .java file. Rename the file to match the public class name.", code=1)
                    file_stem = Path(supplied_name).stem
                    if not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", file_stem):
                        return cls._result(stderr=f"Invalid Java filename '{supplied_name}'. Use a valid Java class filename such as Solution.java.", code=1)
                    public_declaration = re.search(
                        r"\bpublic\s+(?:abstract\s+|final\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
                        re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.DOTALL),
                    )
                    if public_declaration and public_declaration.group(1) != file_stem:
                        return cls._result(
                            stderr=f"Java filename/class mismatch: public class {public_declaration.group(1)} must be saved as {public_declaration.group(1)}.java, or change the public class to {file_stem}.",
                            code=1,
                        )
                    if public_declaration:
                        entry_class = public_declaration.group(1)
                    else:
                        # Do not assume the filename is the class name. That
                        # would turn a clear source error into a confusing
                        # runtime failure (and historically caused Main.java
                        # style rewrites). Require the runnable class to match
                        # the submitted Java filename as well.
                        entry_class = cls._java_entry_class(source, "")
                        if not entry_class:
                            return cls._result(stderr="No Java class declaration was found in the submitted source.", code=1)
                        if entry_class != file_stem:
                            return cls._result(
                                stderr=f"Java filename/class mismatch: class {entry_class} must be saved as {entry_class}.java, or change the class to {file_stem}.",
                                code=1,
                            )
                    source_path = root / supplied_name
                else:
                    entry_class = cls._java_entry_class(source, filename)
                    source_path = root / f"{entry_class}.java"
                if not entry_class:
                    return cls._result(stderr="No Java class declaration was found in the submitted source.", code=1)
                compile_cmd = [shutil.which("javac") or "javac", "-encoding", "UTF-8", str(source_path)]
                run_cmd = [shutil.which("java") or "java", "-cp", str(root), entry_class]

            source_path.write_text(source, encoding="utf-8")
            safe_env = {
                "PATH": os.getenv("PATH", ""),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "HOME": str(root),
                # GCC/G++ use TMP/TEMP/TMPDIR for intermediate files. Some
                # Windows hosts inherit C:\\Windows as the temp directory,
                # which causes permission errors when the worker compiles C.
                # Keep all compiler intermediates inside this writable job
                # directory instead.
                "TMP": str(root),
                "TEMP": str(root),
                "TMPDIR": str(root),
            }
            try:
                if compile_cmd:
                    compiled = subprocess.run(
                        compile_cmd, input="", capture_output=True, text=True,
                        cwd=root, env=safe_env, timeout=timeout,
                    )
                    if compiled.returncode != 0:
                        return cls._result(compiled.stdout, compiled.stderr, compiled.returncode)
                ran = subprocess.run(
                    run_cmd, input=stdin, capture_output=True, text=True,
                    cwd=root, env=safe_env, timeout=timeout,
                )
                return cls._result(ran.stdout, ran.stderr, ran.returncode)
            except subprocess.TimeoutExpired as exc:
                output = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
                return cls._result(output, f"Execution timed out after {timeout} seconds.", 124)
            except FileNotFoundError as exc:
                return cls._result(stderr=f"Worker runtime is unavailable: {exc.filename}", code=127)
            except OSError as exc:
                return cls._result(stderr=f"Worker execution failed: {exc}", code=1)

    @classmethod
    def run_piston_code(cls, language: str, code: str, stdin: str = "", filename: str = "", strict_java_filename: bool = False):
        """Execute code through Piston, falling back to Paiza when unavailable."""
        if str(language or "").strip().lower() in {"javascript", "js"}:
            from services.compiler.javascript_service import JavaScriptService

            return JavaScriptService.run_code(code, stdin)
        result = cls.run_piston_api(language, code, stdin, filename, strict_java_filename)
        if result is not None:
            return result
        return cls.run_paiza_api(language, code, stdin, filename, strict_java_filename)

    @classmethod
    def _validate_java_filename(cls, code: str, filename: str, strict_java_filename: bool):
        if not strict_java_filename:
            return None

        supplied_name = Path(str(filename or "")).name
        if not supplied_name or supplied_name.lower() == ".java" or not supplied_name.lower().endswith(".java"):
            return cls._result(
                stderr="Java playground code must be run from a .java file. Rename the file to match the public class name.",
                code=1,
            )
        file_stem = Path(supplied_name).stem
        if not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", file_stem):
            return cls._result(
                stderr=f"Invalid Java filename '{supplied_name}'. Use a valid Java class filename such as Solution.java.",
                code=1,
            )

        source = re.sub(r"/\*.*?\*/|//[^\n]*", "", str(code or ""), flags=re.DOTALL)
        public_declaration = re.search(
            r"\bpublic\s+(?:abstract\s+|final\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            source,
        )
        entry_class = public_declaration.group(1) if public_declaration else cls._java_entry_class(source, "")
        if not entry_class:
            return cls._result(stderr="No Java class declaration was found in the submitted source.", code=1)
        if entry_class != file_stem:
            message = (
                f"Java filename/class mismatch: {entry_class} must be saved as "
                f"{entry_class}.java, or change the class to {file_stem}."
            )
            return cls._result(stderr=message, code=1)
        return None

    @classmethod
    def run_piston_api(
        cls,
        language: str,
        code: str,
        stdin: str = "",
        filename: str = "",
        strict_java_filename: bool = False,
    ):
        lang_map = {"python": "python", "cpp": "cpp", "c": "c", "java": "java"}
        piston_language = lang_map.get(str(language or "").strip().lower())
        if not piston_language:
            return cls._result(stderr=f"Unsupported language: {language}", code=1)

        validation_error = cls._validate_java_filename(code, filename, strict_java_filename)
        if validation_error:
            return validation_error

        if piston_language == "java":
            entry_class = cls._java_entry_class(code, filename)
            if not entry_class:
                return cls._result(stderr="No Java class declaration was found in the submitted source.", code=1)
            if entry_class == "Main":
                files = [{"name": "Main.java", "content": code}]
            else:
                files = [
                    {"name": "Main.java", "content": cls._java_launcher_source(code, entry_class)},
                    {"name": f"{entry_class}.java", "content": code},
                ]
        else:
            source_filename = {"python": "main.py", "cpp": "main.cpp", "c": "main.c"}[piston_language]
            files = [{"name": source_filename, "content": str(code or "")}]

        try:
            response = requests.post(
                "https://emkc.org/api/v2/piston/execute",
                json={
                    "language": piston_language,
                    "version": "*",
                    "files": files,
                    "stdin": str(stdin or ""),
                },
                timeout=8,
            )
            if response.status_code != 200:
                log.warning(
                    "piston_execution_unavailable",
                    language=piston_language,
                    status_code=response.status_code,
                )
                return None
            result = response.json()
        except (requests.RequestException, ValueError) as exc:
            log.warning(
                "piston_execution_unavailable",
                language=piston_language,
                error_type=type(exc).__name__,
            )
            return None

        if not isinstance(result, dict) or "run" not in result:
            log.warning("piston_execution_invalid_response", language=piston_language)
            return None
        compile_result = result.get("compile") or {}
        run_result = result.get("run") or {}
        if not isinstance(compile_result, dict) or not isinstance(run_result, dict):
            return None
        if compile_result and compile_result.get("code", 0) != 0:
            stderr = compile_result.get("stderr") or compile_result.get("output") or ""
            return cls._result(stderr=stderr, code=compile_result.get("code", 1))

        stdout = run_result.get("stdout") or ""
        stderr = run_result.get("stderr") or ""
        return cls._result(stdout=stdout, stderr=stderr, code=run_result.get("code", 0))

    @classmethod
    def run_paiza_api(
        cls,
        language: str,
        code: str,
        stdin: str = "",
        filename: str = "",
        strict_java_filename: bool = False,
    ):
        lang_map = {"python": "python3", "cpp": "cpp", "c": "c", "java": "java"}
        paiza_language = lang_map.get(str(language or "").strip().lower())
        if not paiza_language:
            return cls._result(stderr=f"Unsupported language: {language}", code=1)

        validation_error = cls._validate_java_filename(code, filename, strict_java_filename)
        if validation_error:
            return validation_error
        source = str(code or "")
        if paiza_language == "java":
            entry_class = cls._java_entry_class(source, filename)
            if not entry_class:
                return cls._result(stderr="No Java class declaration was found in the submitted source.", code=1)
            source = cls._java_launcher_source(source, entry_class)

        try:
            create_response = requests.post(
                "https://api.paiza.io/runners/create",
                json={
                    "source_code": source,
                    "language": paiza_language,
                    "input": str(stdin or ""),
                    "api_key": "guest",
                },
                timeout=8,
            )
            if create_response.status_code != 200:
                return cls._result(
                    stderr=f"Paiza could not create an execution session (HTTP {create_response.status_code}).",
                    code=1,
                )
            create_result = create_response.json()
        except (requests.RequestException, ValueError) as exc:
            return cls._result(stderr=f"External execution services failed: {exc}", code=1)

        run_id = create_result.get("id") if isinstance(create_result, dict) else None
        if not run_id:
            return cls._result(stderr="Paiza did not return an execution session ID.", code=1)

        details_url = "https://api.paiza.io/runners/get_details"
        for attempt in range(10):
            if attempt:
                time.sleep(1)
            try:
                details_response = requests.get(
                    details_url,
                    params={"id": run_id, "api_key": "guest"},
                    timeout=8,
                )
                if details_response.status_code != 200:
                    continue
                details = details_response.json()
            except (requests.RequestException, ValueError):
                continue

            if not isinstance(details, dict):
                continue
            status = details.get("status")
            if status == "running":
                continue
            if status != "completed":
                return cls._result(stderr=f"Paiza execution status: {status}", code=1)

            stderr = details.get("build_stderr") or ""
            runtime_stderr = details.get("stderr") or ""
            if runtime_stderr:
                stderr = f"{stderr}\n{runtime_stderr}" if stderr else runtime_stderr
            exit_code = details.get("exit_code")
            try:
                exit_code = int(exit_code) if exit_code is not None else 0
            except (ValueError, TypeError):
                exit_code = 1
            if details.get("build_result") == "failure" and exit_code == 0:
                exit_code = 1
            return cls._result(stdout=details.get("stdout") or "", stderr=stderr, code=exit_code)

        return cls._result(
            stderr="Program compilation or execution timed out while waiting for Paiza.",
            code=1,
        )
