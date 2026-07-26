"""
utils/signals.py
Global application-level Qt signal bus.

Usage:
    from utils.signals import bus
    bus.query_executed.connect(my_slot)
    bus.query_executed.emit(result)
"""

from PySide6.QtCore import QObject, Signal
from typing import Any


class _SignalBus(QObject):
    """
    Singleton signal bus that decouples all major application components.
    Emit signals here instead of directly referencing target widgets.
    """

    # ── Database ─────────────────────────────────────────────────────
    db_connected = Signal(str, str)          # uri, db_name
    db_disconnected = Signal()
    db_error = Signal(str)                   # error message
    collection_selected = Signal(str)        # collection name
    schema_refreshed = Signal(dict)          # {collection: {field: type}}

    # ── Query Lifecycle ──────────────────────────────────────────────
    query_started = Signal(str)              # raw query text
    query_executed = Signal(object)          # QueryResult object
    query_error = Signal(str, str)           # raw query, error message
    query_cancelled = Signal()

    # ── Editor ──────────────────────────────────────────────────────
    editor_text_changed = Signal(str)        # editor content
    editor_tab_changed = Signal(int)         # tab index
    editor_tab_closed = Signal(int)
    editor_format_requested = Signal()
    editor_find_requested = Signal()
    editor_save_requested = Signal()

    # ── Sidebar ──────────────────────────────────────────────────────
    snippet_inserted = Signal(str)           # snippet body text
    history_item_selected = Signal(str)      # query text
    saved_query_opened = Signal(str, str)    # name, content

    # ── UI State ────────────────────────────────────────────────────
    theme_changed = Signal(str)              # theme name
    sidebar_toggled = Signal(bool)           # visible
    inspector_toggled = Signal(bool)
    status_message = Signal(str, int)        # message, timeout_ms
    notification_show = Signal(str, str)     # title, message (toast)

    # ── Data Loading ────────────────────────────────────────────────
    dataset_loaded = Signal(int)             # document count
    results_exported = Signal(str)           # file path


# Singleton instance
bus = _SignalBus()
