"""
ui/command_palette.py
VS Code-style command palette — Ctrl+Shift+P.
Lists all commands with fuzzy search.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QLineEdit, QListWidget, QListWidgetItem,
    QLabel, QHBoxLayout, QWidget
)
from PySide6.QtGui import QKeySequence, QFont

from utils.theme import theme_manager


# ── Command registry ──────────────────────────────────────────────────────────

_COMMANDS = [
    ("Run Query",               "Ctrl+Enter",  "run"),
    ("Format Document",         "Ctrl+Shift+F","format"),
    ("Save Query",              "Ctrl+S",      "save"),
    ("New Tab",                 "Ctrl+T",      "new_tab"),
    ("Close Tab",               "Ctrl+W",      "close_tab"),
    ("Load Dataset (elite.json)", "",          "load_dataset"),
    ("Toggle Dark/Light Theme", "",            "toggle_theme"),
    ("Open Settings",           "",            "settings"),
    ("Open Intro Page / Dashboard", "",        "show_welcome"),
    ("Open User Manual",        "F1",          "show_user_manual"),
    ("Clear Console",           "",            "clear_console"),
    ("Open Query History",      "",            "show_history"),
    ("Export Results as JSON",  "",            "export_json"),
    ("Export Results as CSV",   "",            "export_csv"),
    ("Refresh Database Explorer","",           "refresh_db"),
    ("Duplicate Line",          "Ctrl+D",      "duplicate_line"),
    ("Delete Line",             "Ctrl+Shift+K","delete_line"),
    ("Toggle Comment",          "Ctrl+/",      "toggle_comment"),
    ("Format Query",            "Ctrl+Shift+F","format"),
    ("Find in Editor",          "Ctrl+F",      "find"),
]


class CommandPalette(QDialog):
    """
    Floating command palette triggered by Ctrl+Shift+P.
    Fuzzy-searches available commands and emits command_selected.
    """

    command_selected = Signal(str)    # emits command ID

    def __init__(self, parent=None) -> None:
        super().__init__(parent, Qt.WindowType.FramelessWindowHint | Qt.WindowType.Dialog)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setObjectName("CommandPalette")
        c = theme_manager.colors()

        self.setFixedWidth(580)
        self.setMinimumHeight(60)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Container with border/radius
        container = QWidget()
        container.setObjectName("CommandPalette")
        container.setStyleSheet(f"""
            #CommandPalette {{
                background-color: {c.get('bg_panel', '#2d2d30')};
                border: 1px solid {c.get('border', '#444444')};
                border-radius: 8px;
            }}
        """)
        container_layout = QVBoxLayout(container)
        container_layout.setContentsMargins(0, 0, 0, 0)
        container_layout.setSpacing(0)

        # Search input
        self._search = QLineEdit()
        self._search.setObjectName("CommandInput")
        self._search.setPlaceholderText(">  Type a command...")
        self._search.setFont(QFont("Segoe UI", 14))
        self._search.setFixedHeight(46)
        self._search.textChanged.connect(self._filter)
        self._search.returnPressed.connect(self._execute_selected)
        container_layout.addWidget(self._search)

        # Results list
        self._list = QListWidget()
        self._list.setStyleSheet(f"""
            QListWidget {{
                background-color: {c.get('bg_panel', '#2d2d30')};
                border: none;
                border-top: 1px solid {c.get('separator', '#333333')};
                font-size: 13px;
                color: {c.get('fg_primary', '#d4d4d4')};
            }}
            QListWidget::item {{ padding: 8px 16px; }}
            QListWidget::item:hover {{ background-color: {c.get('bg_hover', '#2a2d2e')}; }}
            QListWidget::item:selected {{ background-color: {c.get('bg_selected', '#094771')}; }}
        """)
        self._list.itemDoubleClicked.connect(self._on_item_clicked)
        container_layout.addWidget(self._list)

        layout.addWidget(container)

        self._populate(_COMMANDS)

    def _populate(self, commands: list) -> None:
        self._list.clear()
        for name, shortcut, cmd_id in commands:
            row = QWidget()
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(16, 0, 16, 0)

            name_lbl = QLabel(name)
            name_lbl.setStyleSheet("font-size: 13px;")
            row_layout.addWidget(name_lbl)
            row_layout.addStretch()

            if shortcut:
                sc_lbl = QLabel(shortcut)
                sc_lbl.setStyleSheet(
                    "background: rgba(255,255,255,0.08); border-radius: 3px; "
                    "padding: 1px 6px; font-size: 11px; color: #858585;"
                )
                row_layout.addWidget(sc_lbl)

            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, cmd_id)
            item.setSizeHint(row.sizeHint())
            self._list.addItem(item)
            self._list.setItemWidget(item, row)

        if self._list.count() > 0:
            self._list.setCurrentRow(0)
        h = min(self._list.count() * 42, 380)
        self._list.setFixedHeight(h)
        self.adjustSize()

    def _filter(self, text: str) -> None:
        text = text.lstrip(">").strip().lower()
        matched = [(n, s, c) for n, s, c in _COMMANDS if text in n.lower()]
        self._populate(matched)

    def _execute_selected(self) -> None:
        item = self._list.currentItem()
        if item:
            self._on_item_clicked(item)

    def _on_item_clicked(self, item: QListWidgetItem) -> None:
        cmd_id = item.data(Qt.ItemDataRole.UserRole)
        if cmd_id:
            self.command_selected.emit(cmd_id)
            self.accept()

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.reject()
        elif event.key() == Qt.Key.Key_Down:
            cur = self._list.currentRow()
            self._list.setCurrentRow(min(cur + 1, self._list.count() - 1))
        elif event.key() == Qt.Key.Key_Up:
            cur = self._list.currentRow()
            self._list.setCurrentRow(max(cur - 1, 0))
        else:
            super().keyPressEvent(event)

    def show_centered(self, parent) -> None:
        """Show palette centered in the parent window, slightly above center."""
        if parent:
            g = parent.geometry()
            x = g.left() + (g.width() - self.width()) // 2
            y = g.top() + int(g.height() * 0.2)
            self.move(x, y)
        self.show()
        self._search.setFocus()
        self._search.clear()
