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
