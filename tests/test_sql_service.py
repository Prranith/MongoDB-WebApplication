import json

import services.sql.sql_service as sql_module
from services.sql.sql_service import SqlService


def test_sql_allows_leading_line_comment():
    query = SqlService._validate("-- SQL query\nSELECT * FROM users;")
    assert query.startswith("-- SQL query")


def test_sql_allows_leading_block_comment():
    query = SqlService._validate("/* read-only */\nSELECT * FROM users")
    assert query.endswith("SELECT * FROM users")


def test_sql_rejects_comment_only_query():
    try:
        SqlService._validate("-- only a comment")
    except ValueError as exc:
        assert str(exc) == "SQL query is required"
    else:
        raise AssertionError("comment-only SQL must be rejected")


def test_sql_executes_multiple_statements_in_one_sandbox():
    result = SqlService.execute_query(
        "CREATE TABLE notes (id INTEGER, body TEXT);"
        "INSERT INTO notes VALUES (1, 'keep; semicolon');"
        "SELECT * FROM notes;",
        custom_tables={},
    )
    assert result["status"] == "ok"
    assert result["rows"] == [{"id": 1, "body": "keep; semicolon"}]
    assert result["tables"]["notes"]["__rows__"] == [{"id": 1, "body": "keep; semicolon"}]


def test_sql_accepts_common_mysql_compatibility_queries():
    result = SqlService.execute_query(
        "CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50)) ENGINE=InnoDB;"
        "INSERT INTO users (name) VALUES ('Alice');"
        "SHOW TABLES;",
        custom_tables={},
    )
    assert result["status"] == "ok"
    assert result["rows"] == [{"Tables_in_database": "users"}]


def test_sql_snapshot_preserves_primary_key_constraints():
    created = SqlService.execute_query(
        "CREATE TABLE students (stu_id INTEGER PRIMARY KEY, stu_name TEXT);",
        custom_tables={},
    )
    assert created["status"] == "ok"
    duplicate = SqlService.execute_query(
        "INSERT INTO students VALUES (1, 'first');",
        custom_tables=created["tables"],
    )
    assert duplicate["status"] == "ok"
    rejected = SqlService.execute_query(
        "INSERT INTO students VALUES (1, 'duplicate');",
        custom_tables=duplicate["tables"],
    )
    assert rejected["status"] == "error"
    assert "UNIQUE constraint failed" in rejected["error"]


def test_sql_supports_composite_keys_foreign_keys_joins_and_aggregates():
    schema = SqlService.execute_query(
        "CREATE TABLE departments (id INTEGER PRIMARY KEY, name VARCHAR(50));"
        "CREATE TABLE employees (id INTEGER PRIMARY KEY, department_id INTEGER, salary DECIMAL(10,2), "
        "PRIMARY KEY (id), FOREIGN KEY (department_id) REFERENCES departments(id));",
        custom_tables={},
    )
    assert schema["status"] == "error"  # duplicate inline/table primary key is rejected by SQLite
    schema = SqlService.execute_query(
        "CREATE TABLE departments (id INTEGER PRIMARY KEY, name VARCHAR(50));"
        "CREATE TABLE employees (id INTEGER, department_id INTEGER, salary DECIMAL(10,2), "
        "PRIMARY KEY (id), FOREIGN KEY (department_id) REFERENCES departments(id));",
        custom_tables={},
    )
    assert schema["status"] == "ok"
    data = SqlService.execute_query(
        "INSERT INTO departments VALUES (1, 'Engineering');"
        "INSERT INTO employees VALUES (10, 1, 100);"
        "INSERT INTO employees VALUES (11, 1, 150);"
        "SELECT d.name, COUNT(e.id) AS headcount, AVG(e.salary) AS average_salary "
        "FROM departments d LEFT JOIN employees e ON e.department_id = d.id "
        "GROUP BY d.id, d.name HAVING COUNT(e.id) > 0;",
        custom_tables=schema["tables"],
    )
    assert data["status"] == "ok"
    assert data["rows"][0]["headcount"] == 2
    assert data["rows"][0]["average_salary"] == 125.0
    invalid_fk = SqlService.execute_query(
        "INSERT INTO employees VALUES (12, 999, 200);",
        custom_tables=data["tables"],
    )
    assert invalid_fk["status"] == "error"


def test_sql_supports_composite_primary_key():
    schema = SqlService.execute_query(
        "CREATE TABLE enrollment (student_id INTEGER, course_id INTEGER, "
        "PRIMARY KEY (student_id, course_id));",
        custom_tables={},
    )
    first = SqlService.execute_query(
        "INSERT INTO enrollment VALUES (1, 101);",
        custom_tables=schema["tables"],
    )
    duplicate = SqlService.execute_query(
        "INSERT INTO enrollment VALUES (1, 101);",
        custom_tables=first["tables"],
    )
    assert duplicate["status"] == "error"
    assert "UNIQUE constraint failed" in duplicate["error"]


def test_exam_sql_loads_dataset_name_collection_and_id_aliases(monkeypatch):
    docs = [{"id": 1, "name": "Ada"}]

    def fake_redis_one(command):
        field = command[-1]
        if field == "dataset_docs:dataset-1":
            return json.dumps(docs)
        if field == "dataset_meta:dataset-1":
            return json.dumps({"name": "Students CSV", "collection": "students"})
        return None

    monkeypatch.setattr(sql_module, "redis_one", fake_redis_one)
    result = SqlService.execute_room_query("ROOM", ["dataset-1"], "SELECT * FROM students;")

    assert result["status"] == "ok"
    assert result["rows"] == [{"id": 1, "name": "Ada"}]
