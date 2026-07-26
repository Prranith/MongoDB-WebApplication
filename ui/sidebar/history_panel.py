"""
ui/sidebar/history_panel.py
Query history sidebar panel.
Displays recent queries with timing, result count, and favorite toggle.
"""

from PySide6.QtCore import Qt, Signal, Slot
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QListWidget,
    QListWidgetItem, QToolButton, QLineEdit, QMenu, QSizePolicy
)
from PySide6.QtGui import QColor, QBrush, QFont

from core.history import query_history, HistoryEntry
from utils.theme import theme_manager
from utils.helpers import truncate, format_timing
from utils.logger import get_logger

log = get_logger(__name__)


class HistoryPanel(QWidget):
    """Sidebar panel for query history — click to load into editor."""

    query_selected = Signal(str)    # emitted with the raw query text

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        c = theme_manager.colors()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Header
        header = QWidget()
        header.setStyleSheet(f"background-color: {c.get('bg_sidebar', '#252526')};")
        hdr_layout = QHBoxLayout(header)
        hdr_layout.setContentsMargins(10, 6, 6, 6)
        lbl = QLabel("QUERY HISTORY")
        lbl.setObjectName("SidebarHeader")
        hdr_layout.addWidget(lbl)
        hdr_layout.addStretch()
        refresh_btn = QToolButton()
        refresh_btn.setText("⟳")
        refresh_btn.setObjectName("IconButton")
        refresh_btn.setToolTip("Refresh history")
        refresh_btn.clicked.connect(self.refresh)
        hdr_layout.addWidget(refresh_btn)
        layout.addWidget(header)

        # Search bar
        self._search = QLineEdit()
        self._search.setPlaceholderText("🔍 Search history...")
        self._search.setStyleSheet(f"""
            QLineEdit {{
                background-color: {c.get('bg_input', '#3c3c3c')};
                color: {c.get('fg_primary', '#d4d4d4')};
                border: none;
                border-bottom: 1px solid {c.get('separator', '#333333')};
                padding: 5px 10px;
                font-size: 12px;
            }}
        """)
        self._search.textChanged.connect(self._on_search)
        layout.addWidget(self._search)

        # List
        self._list = QListWidget()
        self._list.setStyleSheet(f"""
            QListWidget {{
                background-color: {c.get('bg_sidebar', '#252526')};
                color: {c.get('fg_primary', '#d4d4d4')};
                border: none;
                font-size: 12px;
            }}
            QListWidget::item {{ padding: 5px 10px; border-bottom: 1px solid {c.get('separator', '#333333')}; }}
            QListWidget::item:hover {{ background-color: {c.get('bg_hover', '#2a2d2e')}; }}
            QListWidget::item:selected {{ background-color: {c.get('bg_selected', '#094771')}; }}
        """)
        self._list.itemDoubleClicked.connect(self._on_item_double_clicked)
        self._list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._list.customContextMenuRequested.connect(self._show_context_menu)
        layout.addWidget(self._list)

        self._entries: list[HistoryEntry] = []
        self.refresh()

    def refresh(self) -> None:
        self._entries = query_history.get_recent(100)
        self._populate(self._entries)

    def _populate(self, entries: list[HistoryEntry]) -> None:
        c = theme_manager.colors()
        self._list.clear()
        for entry in entries:
            short = truncate(entry.raw_query.replace("\n", " "), 60)
            timing = format_timing(entry.timing_ms) if entry.timing_ms else ""
            star = "⭐" if entry.is_favorite else ""
            status_icon = "✅" if entry.status == "ok" else ("⚠️" if entry.status == "empty" else "❌")

            item = QListWidgetItem(f"{status_icon} {short}")
            item.setToolTip(f"{entry.raw_query}\n\n⏱ {timing}  📄 {entry.docs_returned} docs\n{entry.created_at}")
            item.setData(Qt.ItemDataRole.UserRole, entry)
            if entry.status == "error":
                item.setForeground(QBrush(QColor(c.get("console_error", "#f44336"))))
            elif entry.is_favorite:
                item.setForeground(QBrush(QColor(c.get("console_warn", "#ff9800"))))
            self._list.addItem(item)

    def _on_search(self, text: str) -> None:
        if not text.strip():
            self.refresh()
            return
        entries = query_history.search(text)
        self._populate(entries)

    def _on_item_double_clicked(self, item: QListWidgetItem) -> None:
        entry: HistoryEntry = item.data(Qt.ItemDataRole.UserRole)
        if entry:
            self.query_selected.emit(entry.raw_query)

    def _show_context_menu(self, pos) -> None:
        item = self._list.itemAt(pos)
        if not item:
            return
        entry: HistoryEntry = item.data(Qt.ItemDataRole.UserRole)
        menu = QMenu(self)
        menu.addAction("Load into Editor", lambda: self.query_selected.emit(entry.raw_query))
        fav_label = "Remove from Favorites" if entry.is_favorite else "Add to Favorites"
        menu.addAction(fav_label, lambda: self._toggle_favorite(entry))
        menu.addSeparator()
        menu.addAction("Delete", lambda: self._delete_entry(entry))
        menu.exec(self._list.mapToGlobal(pos))

    def _toggle_favorite(self, entry: HistoryEntry) -> None:
        query_history.set_favorite(entry.id, not entry.is_favorite)
        self.refresh()

    def _delete_entry(self, entry: HistoryEntry) -> None:
        query_history.delete(entry.id)
        self.refresh()

    @Slot(object)
    def on_query_executed(self, result) -> None:
        """Called after every query execution to auto-refresh."""
        query_history.add(result)
        self.refresh()
