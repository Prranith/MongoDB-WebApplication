"""
ui/sidebar/sidebar_widget.py
VS Code-style panel area — shown beside the activity bar.
Contains stacked panels: File Explorer, DB Explorer, History, Snippets, Search.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QColor
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QStackedWidget,
    QToolButton, QSizePolicy
)

from ui.sidebar.file_explorer import FileExplorer
from ui.sidebar.db_explorer   import DBExplorer
from ui.sidebar.history_panel import HistoryPanel
from ui.sidebar.snippets_panel import SnippetsPanel
from utils.theme import theme_manager
from utils.logger import get_logger

log = get_logger(__name__)

_PANEL_TITLES = {
    "files":    "Explorer",
    "db":       "DATABASE EXPLORER",
    "history":  "QUERY HISTORY",
    "snippets": "SNIPPETS",
    "search":   "SEARCH",
}

_PANEL_IDX = {k: i for i, k in enumerate(_PANEL_TITLES)}


class SidebarWidget(QWidget):
    """
    VS Code explorer panel.
    Shows a header bar + stacked panel content.
    Controlled externally by ActivityBar.
    """

    file_opened        = Signal(str, str)   # (filename, content)
    collection_clicked = Signal(str)
    schema_loaded      = Signal(str, dict)
    history_selected   = Signal(str)
    snippet_selected   = Signal(str)
    closed             = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("SidebarPanel")
        c = theme_manager.colors()
        self.setMinimumWidth(160)
        self.setMaximumWidth(400)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Expanding)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Panel header ──────────────────────────────────────────────────────
        self._header = QWidget()
        self._header.setFixedHeight(35)
        self._header.setObjectName("SidebarPanelHeader")
        hdr_layout = QHBoxLayout(self._header)
        hdr_layout.setContentsMargins(12, 0, 8, 0)
        hdr_layout.setSpacing(4)

        self._title_lbl = QLabel("Explorer")
        self._title_lbl.setObjectName("SidebarHeader")
        hdr_layout.addWidget(self._title_lbl)
        hdr_layout.addStretch()

        # Collapse button
        collapse_btn = QToolButton()
        collapse_btn.setText("⟩")
        collapse_btn.setFixedSize(18, 18)
        collapse_btn.setToolTip("Collapse sidebar")
        collapse_btn.setStyleSheet(f"""
            QToolButton {{
                background: transparent;
                color: {c.get('fg_secondary', '#969696')};
                border: none;
                font-size: 12px;
            }}
            QToolButton:hover {{
                color: {c.get('fg_primary', '#cccccc')};
            }}
        """)
        collapse_btn.clicked.connect(self._on_collapse_clicked)
        hdr_layout.addWidget(collapse_btn)
        layout.addWidget(self._header)

        # ── Stacked panels ─────────────────────────────────────────────────────
        self._stack = QStackedWidget()

        self._file_panel     = FileExplorer()
        self._db_panel       = DBExplorer()
        self._history_panel  = HistoryPanel()
        self._snippets_panel = SnippetsPanel()
        self._search_panel   = self._make_search_panel(c)

        self._file_panel.file_opened.connect(self.file_opened)
        self._db_panel.collection_clicked.connect(self.collection_clicked)
        self._db_panel.schema_loaded.connect(self.schema_loaded)
        self._history_panel.query_selected.connect(self.history_selected)
        self._snippets_panel.snippet_selected.connect(self.snippet_selected)

        self._stack.addWidget(self._file_panel)    # index 0 → "files"
        self._stack.addWidget(self._db_panel)      # index 1 → "db"
        self._stack.addWidget(self._history_panel) # index 2 → "history"
        self._stack.addWidget(self._snippets_panel)# index 3 → "snippets"
        self._stack.addWidget(self._search_panel)  # index 4 → "search"

        layout.addWidget(self._stack)

    def _on_collapse_clicked(self) -> None:
        self.hide()
        self.closed.emit()

    def hideEvent(self, event) -> None:
        super().hideEvent(event)
        self.closed.emit()

    @staticmethod
    def _make_search_panel(c: dict) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        lbl = QLabel("  Search coming soon")
        lbl.setStyleSheet(f"color: {c.get('fg_secondary','#969696')}; padding: 16px;")
        l.addWidget(lbl)
        l.addStretch()
        return w

    # ── Panel switching ────────────────────────────────────────────────────────

    def switch_to(self, key: str) -> None:
        """Called by ActivityBar when a panel button is toggled."""
        idx = list(_PANEL_TITLES.keys()).index(key) if key in _PANEL_TITLES else 0
        self._stack.setCurrentIndex(idx)
        self._title_lbl.setText(_PANEL_TITLES.get(key, "EXPLORER"))
        self.show()

    # ── Public API ─────────────────────────────────────────────────────────────

    def refresh_db(self) -> None:
        self._db_panel.refresh()

    def refresh_history(self) -> None:
        self._history_panel.refresh()

    def on_query_executed(self, result) -> None:
        self._history_panel.on_query_executed(result)
