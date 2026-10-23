import os
import re
import shutil
import subprocess
import sys
import tempfile
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
        """Compile and run code inside the dedicated execution worker.

        This method deliberately has no network execution fallback. The API
        process publishes a job to CloudAMQP and this worker executes it with
        the toolchains installed on the worker host.
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
        """Compatibility name used by existing routes; execution is local only."""
        return cls.run_local_code(language, code, stdin, filename, strict_java_filename)
