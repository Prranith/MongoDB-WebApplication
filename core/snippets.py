"""
core/snippets.py
Snippet registry — loads built-in and user snippets from JSON files.
Each snippet has: name, prefix, body, description, category.
"""

import json
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

from utils.logger import get_logger

log = get_logger(__name__)

BUILTIN_SNIPPETS_FILE = Path(__file__).parent.parent / "assets" / "snippets" / "mongodb.json"
USER_SNIPPETS_FILE = Path.home() / ".mongosandbox" / "snippets.json"


@dataclass
class Snippet:
    name: str
    prefix: str
    body: str
    description: str
    category: str = "General"
    tags: list[str] = field(default_factory=list)


class SnippetRegistry:
    """Load, store, and search snippets."""

    _instance: Optional["SnippetRegistry"] = None

    def __init__(self) -> None:
        self._snippets: list[Snippet] = []
        self._load_builtin()
        self._load_user()

    @classmethod
    def instance(cls) -> "SnippetRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def all(self) -> list[Snippet]:
        return list(self._snippets)

    def by_category(self) -> dict[str, list[Snippet]]:
        cats: dict[str, list[Snippet]] = {}
        for s in self._snippets:
            cats.setdefault(s.category, []).append(s)
        return cats

    def search(self, query: str) -> list[Snippet]:
        q = query.lower()
        return [
            s for s in self._snippets
            if q in s.name.lower() or q in s.prefix.lower() or q in s.description.lower()
        ]

    def find_by_prefix(self, prefix: str) -> list[Snippet]:
        p = prefix.lower()
        return [s for s in self._snippets if s.prefix.lower().startswith(p)]

    def add_user_snippet(self, snippet: Snippet) -> None:
        self._snippets.append(snippet)
        self._save_user()

    def _load_builtin(self) -> None:
        if BUILTIN_SNIPPETS_FILE.exists():
            self._load_from_file(BUILTIN_SNIPPETS_FILE)
        else:
            log.warning("Built-in snippets file not found", path=str(BUILTIN_SNIPPETS_FILE))

    def _load_user(self) -> None:
        if USER_SNIPPETS_FILE.exists():
            self._load_from_file(USER_SNIPPETS_FILE)

    def _load_from_file(self, path: Path) -> None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for item in data.get("snippets", []):
                self._snippets.append(Snippet(
                    name=item.get("name", ""),
                    prefix=item.get("prefix", ""),
                    body=item.get("body", ""),
                    description=item.get("description", ""),
                    category=item.get("category", "General"),
                    tags=item.get("tags", []),
                ))
            log.debug("Loaded snippets", count=len(self._snippets), path=str(path))
        except Exception as e:
            log.error("Failed to load snippets", path=str(path), error=str(e))

    def _save_user(self) -> None:
        USER_SNIPPETS_FILE.parent.mkdir(parents=True, exist_ok=True)
        user_snippets = [s for s in self._snippets if s.category == "User"]
        data = {"snippets": [
            {"name": s.name, "prefix": s.prefix, "body": s.body,
             "description": s.description, "category": s.category, "tags": s.tags}
            for s in user_snippets
        ]}
        with open(USER_SNIPPETS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)


snippet_registry = SnippetRegistry.instance()
