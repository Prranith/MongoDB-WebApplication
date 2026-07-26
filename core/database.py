"""
core/database.py
File-based MongoDB query engine.
Loads all .json files in the 'databases/' folder into an in-memory Mongo engine (mongomock).
No local MongoDB daemon or network connection required.
"""

import json
import threading
from pathlib import Path
from typing import Optional, Any
from datetime import datetime
import mongomock
from bson import ObjectId, json_util

from utils.logger import get_logger

log = get_logger(__name__)

DATABASES_DIR = Path(__file__).parent.parent / "databases"


class ConnectionState:
    CONNECTED = "connected"


# ── Monkey-patch mongomock to support $round operator ───────────────────────
import numbers
import mongomock.aggregate as ma
from pymongo.errors import OperationFailure

ma.arithmetic_operators.add('$round')
_orig_handle_arithmetic_operator = ma._Parser._handle_arithmetic_operator

def _patched_handle_arithmetic_operator(self, operator, values):
    if operator == '$round':
        if isinstance(values, (list, tuple)):
            if len(values) < 1 or len(values) > 2:
                raise OperationFailure('$round must have 1 or 2 parameters')
            parsed = list(self.parse_many(values))
            val = parsed[0]
            place = parsed[1] if len(parsed) > 1 else 0
        else:
            val = self.parse(values)
            place = 0
        if val is None:
            return None
        if not isinstance(val, numbers.Number):
            raise OperationFailure("Parameter to $round must evaluate to a number")
        return round(val, place)
    return _orig_handle_arithmetic_operator(self, operator, values)

ma._Parser._handle_arithmetic_operator = _patched_handle_arithmetic_operator


# ── Monkey-patch mongomock to support $reduce operator ──────────────────────
_orig_handle_array_operator = ma._Parser._handle_array_operator

def _patched_handle_array_operator(self, operator, value):
    if operator == '$reduce':
        if not isinstance(value, dict):
            raise OperationFailure('$reduce only supports an object as its argument')
        for k in ('input', 'initialValue', 'in'):
            if k not in value:
                raise OperationFailure("Missing '%s' parameter to $reduce" % k)
        for k in value:
            if k not in {'input', 'initialValue', 'in'}:
                raise OperationFailure('Unrecognized parameter to $reduce: %s' % k)

        input_array = self.parse(value['input'])
        if input_array is None:
            return None
        if not isinstance(input_array, (list, tuple)):
            raise OperationFailure('input to $reduce must be an array not %s' % type(input_array))

        init_val = self.parse(value['initialValue'])
        in_expr = value['in']

        accum = init_val
        for item in input_array:
            accum = ma._Parser(
                self._doc_dict,
                dict(self._user_vars, value=accum, this=item),
                ignore_missing_keys=self._ignore_missing_keys,
            ).parse(in_expr)
        return accum

    return _orig_handle_array_operator(self, operator, value)

ma._Parser._handle_array_operator = _patched_handle_array_operator


class DatabaseManager:
    """
    Pure file-based MongoDB query engine.
    Automatically loads all JSON datasets from databases/ into memory.
    """

    _instance: Optional["DatabaseManager"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._client: Optional[Any] = None
        self._db: Optional[Any] = None
        self._db_name: str = "practice_db"
        self._state: str = ConnectionState.CONNECTED
        self._error: str = ""
        self._load_json_databases()

    @classmethod
    def instance(cls) -> "DatabaseManager":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    # ── Internal JSON Loader ──────────────────────────────────────────────────

    def _load_json_databases(self) -> None:
        """Load all .json files in databases/ into in-memory collections."""
        log.info("Initializing file-based JSON database engine")
        self._client = mongomock.MongoClient()
        self._db = self._client[self._db_name]

        DATABASES_DIR.mkdir(parents=True, exist_ok=True)
        json_files = list(DATABASES_DIR.glob("*.json"))

        for json_file in json_files:
            coll_name = json_file.stem
            try:
                raw_text = json_file.read_text(encoding="utf-8")
                if not raw_text.strip():
                    continue
                docs = json_util.loads(raw_text)
                if isinstance(docs, dict):
                    docs = [docs]
                if docs:
                    self._db[coll_name].drop()
                    self._db[coll_name].insert_many(docs)
                    log.info("Loaded JSON collection", collection=coll_name, docs=len(docs))
            except Exception as e:
                log.error("Failed to load JSON file", file=json_file.name, error=str(e))

    def reload(self) -> None:
        """Reload all JSON files from databases/ directory."""
        self._load_json_databases()

    # ── Public API ─────────────────────────────────────────────────────────────

    def connect(self, uri: str = "", db_name: str = "practice_db", timeout_ms: int = 0) -> bool:
        """Always connected (file-based). Re-populates datasets if needed."""
        self._load_json_databases()
        return True

    def disconnect(self) -> None:
        pass

    def is_connected(self) -> bool:
        return True

    @property
    def is_in_memory(self) -> bool:
        return True

    @property
    def state(self) -> str:
        return ConnectionState.CONNECTED

    @property
    def error(self) -> str:
        return ""

    @property
    def db(self) -> Optional[Any]:
        return self._db

    @property
    def client(self) -> Optional[Any]:
        return self._client

    @property
    def db_name(self) -> str:
        return self._db_name

    def list_collection_names(self) -> list[str]:
        if self._db is None:
            return []
        try:
            return sorted(self._db.list_collection_names())
        except Exception as e:
            log.error("Failed to list collections", error=str(e))
            return []

    def list_collections(self) -> list[str]:
        return self.list_collection_names()

    def get_collection(self, collection_name: str) -> Optional[Any]:
        if self._db is None:
            return None
        return self._db[collection_name]

    def get_collection_stats(self, collection_name: str) -> dict[str, Any]:
        if self._db is None:
            return {}
        try:
            coll = self._db[collection_name]
            count = coll.count_documents({})
            sample = coll.find_one()
            return {"count": count, "sample": sample}
        except Exception as e:
            log.error("Failed to get stats", collection=collection_name, error=str(e))
            return {}

    def get_schema_for_collection(self, collection_name: str, sample_size: int = 100) -> dict[str, Any]:
        """Infer field types from collection documents."""
        if self._db is None:
            return {}
        try:
            coll = self._db[collection_name]
            docs = list(coll.find().limit(sample_size))
            schema: dict[str, set[str]] = {}
            for doc in docs:
                self._extract_schema(doc, "", schema)
            return {field_name: sorted(list(types)) for field_name, types in schema.items()}
        except Exception as e:
            log.error("Failed to infer schema", collection=collection_name, error=str(e))
            return {}

    def _extract_schema(self, obj: Any, prefix: str, schema: dict[str, set[str]]) -> None:
        if not isinstance(obj, dict):
            return
        for key, val in obj.items():
            field_name = f"{prefix}.{key}" if prefix else key
            val_type = self._type_name(val)
            if field_name not in schema:
                schema[field_name] = set()
            schema[field_name].add(val_type)
            if isinstance(val, dict):
                self._extract_schema(val, field_name, schema)

    @staticmethod
    def _type_name(val: Any) -> str:
        if val is None:
            return "Null"
        if isinstance(val, bool):
            return "Boolean"
        if isinstance(val, int):
            return "Int32"
        if isinstance(val, float):
            return "Double"
        if isinstance(val, str):
            return "String"
        if isinstance(val, datetime):
            return "Date"
        if isinstance(val, ObjectId):
            return "ObjectId"
        if isinstance(val, list):
            return "Array"
        if isinstance(val, dict):
            return "Object"
        return type(val).__name__


db_manager = DatabaseManager.instance()
