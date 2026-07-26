"""
ui/console/console_widget.py
Professional tabbed console area.
Fixed: proper sizing, clean header bar, correct status display.
"""

from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QColor, QFont, QTextCursor
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTabWidget, QTextEdit, QToolButton, QPlainTextEdit, QSizePolicy,
    QFrame
)

from ui.console.result_tree import ResultTree
from core.executor import QueryResult
from core.formatter import format_summary, result_to_display_json, format_timing
from utils.theme import theme_manager
from utils.logger import get_logger
from utils.signals import bus

log = get_logger(__name__)


class OutputTab(QWidget):
    """Split view: JSON tree + raw text, with view toggle."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        c = theme_manager.colors()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # View toggle bar
        bar = QWidget()
        bar.setFixedHeight(30)
        bar.setStyleSheet(f"""
            background-color: {c.get('bg_panel', '#2d2d30')};
            border-bottom: 1px solid {c.get('separator', '#333333')};
        """)
        bar_layout = QHBoxLayout(bar)
        bar_layout.setContentsMargins(8, 0, 8, 0)
        bar_layout.setSpacing(4)

        toggle_style = f"""
            QPushButton {{
                background: transparent;
                color: {c.get('fg_secondary', '#858585')};
                border: 1px solid transparent;
                border-radius: 3px;
                padding: 2px 10px;
                font-size: 12px;
                min-width: 60px;
            }}
            QPushButton:hover {{
                color: {c.get('fg_primary', '#d4d4d4')};
                background: {c.get('bg_hover', '#2a2d2e')};
            }}
            QPushButton:checked {{
                color: {c.get('fg_primary', '#d4d4d4')};
                background: {c.get('bg_selected', '#094771')};
                border-color: {c.get('border_focus', '#007acc')};
            }}
        """

        self._tree_btn = QPushButton("Tree")
        self._raw_btn  = QPushButton("Raw JSON")
        for btn in (self._tree_btn, self._raw_btn):
            btn.setCheckable(True)
            btn.setFixedHeight(22)
            btn.setStyleSheet(toggle_style)

        self._tree_btn.setChecked(True)
        self._tree_btn.clicked.connect(lambda: self._switch("tree"))
        self._raw_btn.clicked.connect(lambda: self._switch("raw"))

        copy_btn = QPushButton("Copy")
        copy_btn.setFixedHeight(22)
        copy_btn.setStyleSheet(toggle_style)
        copy_btn.clicked.connect(self._copy)

        expand_btn = QPushButton("Expand All")
        expand_btn.setFixedHeight(22)
        expand_btn.setStyleSheet(toggle_style)
        expand_btn.clicked.connect(lambda: self._tree_view.expand_all_items())

        bar_layout.addWidget(self._tree_btn)
        bar_layout.addWidget(self._raw_btn)
        bar_layout.addWidget(self._sep())
        bar_layout.addWidget(expand_btn)
        bar_layout.addStretch()
        bar_layout.addWidget(copy_btn)
        layout.addWidget(bar)

        # Tree view
        self._tree_view = ResultTree(self)
        layout.addWidget(self._tree_view)

        # Raw JSON view
        self._raw_view = QPlainTextEdit(self)
        self._raw_view.setReadOnly(True)
        self._raw_view.setFont(QFont("Consolas", 12))
        self._raw_view.setStyleSheet(f"""
            QPlainTextEdit {{
                background-color: {c.get('bg_console', '#1e1e1e')};
                color: {c.get('fg_primary', '#d4d4d4')};
                border: none;
                padding: 8px;
            }}
        """)
        self._raw_view.hide()
        layout.addWidget(self._raw_view)

        self._current_json = ""

    def display(self, result: QueryResult) -> None:
        if result.status == "error":
            self._current_json = f"// Error: {result.error}"
            if result.traceback_str:
                self._current_json += f"\n\n{result.traceback_str}"
            self._raw_view.setPlainText(self._current_json)
            self._switch("raw")
        elif result.status == "empty":
            self._current_json = "// No documents returned"
            self._raw_view.setPlainText(self._current_json)
            self._switch("raw")
        else:
            self._current_json = result_to_display_json(result.data)
            self._tree_view.display_results(result.data)
            self._raw_view.setPlainText(self._current_json)
            self._switch("tree")

    def _switch(self, mode: str) -> None:
        if mode == "tree":
            self._tree_btn.setChecked(True)
            self._raw_btn.setChecked(False)
            self._tree_view.show()
            self._raw_view.hide()
        else:
            self._tree_btn.setChecked(False)
            self._raw_btn.setChecked(True)
            self._tree_view.hide()
            self._raw_view.show()

    def _copy(self) -> None:
        from PySide6.QtWidgets import QApplication
        QApplication.clipboard().setText(self._current_json)
        bus.status_message.emit("Copied to clipboard", 2000)

    def clear(self) -> None:
        self._tree_view.clear()
        self._raw_view.clear()
        self._current_json = ""

    @staticmethod
    def _sep() -> QFrame:
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(16)
        sep.setStyleSheet("color: rgba(255,255,255,0.15); margin: 0 2px;")
        return sep


class LogsTab(QPlainTextEdit):
    """Plain text log view."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        c = theme_manager.colors()
        self.setReadOnly(True)
        self.setFont(QFont("Consolas", 12))
        self.setStyleSheet(f"""
            QPlainTextEdit {{
                background-color: {c.get('bg_console', '#1e1e1e')};
                color: {c.get('fg_secondary', '#858585')};
                border: none;
                padding: 6px;
            }}
        """)

    def append_log(self, message: str, level: str = "info") -> None:
        c = theme_manager.colors()
        color_map = {
            "info":    c.get("console_info",    "#569cd6"),
            "warn":    c.get("console_warn",    "#ff9800"),
            "error":   c.get("console_error",   "#f44336"),
            "success": c.get("console_success", "#4ec94e"),
        }
        color = color_map.get(level, c.get("fg_primary", "#d4d4d4"))
        self.appendHtml(f'<span style="color:{color}; font-family: Consolas;">{message}</span>')


class ConsoleWidget(QWidget):
    """
    Tabbed bottom console: Output | Logs
    Header shows execution stats.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("ConsoleArea")
        c = theme_manager.colors()
        self.setMinimumHeight(100)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Stats header ──────────────────────────────────────────────────────
        self._header = QWidget()
        self._header.setObjectName("ConsoleHeader")
        self._header.setFixedHeight(32)
        self._header.setStyleSheet(f"""
            #ConsoleHeader {{
                background-color: {c.get('bg_panel', '#2d2d30')};
                border-top: 1px solid {c.get('separator', '#333333')};
                border-bottom: 1px solid {c.get('separator', '#333333')};
            }}
        """)
        hdr = QHBoxLayout(self._header)
        hdr.setContentsMargins(12, 0, 8, 0)
        hdr.setSpacing(8)

        # Section label (left)
        section_lbl = QLabel("CONSOLE")
        section_lbl.setStyleSheet(
            f"color: {c.get('fg_secondary', '#858585')}; font-size: 11px; "
            f"font-weight: bold; letter-spacing: 1px;"
        )
        hdr.addWidget(section_lbl)

        hdr.addWidget(self._vline())

        self._status_icon  = QLabel("—")
        self._status_label = QLabel("Ready")
        self._status_label.setStyleSheet(
            f"color: {c.get('fg_primary', '#d4d4d4')}; font-size: 12px;"
        )
        hdr.addWidget(self._status_icon)
        hdr.addWidget(self._status_label)

        hdr.addStretch()

        self._time_badge = self._badge("", c.get("console_timing", "#9cdcfe"))
        self._docs_badge = self._badge("", c.get("console_success", "#4ec94e"))
        self._time_badge.hide()
        self._docs_badge.hide()

        hdr.addWidget(self._time_badge)
        hdr.addWidget(self._docs_badge)

        hdr.addWidget(self._vline())

        clear_btn = QPushButton("Clear")
        clear_btn.setFixedHeight(22)
        clear_btn.setObjectName("IconButton")
        clear_btn.clicked.connect(self.clear)
        hdr.addWidget(clear_btn)

        layout.addWidget(self._header)

        # ── Tab widget ─────────────────────────────────────────────────────────
        self._tabs = QTabWidget(self)
        self._tabs.setDocumentMode(True)
        self._tabs.tabBar().setExpanding(False)
        self._tabs.setStyleSheet(f"""
            QTabWidget::pane {{
                border: none;
                background-color: {c.get('bg_console', '#1e1e1e')};
            }}
            QTabBar::tab {{
                background-color: {c.get('bg_panel', '#2d2d30')};
                color: {c.get('fg_secondary', '#858585')};
                padding: 4px 16px;
                border: none;
                border-right: 1px solid {c.get('separator', '#333333')};
                font-size: 12px;
                min-width: 60px;
            }}
            QTabBar::tab:selected {{
                color: {c.get('fg_primary', '#d4d4d4')};
                background-color: {c.get('bg_console', '#1e1e1e')};
                border-top: 2px solid {c.get('border_focus', '#007acc')};
            }}
            QTabBar::tab:hover:!selected {{
                color: {c.get('fg_primary', '#d4d4d4')};
                background-color: {c.get('bg_hover', '#2a2d2e')};
            }}
        """)

        self._output_tab = OutputTab(self)
        self._logs_tab   = LogsTab(self)

        self._tabs.addTab(self._output_tab, "Output")
        self._tabs.addTab(self._logs_tab,   "Logs")

        layout.addWidget(self._tabs)

        bus.status_message.connect(self._on_status_msg)

    # ── Public API ─────────────────────────────────────────────────────────────

    @Slot(object)
    def display_result(self, result: QueryResult) -> None:
        c = theme_manager.colors()

        if result.status == "ok":
            icon, color = "✓", c.get("console_success", "#4ec94e")
            label = f"{result.docs_returned:,} document(s) returned"
        elif result.status == "empty":
            icon, color = "!", c.get("console_warn", "#ff9800")
            label = "No documents returned"
        else:
            icon, color = "✕", c.get("console_error", "#f44336")
            label = result.error[:100] if result.error else "Unknown error"

        self._status_icon.setText(icon)
        self._status_icon.setStyleSheet(f"color: {color}; font-weight: bold; font-size: 14px;")
        self._status_label.setText(label)
        self._status_label.setStyleSheet(f"color: {color}; font-size: 12px;")

        if result.timing_ms:
            self._time_badge.setText(f"{format_timing(result.timing_ms)}")
            self._time_badge.show()
        else:
            self._time_badge.hide()

        if result.docs_returned > 0:
            self._docs_badge.setText(f"{result.docs_returned:,} docs")
            self._docs_badge.show()
        else:
            self._docs_badge.hide()

        self._output_tab.display(result)
        self._tabs.setCurrentIndex(0)

        self._logs_tab.append_log(
            f"[{result.status.upper()}] {format_timing(result.timing_ms)} "
            f"— {result.docs_returned} docs returned",
            level="success" if result.status == "ok" else "error",
        )

    def clear(self) -> None:
        self._output_tab.clear()
        self._status_icon.setText("—")
        self._status_icon.setStyleSheet("")
        self._status_label.setText("Ready")
        self._status_label.setStyleSheet("")
        self._time_badge.hide()
        self._docs_badge.hide()

    def log(self, message: str, level: str = "info") -> None:
        self._logs_tab.append_log(message, level)
        # Switch to logs tab only for errors
        if level == "error":
            self._tabs.setCurrentIndex(1)

    @Slot(str, int)
    def _on_status_msg(self, message: str, _timeout: int) -> None:
        self._status_label.setText(message)

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _badge(text: str, color: str) -> QLabel:
        lbl = QLabel(text)
        r, g, b = _hex_rgb(color)
        lbl.setStyleSheet(f"""
            QLabel {{
                background-color: rgba({r},{g},{b},0.15);
                color: {color};
                border: 1px solid rgba({r},{g},{b},0.4);
                border-radius: 8px;
                padding: 1px 10px;
                font-size: 11px;
                font-weight: bold;
                font-family: Consolas, monospace;
            }}
        """)
        return lbl

    @staticmethod
    def _vline() -> QFrame:
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(16)
        sep.setStyleSheet("color: rgba(255,255,255,0.15); margin: 0 4px;")
        return sep


def _hex_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 6:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 136, 136, 136
