"""
core/autocomplete.py
IntelliSense autocomplete engine.
Provides field, operator, and keyword suggestions based on:
  - Static MongoDB operator/keyword list
  - Dynamic schema inspection from connected collection
  - Recently typed tokens
"""

from typing import Optional
from dataclasses import dataclass, field

from utils.logger import get_logger

log = get_logger(__name__)

# ── Static suggestion lists ───────────────────────────────────────────────────

AGGREGATION_STAGES = [
    "$addFields", "$bucket", "$bucketAuto", "$collStats", "$count",
    "$facet", "$geoNear", "$graphLookup", "$group", "$indexStats",
    "$limit", "$lookup", "$match", "$merge", "$out", "$project",
    "$redact", "$replaceRoot", "$replaceWith", "$sample", "$set",
    "$setWindowFields", "$skip", "$sort", "$sortByCount", "$unset",
    "$unwind",
]

COMPARISON_OPERATORS = [
    "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
]

LOGICAL_OPERATORS = [
    "$and", "$or", "$not", "$nor",
]

ELEMENT_OPERATORS = [
    "$exists", "$type",
]

ARRAY_OPERATORS = [
    "$all", "$elemMatch", "$size", "$filter", "$map", "$reduce",
    "$arrayElemAt", "$concatArrays", "$first", "$last", "$push",
    "$addToSet", "$slice",
]

EXPRESSION_OPERATORS = [
    "$abs", "$add", "$ceil", "$divide", "$exp", "$floor", "$ln",
    "$log", "$log10", "$mod", "$multiply", "$pow", "$round", "$sqrt",
    "$subtract", "$trunc",
    "$concat", "$indexOfBytes", "$indexOfCP", "$ltrim", "$regexFind",
    "$regexFindAll", "$regexMatch", "$replaceAll", "$replaceOne",
    "$rtrim", "$split", "$strLenBytes", "$strLenCP", "$strcasecmp",
    "$substr", "$substrBytes", "$substrCP", "$toLower", "$toString",
    "$toUpper", "$trim",
    "$convert", "$toBool", "$toDate", "$toDecimal", "$toDouble",
    "$toInt", "$toLong", "$toObjectId", "$type",
    "$sum", "$avg", "$min", "$max", "$stdDevPop", "$stdDevSamp",
    "$mergeObjects", "$objectToArray", "$arrayToObject",
    "$cond", "$ifNull", "$switch",
    "$year", "$month", "$week", "$dayOfMonth", "$dayOfWeek",
    "$dayOfYear", "$hour", "$minute", "$second", "$millisecond",
    "$dateToString", "$dateFromString", "$dateAdd", "$dateDiff",
]

COLLECTION_METHODS = [
    "find", "findOne", "aggregate", "insertOne", "insertMany",
    "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne",
    "countDocuments", "estimatedDocumentCount", "distinct",
    "createIndex", "dropIndex", "dropIndexes", "listIndexes",
    "watch", "bulkWrite",
]

BSON_TYPES = [
    "ObjectId", "ISODate", "NumberInt", "NumberLong", "NumberDecimal",
    "BinData", "Timestamp", "MinKey", "MaxKey", "UUID",
]

KEYWORDS = ["db", "True", "False", "None"]

ALL_STATIC: list[str] = sorted(set(
    AGGREGATION_STAGES + COMPARISON_OPERATORS + LOGICAL_OPERATORS +
    ELEMENT_OPERATORS + ARRAY_OPERATORS + EXPRESSION_OPERATORS +
    COLLECTION_METHODS + BSON_TYPES + KEYWORDS
))


# ── Suggestion dataclass ──────────────────────────────────────────────────────

@dataclass
class Suggestion:
    text: str
    kind: str       # "operator" | "field" | "keyword" | "method" | "snippet"
    detail: str = ""
    insert_text: str = ""   # if different from text

    def display(self) -> str:
        return self.text

    def insert(self) -> str:
        return self.insert_text or self.text


# ── Engine ────────────────────────────────────────────────────────────────────

class AutocompleteEngine:
    """
    Provides completion suggestions for the current word prefix.
    Call update_schema() when the connected collection changes.
    """

    _instance: Optional["AutocompleteEngine"] = None

    def __init__(self) -> None:
        self._schema_fields: list[str] = []
        self._recent_tokens: list[str] = []

    @classmethod
    def instance(cls) -> "AutocompleteEngine":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def update_schema(self, fields: list[str]) -> None:
        """Update the list of known field names from schema inspection."""
        self._schema_fields = sorted(fields)
        log.debug("Autocomplete schema updated", fields=len(fields))

    def add_recent_token(self, token: str) -> None:
        """Track recently used tokens for improved suggestions."""
        if token and token not in self._recent_tokens:
            self._recent_tokens.insert(0, token)
            self._recent_tokens = self._recent_tokens[:50]

    def suggest(self, prefix: str, max_results: int = 20) -> list[Suggestion]:
        """
        Return suggestions matching prefix.
        Priority: recent tokens → schema fields → static operators/keywords.
        """
        if not prefix:
            return []

        p = prefix.lower()
        seen: set[str] = set()
        results: list[Suggestion] = []

        def add(text: str, kind: str, detail: str = "") -> None:
            if text in seen:
                return
            if text.lower().startswith(p) and text != prefix:
                seen.add(text)
                results.append(Suggestion(text=text, kind=kind, detail=detail))

        # 1. Recent tokens (highest priority)
        for tok in self._recent_tokens:
            add(tok, "recent", "Recently used")

        # 2. Schema fields
        for f in self._schema_fields:
            add(f, "field", "Document field")

        # 3. Static MongoDB operators / keywords
        for item in ALL_STATIC:
            if item in AGGREGATION_STAGES:
                add(item, "operator", "Aggregation stage")
            elif item.startswith("$"):
                add(item, "operator", "Operator")
            elif item in COLLECTION_METHODS:
                add(item, "method", "Collection method")
            elif item in BSON_TYPES:
                add(item, "keyword", "BSON type")
            else:
                add(item, "keyword", "Keyword")

        return results[:max_results]


# Module-level singleton
autocomplete_engine = AutocompleteEngine.instance()
