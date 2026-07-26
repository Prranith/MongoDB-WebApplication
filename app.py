"""
app.py
Application bootstrap: creates QApplication, applies theme, launches main window.
"""

import sys
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont

from utils.logger import setup_logging
from utils.config import config
from utils.theme import theme_manager
from ui.main_window import MainWindow


def create_app() -> tuple[QApplication, MainWindow]:
    """
    Initialize the Qt application, apply theme, and build the main window.
    Returns (app, window) for the caller to exec.
    """
    # Enable high-DPI scaling
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("MongoSandbox")
    app.setApplicationVersion("1.0.0")
    app.setOrganizationName("MongoSandbox")

    # Use Fusion style as base (consistent cross-platform look)
    app.setStyle("Fusion")

    # Apply Antigravity Dark theme (the one and only)
    theme_manager.apply("antigravity", app)

    # Default application font
    font = QFont("Segoe UI", 13)
    app.setFont(font)

    window = MainWindow()
    return app, window
