"""
core/translator/fallback.py
Regex-based MongoDB shell → PyMongo translator.
Handles the most common shell patterns without a full parser.
Used as the primary translator (fast, no extra dependencies).
"""

import re
from typing import Optional


# ── Public entry point ────────────────────────────────────────────────────────

def translate(raw: str) -> str:
    """
    Translate a MongoDB shell query string into valid Python/PyMongo code.
    Raises ValueError with a descriptive message on unrecoverable errors.
    """
    if not raw.strip():
        return ""

    s = raw

    # 1) Normalize line endings
    s = s.replace("\r\n", "\n").replace("\r", "\n")

    # 2) Convert JS single-line (//) and multi-line (/* */) comments to Python (#)
    s = _convert_comments(s)

    # 3) Strip trailing semicolons
    s = s.strip().rstrip(";").strip()

    # 4) Convert JS booleans / null → Python
    s = _convert_booleans(s)

    # 5) Quote unquoted object keys: { key: val } → { "key": val }
    s = _quote_object_keys(s)

    # 6) db.collection → db["collection"]
    s = _convert_db_accessors(s)

    # 7) Method name mapping
    s = _convert_method_names(s)

    # 8) new Date(...) → ISODate(...)
    s = _convert_date_constructors(s)

    # 9) .sort({ a: -1 }) → .sort([("a", -1)])
    s = _convert_sort_calls(s)

    # 10) .find() → .find({})
    s = re.sub(r"\.find\(\s*\)", ".find({})", s)

    # 11) Strip trailing semicolons again (after transformations)
    s = s.strip().rstrip(";").strip()

    return s


# ── Step implementations ──────────────────────────────────────────────────────

def _convert_comments(s: str) -> str:
    """Convert JS // single-line and /* */ multi-line comments to Python # comments outside strings."""
    def replace_comments(chunk: str) -> str:
        # Multi-line comments /* ... */ -> convert to # ...
        def ml(m):
            lines = m.group(1).splitlines()
            return "\n".join("# " + line for line in lines)
        chunk = re.sub(r"/\*(.*?)\*/", ml, chunk, flags=re.DOTALL)
        # Single-line comments // ... -> # ...
        chunk = re.sub(r"//([^\n]*)", r"#\1", chunk)
        return chunk

    return _apply_outside_strings(s, replace_comments)


def _convert_booleans(s: str) -> str:
    """Replace JS true/false/null with Python equivalents."""
    s = re.sub(r"\btrue\b",  "True",  s)
    s = re.sub(r"\bfalse\b", "False", s)
    s = re.sub(r"\bnull\b",  "None",  s)
    return s


def _quote_object_keys(s: str) -> str:
    """
    Quote unquoted object keys in dict literals.
    Converts: { $match: ..., userId: ... }
    Into:     { "$match": ..., "userId": ... }
    """
    pattern = re.compile(r"(\$?[A-Za-z_][A-Za-z0-9_$]*)\s*:")
    return _apply_outside_strings(s, lambda chunk: pattern.sub(
        lambda m: f'"{m.group(1)}":', chunk
    ))


def _apply_outside_strings(s: str, fn) -> str:
    """Apply fn only to parts of s that are outside string literals."""
    parts = []
    i = 0
    while i < len(s):
        if s[i] in ('"', "'"):
            # Find matching closing quote
            quote = s[i]
            j = i + 1
            while j < len(s):
                if s[j] == "\\" and j + 1 < len(s):
                    j += 2
                    continue
                if s[j] == quote:
                    j += 1
                    break
                j += 1
            parts.append(s[i:j])  # string literal — don't transform
            i = j
        else:
            # Find next string start
            j = i
            while j < len(s) and s[j] not in ('"', "'"):
                j += 1
            parts.append(fn(s[i:j]))
            i = j
    return "".join(parts)


def _convert_db_accessors(s: str) -> str:
    """
    Convert db.collectionName → db["collectionName"]
    Only converts identifiers not already bracket-accessed.
    """
    return re.sub(r"\bdb\.([A-Za-z_][A-Za-z0-9_]*)", r'db["\1"]', s)


def _convert_method_names(s: str) -> str:
    """Map MongoDB shell method names to their PyMongo equivalents."""
    replacements = [
        (r"\.findOne\s*\(",       ".find_one("),
        (r"\.insertOne\s*\(",     ".insert_one("),
        (r"\.insertMany\s*\(",    ".insert_many("),
        (r"\.updateOne\s*\(",     ".update_one("),
        (r"\.updateMany\s*\(",    ".update_many("),
        (r"\.deleteOne\s*\(",     ".delete_one("),
        (r"\.deleteMany\s*\(",    ".delete_many("),
        (r"\.replaceOne\s*\(",    ".replace_one("),
        (r"\.countDocuments\s*\(", ".count_documents("),
        (r"\.estimatedDocumentCount\s*\(", ".estimated_document_count("),
        (r"\.distinct\s*\(",      ".distinct("),
        (r"\.createIndex\s*\(",   ".create_index("),
        (r"\.dropIndex\s*\(",     ".drop_index("),
        (r"\.dropIndexes\s*\(",   ".drop_indexes("),
        (r"\.aggregate\s*\(",     ".aggregate("),
        (r"\.toArray\s*\(\)",     ""),
        (r"\.pretty\s*\(\)",      ""),
        (r"\.forEach\s*\(",       ".__iter__("),
        (r"\.map\s*\(",           ".__iter__("),
    ]
    for pattern, replacement in replacements:
        s = re.sub(pattern, replacement, s)
    return s


def _convert_date_constructors(s: str) -> str:
    """Convert new Date('...') and new ISODate('...') → ISODate('...')"""
    s = re.sub(r"\bnew\s+Date\s*\(", "ISODate(", s)
    s = re.sub(r"\bnew\s+ISODate\s*\(", "ISODate(", s)
    s = re.sub(r"\bnew\s+ObjectId\s*\(", "ObjectId(", s)
    return s


def _convert_sort_calls(s: str) -> str:
    """
    Convert .sort({ a: -1, b: 1 }) → .sort([("a", -1), ("b", 1)])
    Handles only top-level object style sort documents.
    """
    def _repl(m: re.Match) -> str:
        inner = m.group(1)
        py_list = _parse_sort_obj(inner)
        return f".sort({py_list})"

    return re.sub(r"\.sort\(\s*\{([^}]*)\}\s*\)", _repl, s)


def _parse_sort_obj(js_obj: str) -> str:
    """
    Parse a sort object body and return a Python list-of-tuples string.
    Input:  '"amount": -1, createdAt: 1'
    Output: '[("amount", -1), ("createdAt", 1)]'
    """
    entries: list[str] = []
    for part in re.split(r",(?![^\[]*\])", js_obj):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"""[\"']?(\$?[A-Za-z0-9_.]+)[\"']?\s*:\s*(-?[0-9]+)""", part)
        if m:
            key = m.group(1)
            val = int(m.group(2))
            entries.append(f'("{key}", {val})')
    return "[" + ", ".join(entries) + "]"
