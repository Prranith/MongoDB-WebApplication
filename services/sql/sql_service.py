"""Bounded SQL execution in an isolated, in-memory SQLite sandbox."""
import json
import re
import sqlite3
import time
from pathlib import Path

from services.shared.redis_client import redis_one


class SqlService:
    DEFAULT_LIMIT = 500
    MAX_LIMIT = 10000
    TIMEOUT_SECONDS = 3.0
    MAX_MUTATION_ROWS = 1000
    MAX_SANDBOX_ROWS = 10000
    MAX_SANDBOX_TABLES = 100
    MAX_SANDBOX_COLUMNS = 100
    MAX_CUSTOM_TABLE_BYTES = 5 * 1024 * 1024
    _blocked = re.compile(
        r"\b(attach|detach|pragma|vacuum|load_extension|begin|commit|rollback|savepoint|release|reindex|trigger|virtual)\b",
        re.I,
    )

    @staticmethod
    def _safe_name(name):
        name = re.sub(r"[^a-zA-Z0-9_]", "_", str(name)).strip("_") or "column"
        if name[0].isdigit():
            name = "c_" + name
        return name.lower()

    @staticmethod
    def _quote(name):
        return '"' + str(name).replace('"', '""') + '"'

    @classmethod
    def _flatten(cls, value, prefix=""):
        if isinstance(value, dict):
            out = {}
            for key, val in value.items():
                child = f"{prefix}_{key}" if prefix else str(key)
                if isinstance(val, dict):
                    out.update(cls._flatten(val, child))
                else:
                    out[child] = val
            return out
        return {prefix: value}

    @classmethod
    def _scalar(cls, value):
        if isinstance(value, (dict, list)):
            return json.dumps(value, separators=(",", ":"), default=str)
        if value is None or isinstance(value, (str, int, float, bytes)):
            return value
        return str(value)

    @classmethod
    def _table_docs(cls, conn, table_name, docs):
        if not isinstance(docs, list):
            docs = []
        if len(docs) > cls.MAX_SANDBOX_ROWS:
            raise ValueError(f"A sandbox table may contain at most {cls.MAX_SANDBOX_ROWS} rows")
        flattened = [cls._flatten(d) if isinstance(d, dict) else {"value": d} for d in docs]
        columns = []
        seen = set()
        for row in flattened:
            for key in row:
                safe = cls._safe_name(key)
                if safe not in seen:
                    seen.add(safe)
                    columns.append((safe, key))
        if not columns:
            columns = [("value", "value")]
        if len(columns) > cls.MAX_SANDBOX_COLUMNS:
            raise ValueError(f"A sandbox table may contain at most {cls.MAX_SANDBOX_COLUMNS} columns")
        table = cls._safe_name(table_name)
        defs = ", ".join(f"{cls._quote(col)}" + " NUMERIC" for col, _ in columns)
        conn.execute(f"CREATE TABLE {cls._quote(table)} ({defs})")
        sql = f"INSERT INTO {cls._quote(table)} ({', '.join(cls._quote(c) for c, _ in columns)}) VALUES ({','.join('?' for _ in columns)})"
        for row in flattened:
            conn.execute(sql, [cls._scalar(row.get(original)) for _, original in columns])

    @classmethod
    def build_sqlite_db_from_docs(cls, table_docs_map):
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.row_factory = sqlite3.Row
        for name, docs in (table_docs_map or {}).items():
            cls._table_docs(conn, name, docs)
        conn.commit()
        return conn

    @staticmethod
    def _strip_leading_comments(query):
        """Return the SQL statement after whitespace and leading comments.

        Editors commonly place a description such as ``-- SQL query`` above
        the statement.  That is valid SQL, but validating the raw first
        character would incorrectly reject it as non-SELECT input.
        """
        text = str(query or "").lstrip()
        while text:
            if text.startswith("--"):
                newline = text.find("\n")
                text = text[newline + 1:] if newline >= 0 else ""
            elif text.startswith("/*"):
                end = text.find("*/", 2)
                if end < 0:
                    raise ValueError("Unterminated SQL comment")
                text = text[end + 2:].lstrip()
            else:
                break
        return text.lstrip()

    @classmethod
    def _validate(cls, query):
        query = str(query or "").lstrip("\ufeff").strip()
        if not query:
            raise ValueError("SQL query is required")
        if len(query) > 100000:
            raise ValueError("SQL query is too large")
        statement = cls._strip_leading_comments(query)
        if not statement:
            raise ValueError("SQL query is required")
        # Permit one trailing semicolon, but never execute a script.
        if ";" in statement.rstrip(";"):
            raise ValueError("Only one SQL statement is allowed")
        if cls._blocked.search(statement):
            raise ValueError("This SQL operation is not allowed in the sandbox")
        first = re.match(r"^(select|with|insert|update|delete|replace|create|alter|drop)\b", statement, re.I)
        if not first:
            raise ValueError("Supported SQL starts with SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, or WITH")
        kind = first.group(1).lower()
        if kind == "with":
            dml = re.search(r"\b(insert|update|delete|replace)\b", statement, re.I)
            kind = dml.group(1).lower() if dml else "select"
        if kind == "create" and re.match(r"^create\s+virtual\b", statement, re.I):
            raise ValueError("Virtual tables are not allowed in the sandbox")
        if kind in {"update", "delete"} and not re.search(r"\bwhere\b", statement, re.I):
            raise ValueError(f"{kind.upper()} requires a WHERE clause for safety")
        return query, kind, statement

    @classmethod
    def _enforce_limits(cls, conn):
        tables = [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )]
        if len(tables) > cls.MAX_SANDBOX_TABLES:
            raise ValueError(f"A sandbox may contain at most {cls.MAX_SANDBOX_TABLES} tables")
        total_rows = 0
        for table in tables:
            count = conn.execute(f"SELECT COUNT(*) FROM {cls._quote(table)}").fetchone()[0]
            total_rows += int(count)
            if total_rows > cls.MAX_SANDBOX_ROWS:
                raise ValueError(f"A sandbox may contain at most {cls.MAX_SANDBOX_ROWS} rows")

    @classmethod
    def _dump_tables(cls, conn):
        cls._enforce_limits(conn)
        result = {}
        names = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        for (name,) in names:
            cursor = conn.execute(f"SELECT * FROM {cls._quote(name)} LIMIT ?", (cls.MAX_SANDBOX_ROWS,))
            result[name] = [dict(row) for row in cursor.fetchall()]
        return result

    @classmethod
    def execute_query(cls, sql_query, limit=DEFAULT_LIMIT, custom_tables=None):
        started = time.perf_counter()
        conn = None
        try:
            query, kind, statement = cls._validate(sql_query)
            limit = max(1, min(int(limit or cls.DEFAULT_LIMIT), cls.MAX_LIMIT))
            tables = custom_tables if custom_tables is not None else cls._load_playground_tables()
            if not isinstance(tables, dict):
                raise ValueError("SQL sandbox tables must be an object")
            if len(json.dumps(tables, separators=(",", ":"), default=str)) > cls.MAX_CUSTOM_TABLE_BYTES:
                raise ValueError("SQL sandbox data is too large")
            conn = cls.build_sqlite_db_from_docs(tables)
            deadline = time.monotonic() + cls.TIMEOUT_SECONDS
            conn.set_progress_handler(lambda: 1 if time.monotonic() >= deadline else 0, 1000)
            changes_before = conn.total_changes
            cur = conn.execute(statement)
            affected_rows = max(0, conn.total_changes - changes_before)
            if kind in {"insert", "update", "delete", "replace"} and affected_rows > cls.MAX_MUTATION_ROWS:
                raise ValueError(f"A single mutation may affect at most {cls.MAX_MUTATION_ROWS} rows")
            columns = [d[0] for d in cur.description or []]
            rows = [dict(row) for row in cur.fetchmany(limit)]
            result = {"status": "ok", "columns": columns, "rows": rows,
                      "rowCount": len(rows), "duration": round((time.perf_counter() - started) * 1000, 2),
                      "operation": kind, "affectedRows": affected_rows}
            # A mutation returns the new isolated state. A custom-table SELECT
            # returns it too, allowing the browser to keep its sandbox state.
            if kind != "select" or custom_tables is not None:
                result["tables"] = cls._dump_tables(conn)
            return result
        except (ValueError, sqlite3.Error) as exc:
            return {"status": "error", "error": str(exc),
                    "duration": round((time.perf_counter() - started) * 1000, 2)}
        finally:
            if conn is not None:
                conn.close()

    @classmethod
    def _load_playground_tables(cls):
        root = Path(__file__).resolve().parents[2] / "databases"
        tables = {}
        for path in root.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                tables[path.stem] = data if isinstance(data, list) else [data]
            except (OSError, ValueError):
                continue
        return tables

    @classmethod
    def execute_room_query(cls, room_id, dataset_ids, query, limit=1000):
        ids = dataset_ids if isinstance(dataset_ids, list) else [dataset_ids]
        tables = {}
        for dataset_id in ids:
            if not dataset_id:
                continue
            docs_raw = redis_one(["HGET", f"room:{room_id}", f"dataset_docs:{dataset_id}"])
            meta_raw = redis_one(["HGET", f"room:{room_id}", f"dataset_meta:{dataset_id}"])
            if not docs_raw:
                continue
            try:
                docs = json.loads(docs_raw) if isinstance(docs_raw, str) else docs_raw
                meta = json.loads(meta_raw) if isinstance(meta_raw, str) and meta_raw else (meta_raw or {})
            except (ValueError, TypeError):
                continue
            name = meta.get("name") or meta.get("collection") or str(dataset_id)
            tables[name] = docs if isinstance(docs, list) else [docs]
            tables[str(dataset_id)] = tables[name]
        if not tables:
            return {"status": "error", "error": "No datasets found/loaded in room"}
        return cls.execute_query(query, limit=limit, custom_tables=tables)

    @classmethod
    def list_tables(cls, custom_tables=None):
        tables = custom_tables if custom_tables is not None else cls._load_playground_tables()
        result = []
        for name, docs in tables.items():
            sample = next((d for d in docs if isinstance(d, dict)), {}) if isinstance(docs, list) else {}
            result.append({"name": cls._safe_name(name), "rowCount": len(docs) if isinstance(docs, list) else 0,
                           "columns": sorted(cls._safe_name(k) for k in cls._flatten(sample))})
        return result
