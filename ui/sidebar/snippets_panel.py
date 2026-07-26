"""
ui/sidebar/snippets_panel.py
Snippets sidebar panel. Shows categorized MongoDB query snippets.
Double-click to insert into the active editor tab.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QTreeWidget,
    QTreeWidgetItem, QToolButton, QLineEdit
)
from PySide6.QtGui import QColor, QBrush

from core.snippets import snippet_registry, Snippet
from utils.theme import theme_manager
from utils.logger import get_logger

log = get_logger(__name__)


class SnippetsPanel(QWidget):
    """Sidebar panel displaying categorized MongoDB snippets."""

    snippet_selected = Signal(str)     # emits the snippet body

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
        lbl = QLabel("SNIPPETS")
        lbl.setObjectName("SidebarHeader")
        hdr_layout.addWidget(lbl)
        hdr_layout.addStretch()
        layout.addWidget(header)

        # Search
        self._search = QLineEdit()
        self._search.setPlaceholderText("🔍 Search snippets...")
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
        self._search.textChanged.connect(self._filter)
        layout.addWidget(self._search)

        # Tree
        self._tree = QTreeWidget()
        self._tree.setColumnCount(1)
        self._tree.setHeaderHidden(True)
        self._tree.setRootIsDecorated(True)
        self._tree.setAnimated(True)
        self._tree.setIndentation(14)
        self._tree.itemDoubleClicked.connect(self._on_double_click)
        self._tree.setStyleSheet(f"""
            QTreeWidget {{
                background-color: {c.get('bg_sidebar', '#252526')};
                color: {c.get('fg_primary', '#d4d4d4')};
                border: none;
                font-size: 12px;
            }}
            QTreeWidget::item {{ padding: 3px 4px; }}
            QTreeWidget::item:hover {{ background-color: {c.get('bg_hover', '#2a2d2e')}; }}
            QTreeWidget::item:selected {{ background-color: {c.get('bg_selected', '#094771')}; }}
        """)
        layout.addWidget(self._tree)

        self._populate()

    def _populate(self, snippets: list[Snippet] | None = None) -> None:
        c = theme_manager.colors()
        self._tree.clear()
        by_cat = {}
        items = snippets if snippets is not None else snippet_registry.all()
        for s in items:
            by_cat.setdefault(s.category, []).append(s)

        for cat, cat_snippets in sorted(by_cat.items()):
            cat_item = QTreeWidgetItem([f"📁 {cat}"])
            cat_item.setForeground(0, QBrush(QColor(c.get("fg_secondary", "#858585"))))
            cat_item.setExpanded(True)
            for s in cat_snippets:
                s_item = QTreeWidgetItem([f"  🔧 {s.name}"])
                s_item.setToolTip(0, f"{s.description}\n\nPrefix: {s.prefix}\n\n{s.body}")
                s_item.setData(0, Qt.ItemDataRole.UserRole, s)
                cat_item.addChild(s_item)
            self._tree.addTopLevelItem(cat_item)

    def _filter(self, text: str) -> None:
        if not text.strip():
            self._populate()
            return
        matched = snippet_registry.search(text)
        self._populate(matched)

    def _on_double_click(self, item: QTreeWidgetItem) -> None:
        s: Snippet = item.data(0, Qt.ItemDataRole.UserRole)
        if s and isinstance(s, Snippet):
            self.snippet_selected.emit(s.body)
