"""
ui/connect_dialog.py
MongoDB connection dialog and IDE Settings dialog.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit,
    QPushButton, QSpinBox, QComboBox, QFormLayout, QFrame, QDialogButtonBox
)
from PySide6.QtGui import QFont

from utils.config import config
from utils.theme import theme_manager


class ConnectDialog(QDialog):
    """Modal dialog for configuring MongoDB connection."""

    connect_requested = Signal(str, str, int)   # uri, db_name, timeout_ms

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Connect to MongoDB — MongoSandbox")
        self.setMinimumWidth(440)
        self.setModal(True)
        c = theme_manager.colors()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 24)
        layout.setSpacing(16)

        title = QLabel("Connect to MongoDB")
        title.setFont(QFont("Segoe UI", 14, QFont.Weight.Bold))
        layout.addWidget(title)

        form = QFormLayout()
        form.setSpacing(12)

        self._uri_input = QLineEdit()
        self._uri_input.setText(config.get("mongo_uri", "mongodb://localhost:27017/"))
        self._uri_input.setPlaceholderText("mongodb://localhost:27017/")
        form.addRow(QLabel("Connection URI:"), self._uri_input)

        self._db_input = QLineEdit()
        self._db_input.setText(config.get("default_db", "practice_db"))
        self._db_input.setPlaceholderText("practice_db")
        form.addRow(QLabel("Database Name:"), self._db_input)

        self._timeout_spin = QSpinBox()
        self._timeout_spin.setRange(1, 60)
        self._timeout_spin.setSuffix(" s")
        self._timeout_spin.setValue(config.get("query_timeout_s", 30))
        form.addRow(QLabel("Connect Timeout:"), self._timeout_spin)

        layout.addLayout(form)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet(f"color: {c.get('separator', '#333333')};")
        layout.addWidget(sep)

        btn_box = QHBoxLayout()
        btn_box.addStretch()

        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_box.addWidget(cancel_btn)

        connect_btn = QPushButton("Connect")
        connect_btn.setObjectName("PrimaryButton")
        connect_btn.setDefault(True)
        connect_btn.clicked.connect(self._on_connect)
        btn_box.addWidget(connect_btn)

        layout.addLayout(btn_box)

    def _on_connect(self) -> None:
        uri = self._uri_input.text().strip()
        db = self._db_input.text().strip()
        timeout = self._timeout_spin.value()
        if uri and db:
            config.update({"mongo_uri": uri, "default_db": db})
            self.connect_requested.emit(uri, db, timeout)
            self.accept()


class SettingsDialog(QDialog):
    """Settings dialog with options for Editor Font Family, Font Size, Tab Width, etc."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Settings — MongoSandbox")
        self.setMinimumSize(560, 440)
        self.setModal(True)
        c = theme_manager.colors()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 24)
        layout.setSpacing(16)

        title = QLabel("⚙  Settings")
        title.setFont(QFont("Segoe UI", 14, QFont.Weight.Bold))
        layout.addWidget(title)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet(f"color: {c.get('separator', '#333333')};")
        layout.addWidget(sep)

        form = QFormLayout()
        form.setSpacing(14)
        lbl_style = f"color: {c.get('fg_primary', '#d4d4d4')}; font-weight: 500;"

        # Font Family
        self._font_family = QComboBox()
        families = ["Cascadia Code", "Consolas", "Fira Code", "JetBrains Mono", "Courier New"]
        self._font_family.addItems(families)
        current_family = config.get("font_family", "Cascadia Code")
        idx = self._font_family.findText(current_family)
        if idx >= 0:
            self._font_family.setCurrentIndex(idx)
        form.addRow(QLabel("Editor Font Family:", styleSheet=lbl_style), self._font_family)

        # Font size
        self._font_size = QSpinBox()
        self._font_size.setRange(8, 36)
        self._font_size.setSuffix(" pt")
        self._font_size.setValue(config.get("font_size", 13))
        form.addRow(QLabel("Editor Font Size:", styleSheet=lbl_style), self._font_size)

        # Tab width
        self._tab_width = QSpinBox()
        self._tab_width.setRange(1, 8)
        self._tab_width.setSuffix(" spaces")
        self._tab_width.setValue(config.get("tab_width", 2))
        form.addRow(QLabel("Tab Width:", styleSheet=lbl_style), self._tab_width)

        # Max results
        self._max_results = QSpinBox()
        self._max_results.setRange(100, 100000)
        self._max_results.setSingleStep(500)
        self._max_results.setValue(config.get("max_results", 10000))
        form.addRow(QLabel("Max Results:", styleSheet=lbl_style), self._max_results)

        # Query timeout
        self._timeout = QSpinBox()
        self._timeout.setRange(5, 300)
        self._timeout.setSuffix(" s")
        self._timeout.setValue(config.get("query_timeout_s", 30))
        form.addRow(QLabel("Query Timeout:", styleSheet=lbl_style), self._timeout)

        layout.addLayout(form)
        layout.addStretch()

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Save).setObjectName("PrimaryButton")
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _save(self) -> None:
        config.update({
            "font_family": self._font_family.currentText(),
            "font_size": self._font_size.value(),
            "tab_width": self._tab_width.value(),
            "max_results": self._max_results.value(),
            "query_timeout_s": self._timeout.value(),
        })
        self.accept()
