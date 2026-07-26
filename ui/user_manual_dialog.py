"""
ui/user_manual_dialog.py
Interactive multi-step User Manual & Application User Story dialog for MongoSandbox.
Displays application features, dataset details, schema relations, and query tips step-by-step.
"""

from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QListWidget, QListWidgetItem, QStackedWidget, QWidget,
    QFrame, QProgressBar, QTextEdit, QScrollArea
)
from PySide6.QtGui import QFont, QKeySequence, QShortcut
from utils.theme import theme_manager


MANUAL_STEPS = [
    {
        "id": "overview",
        "icon": "🚀",
        "title": "Step 1: Overview & Workspace",
        "subtitle": "Welcome to MongoSandbox — The LeetCode of MongoDB",
        "summary": (
            "MongoSandbox is an interactive IDE designed for learning, testing, and mastering MongoDB. "
            "It features a dual database engine, syntax-highlighted editor, dual output console, live schema inspector, and ER diagram visualizer."
        ),
        "highlights": [
            "In-Memory Database Engine: Pure Python file-based JSON engine without requiring any local MongoDB server",
            "3-Pane IDE Layout: Explorer Sidebar, Multi-Tab Editor, Output Console, and Schema Inspector",
            "Command Palette (Ctrl+Shift+P): Instant access to all actions and shortcuts",
            "Zero Configuration Required: Pre-configured sample datasets ready out of the box"
        ],
        "code": "// Simple query example\ndb.users.find({ status: \"active\" })"
    },
    {
        "id": "datasets",
        "icon": "🗄️",
        "title": "Step 2: Datasets & Sidebar Explorer",
        "subtitle": "Explore Pre-loaded Practice Datasets",
        "summary": (
            "MongoSandbox comes bundled with 5 real-world datasets for practicing queries, filtering, and multi-collection relational aggregations."
        ),
        "highlights": [
            "users (132 docs) — User profiles, roles, addresses, and account creation dates",
            "orders (160 docs) — Customer orders referencing user_id, order items, totals, and statuses",
            "inventory (100 docs) — Product catalog with SKUs, stock levels, categories, and pricing",
            "shipments (84 docs) — Logistics data linking order_id, carrier, tracking code, and delivery status",
            "elite (104 docs) — Advanced nested data structures for complex pipeline practice",
            "Sidebar Tree: Expand collections to view field names and document counts"
        ],
        "code": "// Count total documents in inventory\ndb.inventory.countDocuments({ stock: { $lt: 20 } })"
    },
    {
        "id": "editor",
        "icon": "📝",
        "title": "Step 3: Multi-Tab Query Editor & Autocomplete",
        "subtitle": "Write Queries with Intelligent Autocomplete",
        "summary": (
            "The editor supports MongoDB JavaScript syntax, multi-tab editing, auto-formatting, and context-aware IntelliSense code completion."
        ),
        "highlights": [
            "Multi-Tab Workspace: Press Ctrl+T to open a new tab, Ctrl+W to close",
            "IntelliSense Autocomplete: Suggestions for collection names, query methods, and $ operators",
            "Run Query Shortcut: Press Ctrl+Enter or click ▶ Run to execute instantly",
            "Format Code: Press Ctrl+Shift+F to beautify your MongoDB query document"
        ],
        "code": "// Complex aggregation query example\ndb.orders.aggregate([\n  { $match: { status: \"DELIVERED\" } },\n  { $group: { _id: \"$user_id\", totalSpent: { $sum: \"$total_amount\" } } },\n  { $sort: { totalSpent: -1 } }\n])"
    },
    {
        "id": "console",
        "icon": "⚡",
        "title": "Step 4: Execution & Dual Output Console",
        "subtitle": "Analyze Execution Results & Performance",
        "summary": (
            "Query results are rendered asynchronously without freezing the UI. Switch between flexible Table View and JSON Tree View."
        ),
        "highlights": [
            "📊 Table View: Dynamic auto-stretching columns showing full values without clipping",
            "🌲 JSON Tree View: Formatted expandable document view for deep inspection",
            "Execution Metrics: Shows exact execution timing in milliseconds (ms) and document count",
            "Clear Output: Easily clear or copy results with toolbar actions"
        ],
        "code": "// Output metric example\n// [SUCCESS] 160 docs returned  ·  4.2 ms"
    },
    {
        "id": "inspector",
        "icon": "🔍",
        "title": "Step 5: Right-Hand Inspector & Field Mapping",
        "subtitle": "Live Schema & Relational Field Inspection",
        "summary": (
            "The right-hand Inspector displays live field types, document counts, sample values, and relational links across collections."
        ),
        "highlights": [
            "📋 Fields Section: View all top-level and nested field data types and sample values",
            "🔗 Relations Section: Detects foreign key relationships (e.g. orders.user_id ➔ users)",
            "Toggle Inspector: Click ⧉ Inspector in Run bar or press Ctrl+I to show/hide",
            "Flexible Resizing: Drag the splitter handle to adjust pane width from 160px to 400px"
        ],
        "code": "// Relational Mapping Example:\n// orders.user_id ➔ users._id\n// shipments.order_id ➔ orders._id\n// orders.items.sku ➔ inventory.sku"
    },
    {
        "id": "relations",
        "icon": "🔗",
        "title": "Step 6: Schema Relations Visualizer",
        "subtitle": "Visual ER Diagram & Automatic Join Code Generator",
        "summary": (
            "Click ⧉ Details in the Inspector header to launch the interactive Schema Overlay modal with an ER Diagram and copyable $lookup pipelines."
        ),
        "highlights": [
            "Visual ER Diagram: Clean cards illustrating foreign key links across all 5 datasets",
            "Copyable Aggregation Code: Auto-generates exact MongoDB $lookup pipelines for joining collections",
            "Interactive Filtering: Click any collection card to inspect its relationships",
            "On-Demand Opening: Launch directly from the Inspector header whenever needed"
        ],
        "code": "// Auto-generated $lookup aggregation\ndb.orders.aggregate([\n  {\n    $lookup: {\n      from: \"users\",\n      localField: \"user_id\",\n      foreignField: \"_id\",\n      as: \"user_details\"\n    }\n  }\n])"
    },
    {
        "id": "snippets",
        "icon": "📚",
        "title": "Step 7: Snippets & Query History",
        "subtitle": "Re-use Common MongoDB Aggregation Pipelines",
        "summary": (
            "Access pre-built MongoDB query templates and revisit any past query from your execution history."
        ),
        "highlights": [
            "Pre-built Snippets: One-click insert for $lookup joins, $group aggregations, pagination & $unwind",
            "Query History: Auto-saves executed queries with searchable history list",
            "Double-Click Insert: Click any snippet or history item to insert directly into the editor"
        ],
        "code": "// Snippet: Group by field & calculate total\ndb.orders.aggregate([\n  { $group: { _id: \"$status\", count: { $sum: 1 } } }\n])"
    },
    {
        "id": "settings",
        "icon": "⚙️",
        "title": "Step 8: Settings & Keyboard Shortcuts",
        "subtitle": "Customize Your Environment & Speed Up Workflow",
        "summary": (
            "Tune MongoSandbox to your preferences with customizable editor fonts, tab width, query timeouts, and keyboard shortcuts."
        ),
        "highlights": [
            "F1 / Help Menu: Open this User Manual anytime",
            "Ctrl+Shift+P: Show Command Palette",
            "Ctrl+Enter: Run current query",
            "Ctrl+Shift+F: Format code document",
            "Ctrl+I: Toggle right-hand Inspector pane",
            "Ctrl+T / Ctrl+W: Open / close editor tab"
        ],
        "code": "// Keyboard Cheat Sheet\n// Run: Ctrl+Enter  ·  Palette: Ctrl+Shift+P  ·  Inspector: Ctrl+I  ·  Help: F1"
    }
]


class UserManualDialog(QDialog):
    """Interactive multi-step User Manual & User Story dialog."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("MongoSandbox — Interactive User Manual")
        self.resize(960, 620)
        self.setMinimumSize(840, 520)
        self.setModal(True)

        self._current_step = 0

        c = theme_manager.colors()

        # Overall Dialog Layout
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(16, 16, 16, 16)
        main_layout.setSpacing(12)

        # Header Title Bar
        header = QHBoxLayout()
        header_title = QLabel("📖 MongoSandbox User Manual & Feature Guide")
        header_title.setFont(QFont("Segoe UI", 13, QFont.Weight.Bold))
        header_title.setStyleSheet("color: #ffffff;")

        self._step_badge = QLabel("Step 1 of 8")
        self._step_badge.setStyleSheet("""
            background-color: #0e639c;
            color: #ffffff;
            font-size: 11px;
            font-weight: bold;
            padding: 3px 10px;
            border-radius: 10px;
        """)

        header.addWidget(header_title)
        header.addStretch()
        header.addWidget(self._step_badge)
        main_layout.addLayout(header)

        # Separator Line
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("color: #333333;")
        main_layout.addWidget(sep)

        # Content Split Layout (Left Toc List + Right Step Content)
        content_layout = QHBoxLayout()
        content_layout.setSpacing(16)

        # Left TOC Sidebar Widget
        self._toc_list = QListWidget()
        self._toc_list.setFixedWidth(240)
        self._toc_list.setStyleSheet(f"""
            QListWidget {{
                background-color: #252526;
                color: #cccccc;
                border: 1px solid #3f3f3f;
                border-radius: 6px;
                outline: none;
                padding: 4px;
            }}
            QListWidget::item {{
                height: 44px;
                padding-left: 8px;
                border-radius: 4px;
                margin-bottom: 2px;
            }}
            QListWidget::item:hover {{
                background-color: #2a2d2e;
            }}
            QListWidget::item:selected {{
                background-color: #094771;
                color: #ffffff;
                font-weight: bold;
            }}
        """)

        for step in MANUAL_STEPS:
            item = QListWidgetItem(f"{step['icon']}  {step['title'].split(':')[1].strip()}")
            self._toc_list.addItem(item)

        self._toc_list.currentRowChanged.connect(self._on_toc_selected)
        content_layout.addWidget(self._toc_list)

        # Right Stacked Widget for Step Pages
        self._stacked_widget = QStackedWidget()
        for step in MANUAL_STEPS:
            page = self._create_step_page(step)
            self._stacked_widget.addWidget(page)

        content_layout.addWidget(self._stacked_widget, stretch=1)
        main_layout.addLayout(content_layout, stretch=1)

        # Bottom Progress Bar
        self._progress_bar = QProgressBar()
        self._progress_bar.setRange(0, len(MANUAL_STEPS))
        self._progress_bar.setValue(1)
        self._progress_bar.setFixedHeight(4)
        self._progress_bar.setTextVisible(False)
        self._progress_bar.setStyleSheet("""
            QProgressBar {
                background-color: #2d2d2d;
                border: none;
                border-radius: 2px;
            }
            QProgressBar::chunk {
                background-color: #10b981;
                border-radius: 2px;
            }
        """)
        main_layout.addWidget(self._progress_bar)

        # Bottom Footer Buttons Layout
        footer = QHBoxLayout()
        footer.setSpacing(10)

        self._prev_btn = QPushButton("⬅ Previous")
        self._prev_btn.setFixedHeight(32)
        self._prev_btn.setMinimumWidth(110)
        self._prev_btn.setStyleSheet("""
            QPushButton {
                background-color: #3c3c3c;
                color: #ffffff;
                border: 1px solid #555555;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 600;
            }
            QPushButton:hover { background-color: #4a4a4a; }
            QPushButton:disabled { color: #666666; background-color: #2a2a2a; border-color: #333333; }
        """)
        self._prev_btn.clicked.connect(self.previous_step)

        self._next_btn = QPushButton("Next ➡️")
        self._next_btn.setFixedHeight(32)
        self._next_btn.setMinimumWidth(110)
        self._next_btn.setStyleSheet("""
            QPushButton {
                background-color: #0e639c;
                color: #ffffff;
                border: none;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 600;
            }
            QPushButton:hover { background-color: #1177bb; }
        """)
        self._next_btn.clicked.connect(self.next_step)

        close_btn = QPushButton("Close")
        close_btn.setFixedHeight(32)
        close_btn.setMinimumWidth(90)
        close_btn.setStyleSheet("""
            QPushButton {
                background-color: #2d2d2d;
                color: #cccccc;
                border: 1px solid #444444;
                border-radius: 4px;
                font-size: 12px;
            }
            QPushButton:hover { background-color: #3a3a3a; color: #ffffff; }
        """)
        close_btn.clicked.connect(self.accept)

        footer.addWidget(self._prev_btn)
        footer.addWidget(self._next_btn)
        footer.addStretch()
        footer.addWidget(close_btn)
        main_layout.addLayout(footer)

        # Keyboard shortcuts (Left / Right arrows)
        QShortcut(QKeySequence(Qt.Key_Left), self, self.previous_step)
        QShortcut(QKeySequence(Qt.Key_Right), self, self.next_step)

        # Select first step
        self._toc_list.setCurrentRow(0)
        self._update_navigation()

    def _create_step_page(self, step: dict) -> QWidget:
        """Create a styled page widget for a manual step."""
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(14)

        # Title Card
        title_box = QFrame()
        title_box.setStyleSheet("""
            QFrame {
                background-color: #252526;
                border: 1px solid #3c3c3c;
                border-radius: 6px;
                padding: 12px;
            }
        """)
        tb_layout = QVBoxLayout(title_box)
        tb_layout.setContentsMargins(12, 10, 12, 10)
        tb_layout.setSpacing(4)

        step_title = QLabel(f"{step['icon']}  {step['title']}")
        step_title.setFont(QFont("Segoe UI", 13, QFont.Weight.Bold))
        step_title.setStyleSheet("color: #4ec9b0;")

        step_subtitle = QLabel(step['subtitle'])
        step_subtitle.setFont(QFont("Segoe UI", 10, QFont.Weight.Bold))
        step_subtitle.setStyleSheet("color: #ce9178;")

        step_summary = QLabel(step['summary'])
        step_summary.setWordWrap(True)
        step_summary.setStyleSheet("color: #d4d4d4; font-size: 12px; line-height: 1.4;")

        tb_layout.addWidget(step_title)
        tb_layout.addWidget(step_subtitle)
        tb_layout.addWidget(step_summary)
        layout.addWidget(title_box)

        # Feature Highlights Section
        hl_label = QLabel("✨ Key Features & Instructions:")
        hl_label.setFont(QFont("Segoe UI", 11, QFont.Weight.Bold))
        hl_label.setStyleSheet("color: #569cd6;")
        layout.addWidget(hl_label)

        for hl in step['highlights']:
            item_box = QFrame()
            item_box.setStyleSheet("""
                QFrame {
                    background-color: #1e1e1e;
                    border: 1px solid #333333;
                    border-left: 3px solid #10b981;
                    border-radius: 4px;
                    padding: 6px 10px;
                }
            """)
            ib_layout = QHBoxLayout(item_box)
            ib_layout.setContentsMargins(8, 4, 8, 4)
            lbl = QLabel(f"•  {hl}")
            lbl.setWordWrap(True)
            lbl.setStyleSheet("color: #cccccc; font-size: 12px;")
            ib_layout.addWidget(lbl)
            layout.addWidget(item_box)

        # Code / Example Snippet Box
        if step.get("code"):
            code_label = QLabel("💡 Query Example / Output:")
            code_label.setFont(QFont("Segoe UI", 11, QFont.Weight.Bold))
            code_label.setStyleSheet("color: #dcdcaa;")
            layout.addWidget(code_label)

            code_box = QTextEdit()
            code_box.setReadOnly(True)
            code_box.setPlainText(step["code"])
            code_box.setFixedHeight(110)
            code_box.setFont(QFont("Consolas", 10))
            code_box.setStyleSheet("""
                QTextEdit {
                    background-color: #181818;
                    color: #9cdcfe;
                    border: 1px solid #383838;
                    border-radius: 4px;
                    padding: 8px;
                }
            """)
            layout.addWidget(code_box)

        layout.addStretch()
        scroll.setWidget(container)
        return scroll

    @Slot(int)
    def _on_toc_selected(self, row: int) -> None:
        if 0 <= row < len(MANUAL_STEPS):
            self._current_step = row
            self._stacked_widget.setCurrentIndex(row)
            self._update_navigation()

    def previous_step(self) -> None:
        if self._current_step > 0:
            self._current_step -= 1
            self._toc_list.setCurrentRow(self._current_step)
            self._stacked_widget.setCurrentIndex(self._current_step)
            self._update_navigation()

    def next_step(self) -> None:
        if self._current_step < len(MANUAL_STEPS) - 1:
            self._current_step += 1
            self._toc_list.setCurrentRow(self._current_step)
            self._stacked_widget.setCurrentIndex(self._current_step)
            self._update_navigation()
        else:
            # Reached end of steps
            self.accept()

    def _update_navigation(self) -> None:
        self._step_badge.setText(f"Step {self._current_step + 1} of {len(MANUAL_STEPS)}")
        self._progress_bar.setValue(self._current_step + 1)
        self._prev_btn.setEnabled(self._current_step > 0)

        if self._current_step == len(MANUAL_STEPS) - 1:
            self._next_btn.setText("Finish ✓")
            self._next_btn.setStyleSheet("""
                QPushButton {
                    background-color: #3a7d0a;
                    color: #ffffff;
                    border: none;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 600;
                }
                QPushButton:hover { background-color: #4a9b10; }
            """)
        else:
            self._next_btn.setText("Next ➡️")
            self._next_btn.setStyleSheet("""
                QPushButton {
                    background-color: #0e639c;
                    color: #ffffff;
                    border: none;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 600;
                }
                QPushButton:hover { background-color: #1177bb; }
            """)
