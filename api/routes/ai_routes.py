"""Secure, throttled AI assistance for the normal workspace editor."""

import json
import os
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import Blueprint, jsonify, request


ai_bp = Blueprint("ai_bp", __name__)

_MAX_CONCURRENT = max(1, int(os.getenv("GEMINI_MAX_CONCURRENT", "2")))
_MIN_INTERVAL_SECONDS = max(0.0, float(os.getenv("GEMINI_MIN_INTERVAL_SECONDS", "1.5")))
_REQUEST_TIMEOUT_SECONDS = max(10, int(os.getenv("GEMINI_TIMEOUT_SECONDS", "45")))
_request_slots = threading.BoundedSemaphore(_MAX_CONCURRENT)
_rate_lock = threading.Lock()
_last_request_at = 0.0


def _wait_for_slot():
    if not _request_slots.acquire(timeout=_REQUEST_TIMEOUT_SECONDS):
        raise TimeoutError("AI assistance is busy. Please try again in a moment.")
    global _last_request_at
    try:
        with _rate_lock:
            wait_for = _MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
            if wait_for > 0:
                time.sleep(wait_for)
            _last_request_at = time.monotonic()
    except Exception:
        _request_slots.release()
        raise


def _release_slot():
    _request_slots.release()


def _extract_json(text):
    cleaned = str(text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                pass
    return None


def _call_gemini(api_key, prompt):
    endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
    }
    req = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-goog-api-key": api_key},
        method="POST",
    )
    with urlopen(req, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
        body = json.loads(response.read().decode("utf-8"))
    return "".join(
        part.get("text", "")
        for part in body.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        if isinstance(part, dict)
    )


@ai_bp.route("/api/ai/editor-assist", methods=["POST"])
def editor_assist():
    body = request.get_json(silent=True) or {}
    code = str(body.get("code", ""))
    language = str(body.get("language", "mongodb"))[:40]
    filename = str(body.get("filename", "Untitled"))[:180]
    request_text = str(body.get("request", "Review this code and suggest improvements."))[:2000]
    auto_fill = bool(body.get("autoFill", False))

    if not code.strip():
        return jsonify({"status": "error", "error": "Open a file or write code before asking Codexa AI."}), 400
    if len(code) > 120000:
        return jsonify({"status": "error", "error": "This file is too large for one AI context window."}), 413
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return jsonify({"status": "error", "error": "GEMINI_API_KEY is not configured on the server."}), 503

    output_contract = (
        '{"summary":"short explanation","suggestion":"actionable advice",'
        '"corrected_code":"full corrected file or empty string","line_notes":["line-specific note"]}'
    )
    prompt = f"""You are Codexa AI, a careful coding assistant inside a dark professional IDE.
Review the complete file below. The user request is: {request_text}
Language: {language}
Filename: {filename}
Autofill is {'ON' if auto_fill else 'OFF'}.
Return ONLY valid JSON matching this exact shape: {output_contract}
Never invent APIs or remove working behavior. If the code is already correct, use an empty corrected_code.
When autofill is ON and a safe correction is possible, corrected_code must contain the complete corrected file.
When autofill is OFF, always leave corrected_code empty.

COMPLETE FILE:
```{language}
{code}
```"""

    try:
        _wait_for_slot()
        try:
            raw = _call_gemini(api_key, prompt)
        finally:
            _release_slot()
        parsed = _extract_json(raw)
        if not isinstance(parsed, dict):
            parsed = {"summary": "AI review", "suggestion": raw.strip(), "corrected_code": "", "line_notes": []}
        corrected = str(parsed.get("corrected_code", "")) if auto_fill else ""
        return jsonify({
            "status": "ok",
            "summary": str(parsed.get("summary", "")),
            "suggestion": str(parsed.get("suggestion", "")),
            "corrected_code": corrected,
            "line_notes": parsed.get("line_notes", []) if isinstance(parsed.get("line_notes", []), list) else [],
        })
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        return jsonify({"status": "error", "error": f"Gemini request failed ({exc.code}).", "detail": detail}), 502
    except (URLError, TimeoutError) as exc:
        return jsonify({"status": "error", "error": f"AI assistance is temporarily unavailable: {exc}"}), 503
    except Exception as exc:
        return jsonify({"status": "error", "error": "AI assistance failed. Please try again."}), 500
