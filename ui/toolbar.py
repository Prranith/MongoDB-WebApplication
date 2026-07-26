"""
ui/toolbar.py
Top action toolbar — clean, professional layout with no emoji icons.
"""

from PySide6.QtCore import Signal, Qt
from PySide6.QtWidgets import (
    QToolBar, QWidget, QHBoxLayout, QPushButton, QLabel,
    QComboBox, QFrame, QSizePolicy
)
from PySide6.QtGui import QKeySequence, QFont

from utils.theme import theme_manager, ThemeManager
from utils.config import config
from utils.logger import get_logger

log = get_logger(__name__)


class Toolbar(QToolBar):
    """Top application toolbar."""

    run_clicked          = Signal()
    format_clicked       = Signal()
    save_clicked         = Signal()
    load_dataset_clicked = Signal()
    settings_clicked     = Signal()
    theme_changed        = Signal(str)
    palette_clicked      = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("MainToolbar")
        self.setMovable(False)
        self.setFloatable(False)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.PreventContextMenu)
        self.setFixedHeight(46)

        container = QWidget()
        layout = QHBoxLayout(container)
        layout.setContentsMargins(12, 0, 12, 0)
        layout.setSpacing(4)

        # Brand
        brand = QLabel("MongoSandbox")
        brand.setStyleSheet(
            "font-size: 14px; font-weight: bold; color: #4ec9b0; "
            "padding-right: 12px; letter-spacing: 0.5px;"
        )
        layout.addWidget(brand)

        layout.addWidget(self._vsep())

        # Run button (primary, green)
        self._run_btn = QPushButton("  Run")
        self._run_btn.setObjectName("RunButton")
        self._run_btn.setToolTip("Run query  (Ctrl+Enter)")
        self._run_btn.setFixedHeight(30)
        self._run_btn.setMinimumWidth(80)
        self._run_btn.clicked.connect(self.run_clicked)
        layout.addWidget(self._run_btn)

        # Secondary action buttons
        for label, tooltip, signal_name in [
            ("Format",       "Auto-format query (Ctrl+Shift+F)",   "format_clicked"),
            ("Save",         "Save query (Ctrl+S)",                "save_clicked"),
        ]:
            btn = self._action_btn(label, tooltip)
            btn.clicked.connect(getattr(self, signal_name))
            layout.addWidget(btn)

        layout.addWidget(self._vsep())

        for label, tooltip, signal_name in [
            ("Load Dataset", "Load elite.json dataset into sandbox", "load_dataset_clicked"),
        ]:
            btn = self._action_btn(label, tooltip)
            btn.clicked.connect(getattr(self, signal_name))
            layout.addWidget(btn)

        layout.addStretch()

        # Command palette hint (center-right)
        palette_btn = QPushButton("Ctrl+Shift+P  —  Command Palette")
        palette_btn.setFixedHeight(28)
        palette_btn.setStyleSheet("""
            QPushButton {
                background-color: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 4px;
                color: #858585;
                padding: 0 14px;
                font-size: 12px;
            }
            QPushButton:hover {
                background-color: rgba(255,255,255,0.10);
                color: #cccccc;
            }
        """)
        palette_btn.clicked.connect(self.palette_clicked)
        layout.addWidget(palette_btn)

        layout.addWidget(self._vsep())

        # Theme label + combo
        theme_label = QLabel("Theme:")
        theme_label.setStyleSheet("color: #858585; font-size: 12px; padding-right: 4px;")
        layout.addWidget(theme_label)

        self._theme_combo = QComboBox()
        self._theme_combo.setFixedWidth(130)
        self._theme_combo.setFixedHeight(28)
        for name in ThemeManager.list_themes():
            label = theme_manager.get_theme(name).get("name", name)
            self._theme_combo.addItem(label, userData=name)

        current = theme_manager.current_name()
        for i in range(self._theme_combo.count()):
            if self._theme_combo.itemData(i) == current:
                self._theme_combo.setCurrentIndex(i)
                break

        self._theme_combo.currentIndexChanged.connect(self._on_theme_changed)
        layout.addWidget(self._theme_combo)

        layout.addWidget(self._vsep())

        # Settings button
        settings_btn = self._action_btn("Settings", "Open settings")
        settings_btn.clicked.connect(self.settings_clicked)
        layout.addWidget(settings_btn)

        self.addWidget(container)

    def set_running(self, running: bool) -> None:
        """Toggle run/stop visual state."""
        if running:
            self._run_btn.setText("  Stop")
            self._run_btn.setStyleSheet("""
                QPushButton {
                    background-color: #c72e2e;
                    color: white; border: none;
                    border-radius: 5px; padding: 0 18px;
                    font-weight: bold; font-size: 13px;
                }
                QPushButton:hover { background-color: #d94444; }
            """)
        else:
            self._run_btn.setText("  Run")
            self._run_btn.setStyleSheet("")
            self._run_btn.setObjectName("RunButton")
            self._run_btn.style().unpolish(self._run_btn)
            self._run_btn.style().polish(self._run_btn)

    def _on_theme_changed(self, idx: int) -> None:
        name = self._theme_combo.itemData(idx)
        if name:
            self.theme_changed.emit(name)

    @staticmethod
    def _action_btn(text: str, tooltip: str = "") -> QPushButton:
        btn = QPushButton(text)
        btn.setObjectName("IconButton")
        btn.setFixedHeight(28)
        btn.setMinimumWidth(60)
        if tooltip:
            btn.setToolTip(tooltip)
        return btn

    @staticmethod
    def _vsep() -> QFrame:
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(20)
        sep.setStyleSheet("color: rgba(255,255,255,0.15); margin: 0 4px;")
        return sep
