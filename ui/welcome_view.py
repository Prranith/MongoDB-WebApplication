"""
ui/welcome_view.py
Official MongoDB UI theme aesthetic intro screen with matching #ffffff background.
Seamlessly matches image.png canvas, removing rectangular borders with official MongoDB Forest Green typography.
"""

from pathlib import Path
from PySide6.QtCore import Qt, Signal, Slot, QUrl, QTimer
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame
)
from PySide6.QtGui import QFont, QPixmap, QDesktopServices

from utils.analytics import analytics_tracker
from utils.theme import theme_manager

LOGO_PATH = Path(__file__).parent / "image.png"


class WelcomeView(QWidget):
    """
    Official MongoDB UI Intro Screen matching image.png white background and Forest Green typography.
    """

    enter_ide_requested = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("WelcomeView")

        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # Official MongoDB White Canvas Container (matching image.png)
        container = QFrame()
        container.setObjectName("IntroContainer")
        container.setStyleSheet("""
            QFrame#IntroContainer {
                background-color: #ffffff;
                border: none;
            }
        """)

        c_layout = QVBoxLayout(container)
        c_layout.setContentsMargins(48, 36, 48, 32)
        c_layout.setSpacing(0)

        # ── 1. Top Centered Title Section ─────────────────────────────────────
        title_box = QVBoxLayout()
        title_box.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title_box.setSpacing(8)

        # Title line 1: "Welcome to  MongoDB Practise"
        title_line1 = QLabel("Welcome to  MongoDB Practise")
        title_line1.setFont(QFont("Segoe UI", 48, QFont.Weight.Bold))
        title_line1.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title_line1.setStyleSheet("color: #001e2b; letter-spacing: 0.5px;")

        # Title line 2: "Workspace" (MongoDB Forest Green)
        title_line2 = QLabel("Workspace")
        title_line2.setFont(QFont("Segoe UI", 56, QFont.Weight.Black))
        title_line2.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title_line2.setStyleSheet("color: #00684a; letter-spacing: 1px;")

        # Subtitle: "A unified platform to learn mongodb precisely"
        subtitle = QLabel("A unified platform to learn mongodb precisely")
        subtitle.setFont(QFont("Segoe UI", 28, QFont.Weight.DemiBold))
        subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)
        subtitle.setStyleSheet("color: #334155; margin-top: 10px;")

        title_box.addWidget(title_line1)
        title_box.addWidget(title_line2)
        title_box.addWidget(subtitle)

        c_layout.addLayout(title_box)
        c_layout.addStretch(1)

        # ── 2. Center MongoDB Logo Image (Seamless Blend) & Launch Button ───────
        center_box = QVBoxLayout()
        center_box.setAlignment(Qt.AlignmentFlag.AlignCenter)
        center_box.setSpacing(24)

        logo_lbl = QLabel()
        logo_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        logo_lbl.setCursor(Qt.CursorShape.PointingHandCursor)
        logo_lbl.setStyleSheet("background-color: transparent;")

        if LOGO_PATH.exists():
            pixmap = QPixmap(str(LOGO_PATH))
            if not pixmap.isNull():
                # Scale logo cleanly (440x440)
                scaled_pixmap = pixmap.scaled(
                    440, 440,
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation
                )
                logo_lbl.setPixmap(scaled_pixmap)

        # Allow clicking logo to launch workspace
        logo_lbl.mousePressEvent = lambda event: self.enter_ide_requested.emit()
        center_box.addWidget(logo_lbl)

        # Enter Workspace CTA Button (MongoDB Forest Green)
        enter_btn = QPushButton("🚀 Enter Workspace ➔")
        enter_btn.setFixedHeight(56)
        enter_btn.setMinimumWidth(280)
        enter_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        enter_btn.setStyleSheet("""
            QPushButton {
                background-color: #00684a;
                color: #ffffff;
                border: none;
                border-radius: 10px;
                font-size: 18px;
                font-weight: bold;
                padding: 0 28px;
            }
            QPushButton:hover {
                background-color: #00ed64;
                color: #001e2b;
            }
        """)
        enter_btn.clicked.connect(self.enter_ide_requested.emit)
        center_box.addWidget(enter_btn)

        c_layout.addLayout(center_box)
        c_layout.addStretch(1)

        # ── 3. Bottom Footer Row (Stats Left, Developer Right) ───────────────
        bottom_row = QHBoxLayout()
        bottom_row.setContentsMargins(0, 0, 0, 0)
        bottom_row.setAlignment(Qt.AlignmentFlag.AlignBottom)

        # Bottom Left: Analytics Stats
        stats_box = QVBoxLayout()
        stats_box.setSpacing(6)

        self._active_users_lbl = QLabel("Active Users : 0")
        self._active_users_lbl.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        self._active_users_lbl.setStyleSheet("color: #001e2b;")

        self._total_visited_lbl = QLabel("Total Visited : 0")
        self._total_visited_lbl.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        self._total_visited_lbl.setStyleSheet("color: #00684a;")

        stats_box.addWidget(self._active_users_lbl)
        stats_box.addWidget(self._total_visited_lbl)

        bottom_row.addLayout(stats_box)
        bottom_row.addStretch(1)

        # Bottom Right: Developer Info & Link
        dev_box = QVBoxLayout()
        dev_box.setSpacing(6)
        dev_box.setAlignment(Qt.AlignmentFlag.AlignRight)

        dev_name_lbl = QLabel("Visit developer : Prranith Swargam")
        dev_name_lbl.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        dev_name_lbl.setAlignment(Qt.AlignmentFlag.AlignRight)
        dev_name_lbl.setStyleSheet("color: #001e2b;")

        dev_link_lbl = QLabel(
            '<a href="https://www.linkedin.com/in/prranith-swargam-a620a6334/" '
            'style="color: #0284c7; text-decoration: underline; font-weight: bold;">'
            'https://www.linkedin.com/in/prranith-swargam-a620a6334/</a>'
        )
        dev_link_lbl.setFont(QFont("Segoe UI", 15))
        dev_link_lbl.setAlignment(Qt.AlignmentFlag.AlignRight)
        dev_link_lbl.setOpenExternalLinks(True)

        dev_box.addWidget(dev_name_lbl)
        dev_box.addWidget(dev_link_lbl)

        bottom_row.addLayout(dev_box)

        c_layout.addLayout(bottom_row)
        main_layout.addWidget(container)

        # Setup real-time live refresh timer (every 3 seconds)
        self._live_timer = QTimer(self)
        self._live_timer.setInterval(3000)
        self._live_timer.timeout.connect(self.refresh_stats)
        self._live_timer.start()

        self.refresh_stats()

    def refresh_stats(self) -> None:
        """Refresh real-time active users & total visited counts."""
        stats = analytics_tracker.get_stats()
        visited = stats.get("total_visits", 1)
        active = stats.get("active_users", 1)

        self._active_users_lbl.setText(f"Active Users : {active}")
        self._total_visited_lbl.setText(f"Total Visited : {visited}")
