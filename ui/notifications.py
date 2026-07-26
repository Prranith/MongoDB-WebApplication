"""
ui/notifications.py
Toast notification system — temporary overlay popups anchored to the bottom-right of the main window.
"""

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import QWidget, QLabel, QHBoxLayout, QVBoxLayout, QPushButton, QApplication

from utils.theme import theme_manager


def _hex_to_rgb(hex_str: str) -> str:
    h = str(hex_str).lstrip('#')
    if len(h) == 6:
        return f"{int(h[0:2], 16)}, {int(h[2:4], 16)}, {int(h[4:6], 16)}"
    return "0, 122, 204"


class Toast(QWidget):
    """A single dismissable toast notification."""

    def __init__(self, title: str, message: str, kind: str = "info",
                 duration_ms: int = 4000, parent=None) -> None:
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("ToastNotification")

        c = theme_manager.colors()
        accent_colors = {
            "success": c.get("console_success", "#4ec94e"),
            "error":   c.get("console_error",   "#f44336"),
            "warn":    c.get("console_warn",    "#ff9800"),
            "info":    c.get("border_focus",    "#007acc"),
        }
        accent = accent_colors.get(kind, "#007acc")
        rgb_accent = _hex_to_rgb(accent)

        self.setStyleSheet(f"""
            #ToastNotification {{
                background-color: {c.get('bg_panel', '#252526')};
                border: 1px solid {c.get('border', '#3c3c3c')};
                border-left: 4px solid {accent};
                border-radius: 6px;
            }}
        """)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(10)

        # Icon badge
        icon_symbols = {
            "success": "✓",
            "error":   "✕",
            "warn":    "!",
            "info":    "i",
        }
        icon_lbl = QLabel(icon_symbols.get(kind, "i"))
        icon_lbl.setFixedSize(22, 22)
        icon_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        icon_lbl.setStyleSheet(f"""
            background-color: rgba({rgb_accent}, 0.18);
            color: {accent};
            font-weight: bold;
            font-size: 13px;
            border-radius: 11px;
        """)
        layout.addWidget(icon_lbl, 0, Qt.AlignmentFlag.AlignTop)

        text_col = QVBoxLayout()
        text_col.setContentsMargins(0, 0, 0, 0)
        text_col.setSpacing(3)

        title_lbl = QLabel(title)
        title_lbl.setStyleSheet(f"color: {c.get('fg_primary', '#cccccc')}; font-weight: bold; font-size: 13px;")
        text_col.addWidget(title_lbl)

        if message:
            msg_lbl = QLabel(message)
            msg_lbl.setStyleSheet(f"color: {c.get('fg_secondary', '#969696')}; font-size: 12px;")
            msg_lbl.setWordWrap(True)
            text_col.addWidget(msg_lbl)

        layout.addLayout(text_col, 1)

        close_btn = QPushButton("×")
        close_btn.setFixedSize(22, 22)
        close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        close_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #858585;
                border: none;
                font-size: 18px;
                font-weight: bold;
            }
            QPushButton:hover {
                color: #ffffff;
                background-color: rgba(255,255,255,0.15);
                border-radius: 4px;
            }
        """)
        close_btn.clicked.connect(self.dismiss)
        layout.addWidget(close_btn, 0, Qt.AlignmentFlag.AlignTop)

        self.setFixedWidth(380)
        self.adjustSize()

        # Auto-dismiss
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.dismiss)
        self._timer.start(duration_ms)

    def dismiss(self) -> None:
        self._timer.stop()
        self.hide()
        self.deleteLater()


class NotificationManager:
    """
    Manages stacking toast notifications in the bottom-right corner of the main window.
    """

    _toasts: list[Toast] = []

    @classmethod
    def show(cls, title: str, message: str = "", kind: str = "info",
             duration_ms: int = 4000, parent=None) -> None:
        """Show a new toast notification."""
        if parent is None:
            parent = QApplication.activeWindow()

        toast = Toast(title, message, kind, duration_ms, parent=parent)
        toast.show()
        toast.raise_()
        cls._toasts.append(toast)
        cls._position_toasts(parent)

        def _remove(t=toast):
            if t in cls._toasts:
                cls._toasts.remove(t)
            cls._position_toasts(parent)

        toast._timer.timeout.connect(_remove)

    @classmethod
    def _position_toasts(cls, parent) -> None:
        """Stack toasts at the exact rightmost side of the main window."""
        if parent is None:
            parent = QApplication.activeWindow()
        if parent is None:
            return

        right_margin = 20
        current_bottom_y = parent.height() - 32   # 10px above status bar

        for toast in reversed(cls._toasts):
            if toast.isVisible():
                x = parent.width() - toast.width() - right_margin
                y = current_bottom_y - toast.height()
                toast.move(x, y)
                toast.raise_()
                current_bottom_y = y - 8
