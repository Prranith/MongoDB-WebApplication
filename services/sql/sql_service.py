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
    def _normalize_mysql(cls, statement):
        """Translate common MySQL syntax to the isolated SQLite dialect."""
        text = statement.strip()
        if re.match(r"^(?:create|drop)\s+database\b|^use\s+", text, re.I):
            return "SELECT 'practice_db' AS Database"
        if re.match(r"^truncate\s+table\b", text, re.I):
            text = re.sub(r"^truncate\s+table\s+", "DELETE FROM ", text, flags=re.I)
        if re.match(r"^show\s+tables\s*$", text, re.I):
            return "SELECT name AS Tables_in_database FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        describe = re.match(r"^(?:describe|desc)\s+([`\w]+)\s*$", text, re.I)
        if describe:
            table = describe.group(1).strip('`')
            return (
                "SELECT name AS Field, type AS Type, CASE WHEN \"notnull\" = 0 THEN 'YES' ELSE 'NO' END AS \"Null\", "
                "CASE WHEN pk = 1 THEN 'PRI' ELSE '' END AS \"Key\", dflt_value AS \"Default\", '' AS Extra "
                f"FROM pragma_table_info({cls._quote(table)})"
            )
        text = re.sub(r"\bINSERT\s+IGNORE\b", "INSERT OR IGNORE", text, flags=re.I)
        text = re.sub(r"\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\b[\s\S]*$", "", text, flags=re.I)
        text = re.sub(r"\bINSERT\s+INTO\b", "INSERT OR REPLACE INTO", text, count=1, flags=re.I) if re.search(r"\bON\s+DUPLICATE\s+KEY", statement, re.I) else text
        text = re.sub(r"\bAUTO_INCREMENT\b", "", text, flags=re.I)
        text = re.sub(r"\bUNSIGNED\b|\bZEROFILL\b", "", text, flags=re.I)
        text = re.sub(r"\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)(?:\s*\(\s*\d+\s*\))?(?![A-Z0-9_])", "INTEGER", text, flags=re.I)
        text = re.sub(r"\b(?:VARCHAR|CHAR|NVARCHAR)\s*\(\s*\d+\s*\)", "TEXT", text, flags=re.I)
        text = re.sub(r"\b(?:DATETIME|TIMESTAMP|DATE|TIME)\b", "TEXT", text, flags=re.I)
        text = re.sub(r"\bDECIMAL\s*\([^)]*\)", "REAL", text, flags=re.I)
        text = re.sub(r"\bENUM\s*\([^)]*\)", "TEXT", text, flags=re.I)
        text = re.sub(r"\bUNIQUE\s+KEY\s+[`\w]+", "UNIQUE", text, flags=re.I)
        text = re.sub(r"(?<!FOREIGN )\bKEY\s+[`\w]+\s*\([^)]*\)", "", text, flags=re.I)
        text = re.sub(r"\s+ENGINE\s*=\s*\w+", "", text, flags=re.I)
        text = re.sub(r"\s+DEFAULT\s+CHARSET\s*=\s*\w+", "", text, flags=re.I)
        text = re.sub(r"\s+COLLATE\s*=\s*\w+", "", text, flags=re.I)
        text = re.sub(r"\bNOW\s*\(\s*\)", "CURRENT_TIMESTAMP", text, flags=re.I)
        text = re.sub(r"\bLIMIT\s+(\d+)\s*,\s*(\d+)\b", r"LIMIT \2 OFFSET \1", text, flags=re.I)
        return text

    @staticmethod
    def _register_mysql_functions(conn):
        def mysql_if(condition, when_true, when_false):
            return when_true if condition else when_false

        def mysql_concat(*values):
            return ''.join('' if value is None else str(value) for value in values)

        def date_part(value, part):
            match = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", str(value or ''))
            if not match: return None
            return int(match.group({'year': 1, 'month': 2, 'day': 3}[part]))

        def date_format(value, pattern):
            text = str(value or '')
            replacements = {'%Y': text[0:4], '%m': text[5:7], '%d': text[8:10], '%H': text[11:13], '%i': text[14:16], '%s': text[17:19]}
            return re.sub(r"%[YmdHis]", lambda match: replacements.get(match.group(0), match.group(0)), str(pattern or ''))

        conn.create_function("IF", 3, mysql_if)
        conn.create_function("CONCAT", -1, mysql_concat)
        conn.create_function("YEAR", 1, lambda value: date_part(value, 'year'))
        conn.create_function("MONTH", 1, lambda value: date_part(value, 'month'))
        conn.create_function("DAY", 1, lambda value: date_part(value, 'day'))
        conn.create_function("DATE_FORMAT", 2, date_format)
        conn.create_function("REGEXP", 2, lambda pattern, value: 1 if value is not None and re.search(str(pattern), str(value)) else 0)

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
        snapshot_create_sql = docs.get("__create_sql__") if isinstance(docs, dict) else None
        if snapshot_create_sql:
            conn.execute(snapshot_create_sql)
            cls._insert_snapshot_rows(conn, table_name, docs.get("__rows__"))
            return
        schema = None
        if isinstance(docs, dict) and "__rows__" in docs:
            schema = docs.get("__schema__") if isinstance(docs.get("__schema__"), list) else None
            docs = docs.get("__rows__")
        if not isinstance(docs, list):
            docs = []
        if len(docs) > cls.MAX_SANDBOX_ROWS:
            raise ValueError(f"A sandbox table may contain at most {cls.MAX_SANDBOX_ROWS} rows")
        flattened = [cls._flatten(d) if isinstance(d, dict) else {"value": d} for d in docs]
        columns = []
        if schema:
            for item in schema:
                if isinstance(item, dict) and item.get("name"):
                    original = str(item["name"])
                    columns.append((cls._safe_name(original), original, str(item.get("type") or "TEXT"), item))
        seen = set()
        seen.update(column[0] for column in columns)
        for row in flattened:
            for key in row:
                safe = cls._safe_name(key)
                if safe not in seen:
                    seen.add(safe)
                    columns.append((safe, key, "NUMERIC", {}))
        if not columns:
            columns = [("value", "value", "NUMERIC", {})]
        if len(columns) > cls.MAX_SANDBOX_COLUMNS:
            raise ValueError(f"A sandbox table may contain at most {cls.MAX_SANDBOX_COLUMNS} columns")
        table = cls._safe_name(table_name)
        defs = ", ".join(
            f"{cls._quote(col)} {data_type}"
            + (" PRIMARY KEY" if metadata.get("pk") else "")
            + (" NOT NULL" if metadata.get("notnull") else "")
            for col, _, data_type, metadata in columns
        )
        conn.execute(f"CREATE TABLE {cls._quote(table)} ({defs})")
        sql = f"INSERT INTO {cls._quote(table)} ({', '.join(cls._quote(c) for c, _, _, _ in columns)}) VALUES ({','.join('?' for _ in columns)})"
        for row in flattened:
            conn.execute(sql, [cls._scalar(row.get(original)) for _, original, _, _ in columns])

    @classmethod
    def _insert_snapshot_rows(cls, conn, table_name, docs):
        rows = docs if isinstance(docs, list) else []
        if len(rows) > cls.MAX_SANDBOX_ROWS:
            raise ValueError(f"A sandbox table may contain at most {cls.MAX_SANDBOX_ROWS} rows")
        columns = conn.execute(f"PRAGMA table_info({cls._quote(cls._safe_name(table_name))})").fetchall()
        if not columns or not rows: return
        names = [row[1] for row in columns]
        sql = f"INSERT INTO {cls._quote(cls._safe_name(table_name))} ({', '.join(cls._quote(name) for name in names)}) VALUES ({','.join('?' for _ in names)})"
        for value in rows:
            flattened = cls._flatten(value) if isinstance(value, dict) else {"value": value}
            conn.execute(sql, [cls._scalar(flattened.get(name, flattened.get(cls._safe_name(name)))) for name in names])

    @classmethod
    def build_sqlite_db_from_docs(cls, table_docs_map):
        conn = sqlite3.connect(":memory:", check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        cls._register_mysql_functions(conn)
        snapshot_tables = []
        for name, docs in (table_docs_map or {}).items():
            if isinstance(docs, dict) and docs.get("__create_sql__"):
                conn.execute(docs["__create_sql__"])
                snapshot_tables.append((name, docs))
            else:
                cls._table_docs(conn, name, docs)
        for name, docs in snapshot_tables:
            cls._insert_snapshot_rows(conn, name, docs.get("__rows__"))
            for index_sql in docs.get("__indexes__", []) if isinstance(docs, dict) else []:
                if index_sql: conn.execute(index_sql)
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
    def _validate_statement(cls, query):
        query = str(query or "").lstrip("\ufeff").strip()
        if not query:
            raise ValueError("SQL query is required")
        if len(query) > 100000:
            raise ValueError("SQL query is too large")
        statement = cls._strip_leading_comments(query)
        if not statement:
            raise ValueError("SQL query is required")
        if cls._blocked.search(statement):
            raise ValueError("This SQL operation is not allowed in the sandbox")
        first = re.match(r"^(select|with|insert|update|delete|replace|create|alter|drop|show|describe|desc|use|truncate)\b", statement, re.I)
        if not first:
            raise ValueError("Supported SQL starts with SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, or WITH")
        kind = first.group(1).lower()
        if kind in {"show", "describe", "desc", "use"}: kind = "select"
        if kind == "truncate": kind = "delete"
        if kind == "with":
            dml = re.search(r"\b(insert|update|delete|replace)\b", statement, re.I)
            kind = dml.group(1).lower() if dml else "select"
        if kind == "create" and re.match(r"^create\s+virtual\b", statement, re.I):
            raise ValueError("Virtual tables are not allowed in the sandbox")
        if kind in {"update", "delete"} and not re.search(r"\bwhere\b", statement, re.I):
            raise ValueError(f"{kind.upper()} requires a WHERE clause for safety")
        return query, kind, statement

    @classmethod
    def _split_statements(cls, query):
        """Split scripts while preserving semicolons inside quoted values."""
        parts, start, index = [], 0, 0
        quote = None
        line_comment = False
        block_comment = False
        text = str(query)
        while index < len(text):
            char = text[index]
            next_char = text[index + 1] if index + 1 < len(text) else ''
            if line_comment:
                if char in '\r\n': line_comment = False
            elif block_comment:
                if char == '*' and next_char == '/':
                    block_comment = False
                    index += 1
            elif quote:
                if char == quote:
                    if next_char == quote:
                        index += 1
                    else:
                        quote = None
            elif char == '-' and next_char == '-':
                line_comment = True
                index += 1
            elif char == '/' and next_char == '*':
                block_comment = True
                index += 1
            elif char in "'\"`":
                quote = char
            elif char == '[':
                quote = ']'
            elif char == ';':
                parts.append(text[start:index])
                start = index + 1
            index += 1
        if quote and quote != ']': raise ValueError("Unterminated SQL string")
        if block_comment: raise ValueError("Unterminated SQL comment")
        parts.append(text[start:])
        return [part.strip() for part in parts if cls._strip_leading_comments(part).strip()]

    @classmethod
    def _validated_script(cls, query):
        query = str(query or '').lstrip('\ufeff').strip()
        if not query: raise ValueError("SQL query is required")
        if len(query) > 100000: raise ValueError("SQL query is too large")
        parts = cls._split_statements(query)
        if not parts: raise ValueError("SQL query is required")
        return [cls._validate_statement(part) for part in parts]

    @classmethod
    def _validate(cls, query):
        # Keep the historical helper return value for existing callers.
        cls._validated_script(query)
        return str(query or '').lstrip('\ufeff').strip()

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
            columns = conn.execute(f"PRAGMA table_info({cls._quote(name)})").fetchall()
            cursor = conn.execute(f"SELECT * FROM {cls._quote(name)} LIMIT ?", (cls.MAX_SANDBOX_ROWS,))
            create_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
            ).fetchone()
            index_rows = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
                (name,),
            ).fetchall()
            result[name] = {
                "__create_sql__": create_row[0] if create_row else None,
                "__schema__": [
                    {"name": row[1], "type": row[2] or "TEXT", "notnull": row[3], "pk": row[5]}
                    for row in columns
                ],
                "__rows__": [dict(row) for row in cursor.fetchall()],
                "__indexes__": [row[0] for row in index_rows],
            }
        return result

    @classmethod
    def execute_query(cls, sql_query, limit=DEFAULT_LIMIT, custom_tables=None):
        from services.execution.query_queue import query_slot
        try:
            with query_slot("SQL"):
                return cls._execute_query(sql_query, limit, custom_tables)
        except TimeoutError as exc:
            return {"status": "error", "error": str(exc), "code": "QUERY_QUEUE_TIMEOUT"}

    @classmethod
    def _execute_query(cls, sql_query, limit=DEFAULT_LIMIT, custom_tables=None):
        started = time.perf_counter()
        conn = None
        try:
            statements = cls._validated_script(sql_query)
            limit = max(1, min(int(limit or cls.DEFAULT_LIMIT), cls.MAX_LIMIT))
            tables = custom_tables if custom_tables is not None else cls._load_playground_tables()
            if not isinstance(tables, dict):
                raise ValueError("SQL sandbox tables must be an object")
            if len(json.dumps(tables, separators=(",", ":"), default=str)) > cls.MAX_CUSTOM_TABLE_BYTES:
                raise ValueError("SQL sandbox data is too large")
            conn = cls.build_sqlite_db_from_docs(tables)
            deadline = time.monotonic() + cls.TIMEOUT_SECONDS
            conn.set_progress_handler(lambda: 1 if time.monotonic() >= deadline else 0, 1000)
            cur = None
            affected_rows = 0
            mutated = False
            final_kind = statements[-1][1]
            for _, kind, statement in statements:
                changes_before = conn.total_changes
                cur = conn.execute(cls._normalize_mysql(statement))
                statement_changes = max(0, conn.total_changes - changes_before)
                if kind in {"insert", "update", "delete", "replace"}:
                    mutated = True
                    if statement_changes > cls.MAX_MUTATION_ROWS:
                        raise ValueError(f"A single mutation may affect at most {cls.MAX_MUTATION_ROWS} rows")
                    affected_rows += statement_changes
                elif kind != "select":
                    mutated = True
            kind = final_kind
            columns = [d[0] for d in cur.description or []]
            rows = [dict(row) for row in cur.fetchmany(limit)]
            result = {"status": "ok", "columns": columns, "rows": rows,
                      "rowCount": len(rows), "duration": round((time.perf_counter() - started) * 1000, 2),
                      "operation": kind, "affectedRows": affected_rows}
            # A mutation returns the new isolated state. A custom-table SELECT
            # returns it too, allowing the browser to keep its sandbox state.
            if mutated or custom_tables is not None:
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
            rows = docs if isinstance(docs, list) else [docs]
            # Keep the aliases users see in the exam dataset panel.  This lets
            # a mentor/student use either the uploaded dataset name, the SQL
            # collection name, or the dataset id without changing execution
            # semantics.  All aliases point at the same immutable input rows.
            aliases = {str(name), str(dataset_id)}
            if meta.get("collection"):
                aliases.add(str(meta["collection"]))
            for alias in aliases:
                tables[alias] = rows
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
