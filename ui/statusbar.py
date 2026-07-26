"""
ui/statusbar.py
VS Code-style status bar — blue background, white text.
Shows: connection status, DB name, collection, cursor pos, timing.
"""

from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import QStatusBar, QLabel, QPushButton, QWidget, QHBoxLayout

from utils.theme import theme_manager
from utils.signals import bus
from utils.logger import get_logger

log = get_logger(__name__)


class StatusBar(QStatusBar):
    """Blue VS Code-style status bar at the very bottom of the window."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("AppStatusBar")
        self.setSizeGripEnabled(False)
        self.setFixedHeight(22)

        # ── Left side ───────────────────────────────────────────────────────
        self._conn_btn = QPushButton("●  Sandbox Mode")
        self._conn_btn.setObjectName("BadgeConnected")
        self._conn_btn.setToolTip("In-Memory JSON Sandbox Database Engine")
        self._conn_btn.setFixedHeight(22)
        self._conn_btn.setFlat(True)
        self.addWidget(self._conn_btn)

        self._db_label = QLabel("  practice_db")
        self._db_label.setFixedHeight(22)
        self.addWidget(self._db_label)

        self._coll_label = QLabel()
        self._coll_label.setFixedHeight(22)
        self.addWidget(self._coll_label)

        # ── Right side (permanent, right-aligned) ────────────────────────────
        self._timing_label = QLabel()
        self.addPermanentWidget(self._timing_label)

        self._docs_label = QLabel()
        self.addPermanentWidget(self._docs_label)

        self._cursor_label = QLabel("Ln 1, Col 1")
        self.addPermanentWidget(self._cursor_label)

        # Language badge
        self._lang_label = QLabel("Mongo Shell")
        self.addPermanentWidget(self._lang_label)

        # Padding on right
        pad = QLabel("  ")
        self.addPermanentWidget(pad)

        # Wire signals
        bus.db_connected.connect(self._on_connected)
        bus.db_disconnected.connect(self._on_disconnected)
        bus.query_executed.connect(self._on_result)
        bus.collection_selected.connect(self._on_collection)
        bus.status_message.connect(self._on_status)

    @Slot(str, str)
    def _on_connected(self, uri: str, db_name: str) -> None:
        self._conn_btn.setText("●  Sandbox Mode")
        self._db_label.setText(f"  {db_name or 'practice_db'}")

    @Slot()
    def _on_disconnected(self) -> None:
        self._conn_btn.setText("●  Sandbox Mode")
        self._db_label.setText("  practice_db")
        self._coll_label.setText("")

    @Slot(object)
    def _on_result(self, result) -> None:
        from utils.helpers import format_ms
        self._timing_label.setText(f"  {format_ms(result.timing_ms)}")
        if result.docs_returned:
            self._docs_label.setText(f"  {result.docs_returned:,} docs  ")
        else:
            self._docs_label.setText("")

    @Slot(str)
    def _on_collection(self, name: str) -> None:
        self._coll_label.setText(f"  {name}")

    def set_cursor_position(self, line: int, col: int) -> None:
        self._cursor_label.setText(f"Ln {line}, Col {col}")

    @Slot(str, int)
    def _on_status(self, msg: str, _ms: int) -> None:
        # Brief flash on timing label
        self._timing_label.setText(f"  {msg}")
