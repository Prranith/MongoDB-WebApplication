"""
utils/config.py
User configuration management using TOML (Python 3.11+) or JSON fallback.
Stores settings in the user's home directory under ~/.mongosandbox/config.toml
"""

import json
import sys
from pathlib import Path
from typing import Any

# Use built-in tomllib (Python 3.11+) or fallback to json
if sys.version_info >= (3, 11):
    import tomllib
    _TOML_AVAILABLE = True
else:
    _TOML_AVAILABLE = False


CONFIG_DIR = Path.home() / ".mongosandbox"
CONFIG_FILE = CONFIG_DIR / "config.json"  # JSON for max compatibility

DEFAULTS: dict[str, Any] = {
    "theme": "dark_plus",
    "font_family": "Consolas",
    "font_size": 13,
    "tab_width": 2,
    "autocomplete_delay_ms": 150,
    "max_results": 10000,
    "query_timeout_s": 30,
    "animations_enabled": True,
    "default_db": "practice_db",
    "default_collection": "elite_data",
    "show_sidebar": True,
    "show_inspector": True,
    "show_minimap": False,
    "editor_wrap": False,
    "history_max": 500,
    "autosave_interval_s": 60,
    "log_level": "INFO",
    "window_geometry": None,
    "window_state": None,
}


class ConfigManager:
    """
    Reads and writes user configuration as JSON.
    Missing keys always fall back to DEFAULTS.
    """

    _instance: "ConfigManager | None" = None

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._load()

    @classmethod
    def instance(cls) -> "ConfigManager":
        """Singleton accessor."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: str, fallback: Any = None) -> Any:
        """Return config value, falling back to DEFAULTS then fallback."""
        if key in self._data:
            return self._data[key]
        if key in DEFAULTS:
            return DEFAULTS[key]
        return fallback

    def set(self, key: str, value: Any) -> None:
        """Update a config value and persist immediately."""
        self._data[key] = value
        self._save()

    def update(self, mapping: dict[str, Any]) -> None:
        """Bulk update multiple keys and persist."""
        self._data.update(mapping)
        self._save()

    def reset(self) -> None:
        """Reset all config to defaults."""
        self._data = {}
        self._save()

    def all(self) -> dict[str, Any]:
        """Return merged dict of defaults + user overrides."""
        merged = dict(DEFAULTS)
        merged.update(self._data)
        return merged

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
            except (json.JSONDecodeError, OSError):
                self._data = {}
        else:
            self._data = {}

    def _save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, default=str)


# Module-level convenience
config = ConfigManager.instance()
