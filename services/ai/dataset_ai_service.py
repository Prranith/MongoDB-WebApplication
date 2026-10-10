import os
from collections import Counter

import requests


class DatasetAIService:
    DEFAULT_MODEL = "gemini-1.5-flash"
    MAX_CONTEXT_ROWS = 25

    @classmethod
    def answer_question(cls, dataset_name, docs, question):
        docs = docs if isinstance(docs, list) else [docs]
        columns = cls._extract_columns(docs)
        if not columns:
            return {
                "status": "error",
                "error": "Dataset has no readable columns",
                "columns": [],
            }

        question_text = (question or "").strip()
        if not question_text:
            return {
                "status": "error",
                "error": "Question is required",
                "columns": columns,
            }

        api_key = (os.getenv("GEMINI_API_KEY") or "").strip()
        model = (os.getenv("GEMINI_MODEL") or cls.DEFAULT_MODEL).strip()
        if api_key:
            llm_answer = cls._ask_gemini(api_key, model, dataset_name, docs, columns, question_text)
            if llm_answer:
                return {"status": "ok", "answer": llm_answer, "columns": columns, "model": model}

        return {
            "status": "ok",
            "answer": cls._fallback_answer(dataset_name, docs, columns, question_text),
            "columns": columns,
            "model": "fallback",
        }

    @classmethod
    def _ask_gemini(cls, api_key, model, dataset_name, docs, columns, question):
        rows = [d for d in docs if isinstance(d, dict)][: cls.MAX_CONTEXT_ROWS]
        prompt = (
            "You are a data analyst.\n"
            "Answer only from the provided dataset context.\n"
            "Do not claim the question is unrelated when it references columns below.\n"
            f"Dataset name: {dataset_name}\n"
            f"Available columns: {', '.join(columns)}\n"
            f"Sample rows (JSON): {rows}\n\n"
            f"Question: {question}\n"
            "Return a concise direct answer."
        )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2},
        }
        try:
            response = requests.post(url, json=payload, timeout=20)
            if response.status_code >= 400:
                return None
            data = response.json()
            candidates = data.get("candidates") or []
            if not candidates:
                return None
            parts = (((candidates[0] or {}).get("content") or {}).get("parts")) or []
            text_chunks = [p.get("text", "") for p in parts if isinstance(p, dict)]
            answer = "\n".join(chunk.strip() for chunk in text_chunks if chunk and chunk.strip()).strip()
            return answer or None
        except Exception:
            return None

    @classmethod
    def _extract_columns(cls, docs):
        seen = set()
        columns = []
        for row in docs[: cls.MAX_CONTEXT_ROWS]:
            if not isinstance(row, dict):
                continue
            for key in row.keys():
                if key not in seen:
                    seen.add(key)
                    columns.append(str(key))
        return columns

    @classmethod
    def _fallback_answer(cls, dataset_name, docs, columns, question):
        q = question.lower()
        if any(token in q for token in ("column", "columns", "field", "fields", "attribute", "attributes")):
            return f"Available columns in '{dataset_name}': {', '.join(columns)}."
        if "how many" in q or "count" in q or "total rows" in q or "records" in q:
            return f"The dataset '{dataset_name}' contains {len(docs)} rows."
        country_col = next((c for c in columns if c.lower() == "country"), None)
        if country_col and any(token in q for token in ("country", "countries")):
            values = [str((row or {}).get(country_col, "")).strip() for row in docs if isinstance(row, dict)]
            values = [v for v in values if v]
            top = Counter(values).most_common(5)
            if top:
                summary = ", ".join(f"{name} ({count})" for name, count in top)
                return f"Top countries in '{dataset_name}': {summary}."
        preview_cols = ", ".join(columns[:20])
        return (
            f"I can answer from dataset '{dataset_name}'. "
            f"Available columns: {preview_cols}. "
            "Ask a question using these columns (for example counts, filters, or grouping)."
        )
