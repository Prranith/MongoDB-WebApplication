"""Sandboxed JavaScript execution for workspace scripts."""

from __future__ import annotations

import json
import os
import time

import quickjs


class JavaScriptService:
    MAX_SOURCE_LENGTH = 128 * 1024
    MAX_STDIN_LENGTH = 64 * 1024
    MAX_OUTPUT_LENGTH = 32 * 1024
    MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
    STACK_LIMIT_BYTES = 512 * 1024

    @classmethod
    def run_code(cls, source: str, stdin: str = "") -> dict:
        source = str(source or "")
        stdin = str(stdin or "")
        if len(source) > cls.MAX_SOURCE_LENGTH:
            return cls._result(stderr="JavaScript source exceeds the 128 KB limit.", code=1)
        if len(stdin) > cls.MAX_STDIN_LENGTH:
            return cls._result(stderr="JavaScript standard input exceeds the 64 KB limit.", code=1)

        try:
            timeout_seconds = max(
                0.1,
                min(10.0, float(os.getenv("JAVASCRIPT_EXECUTION_TIMEOUT_SECONDS", "3"))),
            )
        except ValueError:
            timeout_seconds = 3.0

        context = quickjs.Context()
        context.set_memory_limit(cls.MEMORY_LIMIT_BYTES)
        context.set_max_stack_size(cls.STACK_LIMIT_BYTES)
        input_lines = json.dumps(stdin.splitlines(), ensure_ascii=True)
        setup = f"""
          (() => {{
            const stdout = [];
            const stderr = [];
            const inputLines = {input_lines};
            let inputIndex = 0;
            let outputLength = 0;
            const maxOutputLength = {cls.MAX_OUTPUT_LENGTH};
            const format = value => {{
              if (typeof value === 'string') return value;
              try {{
                const serialized = JSON.stringify(value);
                return serialized === undefined ? String(value) : serialized;
              }} catch (_) {{
                return String(value);
              }}
            }};
            const write = (target, values) => {{
              if (outputLength >= maxOutputLength) return;
              const line = values.map(format).join(' ');
              const available = maxOutputLength - outputLength;
              const clipped = line.slice(0, available);
              target.push(clipped);
              outputLength += clipped.length + 1;
              if (clipped.length < line.length || outputLength >= maxOutputLength) {{
                const notice = '[output truncated]';
                target.push(notice);
                outputLength += notice.length;
              }}
            }};
            Object.defineProperty(globalThis, 'console', {{
              value: Object.freeze({{
                log: (...values) => write(stdout, values),
                info: (...values) => write(stdout, values),
                warn: (...values) => write(stderr, values),
                error: (...values) => write(stderr, values)
              }})
            }});
            Object.defineProperty(globalThis, 'readline', {{
              value: () => inputLines[inputIndex++] || ''
            }});
            Object.defineProperty(globalThis, 'prompt', {{
              value: () => inputLines[inputIndex++] || ''
            }});
            Object.defineProperty(globalThis, '__codeleafOutput', {{
              value: () => JSON.stringify({{
                stdout: stdout.join('\\n'),
                stderr: stderr.join('\\n')
              }})
            }});
          }})();
        """
        started_at = time.monotonic()
        try:
            context.eval(setup)
            context.set_time_limit(timeout_seconds)
            started_at = time.monotonic()
            context.eval(source)
            execution_code = 0
            execution_error = ""
        except quickjs.JSException as exc:
            execution_code = 124 if "interrupted" in str(exc).lower() else 1
            execution_error = (
                f"JavaScript execution timed out after {timeout_seconds:g} seconds."
                if execution_code == 124
                else str(exc)
            )

        try:
            output = json.loads(context.eval("__codeleafOutput()"))
        except (quickjs.JSException, json.JSONDecodeError):
            output = {"stdout": "", "stderr": ""}

        stdout = str(output.get("stdout") or "")
        stderr = str(output.get("stderr") or "")
        if execution_error:
            stderr = f"{stderr}\n{execution_error}" if stderr else execution_error
        result = cls._result(stdout=stdout, stderr=stderr, code=execution_code)
        result["duration"] = round((time.monotonic() - started_at) * 1000, 2)
        return result

    @staticmethod
    def _result(stdout: str = "", stderr: str = "", code: int = 0) -> dict:
        stdout = str(stdout or "")
        stderr = str(stderr or "")
        return {
            "stdout": stdout,
            "stderr": stderr,
            "code": int(code),
            "output": stdout if stdout else stderr,
        }
