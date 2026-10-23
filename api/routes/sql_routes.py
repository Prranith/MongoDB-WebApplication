from flask import Blueprint, jsonify, request
from services.sql.sql_service import SqlService
from services.execution.job_queue import execute as execute_job
from services.shared.idempotency import get_idempotency_key_from_request

sql_bp = Blueprint("sql_bp", __name__)


@sql_bp.route("/api/sql/run", methods=["POST"])
def run_sql():
    body = request.get_json(silent=True) or {}
    query = body.get("query", "")
    limit = body.get("limit", 500)
    tables = body.get("tables")
    result = execute_job(
        "playground_sql",
        {"query": query, "limit": limit, "tables": tables},
        lambda: SqlService.execute_query(query, limit, tables),
        idempotency_key=get_idempotency_key_from_request(request),
    )
    return jsonify(result)


@sql_bp.route("/api/sql/tables", methods=["GET"])
def sql_tables():
    return jsonify({"status": "ok", "tables": SqlService.list_tables()})
