from flask import Blueprint, jsonify, request
from services.sql.sql_service import SqlService

sql_bp = Blueprint("sql_bp", __name__)


@sql_bp.route("/api/sql/run", methods=["POST"])
def run_sql():
    body = request.get_json(silent=True) or {}
    return jsonify(SqlService.execute_query(body.get("query", ""), body.get("limit", 500), body.get("tables")))


@sql_bp.route("/api/sql/tables", methods=["GET"])
def sql_tables():
    return jsonify({"status": "ok", "tables": SqlService.list_tables()})
