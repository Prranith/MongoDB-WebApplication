"""
ui/sidebar/activity_bar.py
VS Code-style thin activity bar — leftmost vertical icon rail.
"""

from PySide6.QtCore import Qt, Signal, QSize
from PySide6.QtGui import QFont, QColor
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QPushButton, QLabel, QSizePolicy
)

_ICONS = {
    "welcome":  "🏠",   # Intro / Welcome Page
    "files":    "📄",   # File Explorer
    "db":       "\u26C1",   # ⛁ Database
    "history":  "\u27F2",   # ⟲ History
    "snippets": "{}",       # {} Snippets
    "search":   "\u2315",   # ⌕ Search
    "settings": "\u2699",   # ⚙ Settings
}

_TABS = [
    ("welcome",  "Intro / Welcome Page",True),
    ("files",    "File Explorer",      True),
    ("db",       "Database Explorer",  True),
    ("history",  "Query History",      True),
    ("snippets", "Snippets",           True),
    ("search",   "Search",             True),
]


class _IconBtn(QPushButton):
    def __init__(self, key: str, tooltip: str, parent=None) -> None:
        super().__init__(parent)
        self.key = key
        self.setCheckable(True)
        self.setFixedSize(QSize(48, 48))
        self.setToolTip(tooltip)
        self.setObjectName("ActivityBarBtn")

        f = QFont("Segoe UI", 14)
        f.setStyleHint(QFont.StyleHint.SansSerif)
        self.setFont(f)
        self.setText(_ICONS.get(key, key[:2].upper()))


class ActivityBar(QWidget):
    """
    VS Code-style vertical icon rail on the far left.
    Emits panel_toggled(key, is_active) when a panel icon is clicked.
    """

    panel_toggled = Signal(str, bool)   # (key, is_active)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("ActivityBar")
        self.setFixedWidth(48)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Expanding)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 8, 0, 8)
        layout.setSpacing(0)
        layout.setAlignment(Qt.AlignmentFlag.AlignTop)

        self._buttons: dict[str, _IconBtn] = {}

        for key, tooltip, _ in _TABS:
            btn = _IconBtn(key, tooltip, self)
            btn.toggled.connect(lambda checked, k=key: self._on_toggled(k, checked))
            self._buttons[key] = btn
            layout.addWidget(btn)

        layout.addStretch()

        settings_btn = _IconBtn("settings", "Settings", self)
        settings_btn.setCheckable(False)
        layout.addWidget(settings_btn)
        self._settings_btn = settings_btn

        self._active: str | None = "files"
        self._buttons["files"].setChecked(True)

    def _on_toggled(self, key: str, checked: bool) -> None:
        if checked:
            for k, b in self._buttons.items():
                if k != key:
                    b.blockSignals(True)
                    b.setChecked(False)
                    b.blockSignals(False)
            self._active = key
        else:
            if self._active == key:
                self._active = None
        self.panel_toggled.emit(key, checked)

    def set_active(self, key: str) -> None:
        if key in self._buttons:
            self._active = key
            for k, b in self._buttons.items():
                b.blockSignals(True)
                b.setChecked(k == key)
                b.blockSignals(False)

    def uncheck_all(self) -> None:
        """Uncheck all activity bar buttons without triggering redundant toggle events."""
        for b in self._buttons.values():
            b.blockSignals(True)
            b.setChecked(False)
            b.blockSignals(False)
        self._active = None

    @property
    def active_key(self) -> str | None:
        return self._active

    @property
    def settings_btn(self) -> _IconBtn:
        return self._settings_btn
