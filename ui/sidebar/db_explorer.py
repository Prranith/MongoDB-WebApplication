"""
ui/sidebar/db_explorer.py
VS Code file-tree style MongoDB database explorer.
Shows: Databases → Collections (with document counts).
"""

from PySide6.QtCore import Qt, Signal, QThread, QTimer
from PySide6.QtGui import QColor, QBrush, QFont, QIcon
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLabel, QLineEdit, QPushButton, QMenu, QSizePolicy, QToolButton
)

from core.database import db_manager
from utils.theme import theme_manager
from utils.logger import get_logger

log = get_logger(__name__)

# ── Icons (VS Code-style text icons) ─────────────────────────────────────────
_ICON_DB    = "⊟"   # Database root
_ICON_COLL  = "≡"   # Collection
_ICON_IDX   = "⚡"  # Index (unused in tree but available)
_ICON_FIELD = "·"   # Field

# ── Tree item types ───────────────────────────────────────────────────────────
_ROLE_TYPE = Qt.ItemDataRole.UserRole
_ROLE_NAME = Qt.ItemDataRole.UserRole + 1

TYPE_DB   = "db"
TYPE_COLL = "coll"


class DBExplorer(QWidget):
    """
    VS Code file-tree style database explorer.
    Left-clicks expand/collapse, double-click inserts collection query.
    """

    collection_clicked = Signal(str)         # collection name
    schema_loaded      = Signal(str, dict)   # collection, schema dict

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("DBExplorer")
        c = theme_manager.colors()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Search / filter bar ──────────────────────────────────────────────
        search_bar = QWidget()
        search_bar.setFixedHeight(36)
        search_bar.setStyleSheet(
            f"background-color: {c.get('bg_sidebar','#252526')};"
            f"border-bottom: 1px solid {c.get('separator','#3c3c3c')};"
        )
        sb_layout = QHBoxLayout(search_bar)
        sb_layout.setContentsMargins(8, 0, 8, 0)
        sb_layout.setSpacing(4)

        self._search = QLineEdit()
        self._search.setPlaceholderText("Filter collections...")
        self._search.setStyleSheet(f"""
            QLineEdit {{
                background-color: {c.get('bg_input','#3c3c3c')};
                color: {c.get('fg_primary','#cccccc')};
                border: 1px solid {c.get('border','#3f3f3f')};
                border-radius: 3px;
                padding: 2px 8px;
                font-size: 12px;
            }}
            QLineEdit:focus {{
                border-color: {c.get('border_focus','#007acc')};
            }}
        """)
        self._search.textChanged.connect(self._filter)
        sb_layout.addWidget(self._search)

        refresh_btn = QToolButton()
        refresh_btn.setText("↻")
        refresh_btn.setFixedSize(22, 22)
        refresh_btn.setToolTip("Refresh")
        refresh_btn.setStyleSheet(f"""
            QToolButton {{
                background: transparent;
                color: {c.get('fg_secondary','#969696')};
                border: none;
                font-size: 14px;
                border-radius: 3px;
            }}
            QToolButton:hover {{
                background: {c.get('bg_hover','#2a2d2e')};
                color: {c.get('fg_primary','#cccccc')};
            }}
        """)
        refresh_btn.clicked.connect(self.refresh)
        sb_layout.addWidget(refresh_btn)
        layout.addWidget(search_bar)

        # ── Tree widget ──────────────────────────────────────────────────────
        self._tree = QTreeWidget()
        self._tree.setColumnCount(1)
        self._tree.setHeaderHidden(True)
        self._tree.setRootIsDecorated(True)
        self._tree.setAnimated(True)
        self._tree.setIndentation(12)
        self._tree.setUniformRowHeights(False)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_context_menu)
        self._tree.itemClicked.connect(self._on_item_click)
        self._tree.itemExpanded.connect(self._on_expanded)
        self._tree.setStyleSheet(f"""
            QTreeWidget {{
                background-color: {c.get('bg_sidebar','#252526')};
                color: {c.get('fg_primary','#cccccc')};
                border: none;
                font-size: 13px;
                outline: none;
            }}
            QTreeWidget::item {{
                padding: 2px 0px;
                border: none;
            }}
            QTreeWidget::item:hover {{
                background-color: {c.get('bg_hover','#2a2d2e')};
            }}
            QTreeWidget::item:selected {{
                background-color: {c.get('bg_selected','#094771')};
                color: {c.get('fg_primary','#cccccc')};
            }}
            QTreeWidget::branch {{
                background-color: {c.get('bg_sidebar','#252526')};
            }}
            QTreeWidget::branch:has-siblings:!adjoins-item {{
                border-image: none;
            }}
            QTreeWidget::branch:has-children:!has-siblings:closed,
            QTreeWidget::branch:closed:has-children:has-siblings {{
                border-image: none;
                image: none;
            }}
            QTreeWidget::branch:open:has-children:!has-siblings,
            QTreeWidget::branch:open:has-children:has-siblings {{
                border-image: none;
                image: none;
            }}
        """)
        layout.addWidget(self._tree)

        # Placeholder when not connected
        self._placeholder = QLabel("  Not connected\n  to MongoDB")
        self._placeholder.setAlignment(Qt.AlignmentFlag.AlignTop)
        self._placeholder.setStyleSheet(
            f"color: {c.get('fg_secondary','#969696')}; "
            f"font-size: 12px; padding: 16px 12px;"
        )
        layout.addWidget(self._placeholder)
        self._placeholder.hide()

        # Debounce refresh
        self._refresh_timer = QTimer(self)
        self._refresh_timer.setSingleShot(True)
        self._refresh_timer.setInterval(300)
        self._refresh_timer.timeout.connect(self._do_refresh)

        self._all_items: list[QTreeWidgetItem] = []
        self.refresh()

    # ── Public API ─────────────────────────────────────────────────────────────

    def refresh(self) -> None:
        self._refresh_timer.start()

    def _do_refresh(self) -> None:
        try:
            db_manager.reload()
        except Exception as e:
            log.error("Failed to reload database JSON files on refresh", error=str(e))
        self._tree.clear()
        self._all_items.clear()
        c = theme_manager.colors()

        if not db_manager.is_connected():
            self._tree.hide()
            self._placeholder.show()
            return

        self._tree.show()
        self._placeholder.hide()

        try:
            if not db_manager.is_connected() or db_manager.db is None:
                return

            db_name = db_manager.db_name or "practice_db"
            db_item = QTreeWidgetItem([f"⛁  {db_name}"])
            db_item.setData(0, _ROLE_TYPE, TYPE_DB)
            db_item.setData(0, _ROLE_NAME, db_name)
            db_item.setForeground(
                0, QBrush(QColor(c.get("fg_primary", "#cccccc")))
            )
            db_item.setFont(0, QFont("Segoe UI", 13, QFont.Weight.Medium))

            collections = sorted(db_manager.list_collections())
            for coll_name in collections:
                try:
                    count = db_manager.db[coll_name].count_documents({})
                    label = f"☰  {coll_name}  "
                    count_str = f"{count:,}"
                except Exception:
                    label = f"☰  {coll_name}"
                    count_str = "?"

                coll_item = QTreeWidgetItem([label])
                coll_item.setData(0, _ROLE_TYPE, TYPE_COLL)
                coll_item.setData(0, _ROLE_NAME, coll_name)
                coll_item.setForeground(
                    0, QBrush(QColor(c.get("fg_primary", "#cccccc")))
                )
                coll_item.setToolTip(0, f"{coll_name}\n{count_str} documents")
                self._all_items.append(coll_item)
                db_item.addChild(coll_item)

            self._tree.addTopLevelItem(db_item)
            db_item.setExpanded(True)

        except Exception as e:
            log.error("DB refresh failed", error=str(e))

    def _filter(self, text: str) -> None:
        text = text.lower().strip()
        for i in range(self._tree.topLevelItemCount()):
            db_item = self._tree.topLevelItem(i)
            if not db_item:
                continue
            for j in range(db_item.childCount()):
                coll_item = db_item.child(j)
                if coll_item:
                    name = coll_item.data(0, _ROLE_NAME) or ""
                    coll_item.setHidden(text != "" and text not in name.lower())

    def _on_item_click(self, item: QTreeWidgetItem) -> None:
        item_type = item.data(0, _ROLE_TYPE)
        name      = item.data(0, _ROLE_NAME)
        if item_type == TYPE_COLL and name:
            self.collection_clicked.emit(name)
            self._load_schema(name)

    def _on_expanded(self, item: QTreeWidgetItem) -> None:
        pass  # Could lazy-load collection stats here

    def _load_schema(self, collection: str) -> None:
        """Sample a few documents to infer schema."""
        try:
            if db_manager.db is None:
                return
            docs = list(db_manager.db[collection].find({}, limit=10))
            schema: dict[str, str] = {}
            for doc in docs:
                for k, v in doc.items():
                    if k not in schema:
                        schema[k] = type(v).__name__
            self.schema_loaded.emit(collection, schema)
        except Exception as e:
            log.warning("Schema inference failed", error=str(e))

    def _show_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        if not item:
            return
        item_type = item.data(0, _ROLE_TYPE)
        name      = item.data(0, _ROLE_NAME)

        menu = QMenu(self)
        if item_type == TYPE_COLL:
            menu.addAction(f"Query '{name}'", lambda: self.collection_clicked.emit(name))
            menu.addSeparator()
            menu.addAction("Count Documents", lambda: self.collection_clicked.emit(name))
            menu.addAction("Inspect Schema", lambda: self._load_schema(name))
        elif item_type == TYPE_DB:
            menu.addAction("Refresh", self.refresh)

        if not menu.isEmpty():
            menu.exec(self._tree.mapToGlobal(pos))
