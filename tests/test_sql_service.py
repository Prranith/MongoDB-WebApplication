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
