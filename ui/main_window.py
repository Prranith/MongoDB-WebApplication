"""
ui/main_window.py
Root application window — Antigravity IDE style.
Layout: [ActivityBar | SidePanel | Editor+Console] + StatusBar + MenuBar
"""

import json
from pathlib import Path

from PySide6.QtCore import Qt, Slot, QTimer, QRect, Signal
from PySide6.QtGui import (
    QKeySequence, QShortcut, QFont, QBrush, QColor, QAction
)
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QSplitter,
    QLabel, QTreeWidget, QTreeWidgetItem, QMessageBox,
    QFileDialog, QApplication, QFrame, QSizePolicy, QMenuBar, QMenu,
    QPushButton, QStackedWidget
)
from bson import json_util

from ui.editor.tab_manager    import TabManager
from ui.console.console_widget import ConsoleWidget
from ui.sidebar.activity_bar   import ActivityBar
from ui.sidebar.sidebar_widget import SidebarWidget
from ui.statusbar              import StatusBar
from ui.command_palette        import CommandPalette
from ui.connect_dialog         import SettingsDialog
from ui.notifications          import NotificationManager
from ui.welcome_view           import WelcomeView

from core.database   import db_manager
from core.executor   import executor, QueryResult
from core.autocomplete import autocomplete_engine
from utils.theme     import theme_manager
from utils.config    import config
from utils.analytics import analytics_tracker
from utils.signals   import bus
from utils.helpers   import format_ms
from utils.logger    import get_logger

log = get_logger(__name__)

ELITE_JSON_PATH = Path(__file__).parent.parent.parent / "MongoApplication" / "elite.json"
_POSSIBLE_PATHS = [
    ELITE_JSON_PATH,
    Path(__file__).parent.parent / "elite.json",
    Path.cwd() / "elite.json",
    Path.home() / "Desktop" / "MongoApplication" / "elite.json",
]


# ── Inspector panel ─────────────────────────────────────────────────────────

class InspectorPanel(QWidget):
    close_requested = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("InspectorPanel")
        self.current_collection = ""
        c = theme_manager.colors()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Header Widget
        hdr = QWidget()
        hdr.setFixedHeight(35)
        hdr.setStyleSheet(
            f"background-color: {c.get('bg_panel','#252526')};"
            f"border-bottom: 1px solid {c.get('separator','#3c3c3c')};"
        )
        hdr_layout = QHBoxLayout(hdr)
        hdr_layout.setContentsMargins(12, 0, 8, 0)
        hdr_layout.setSpacing(6)
        
        lbl = QLabel("INSPECTOR")
        lbl.setObjectName("SidebarHeader")
        hdr_layout.addWidget(lbl)
        
        hdr_layout.addStretch()

        # Details button (Open schema overlay screen)
        self._overlay_btn = QPushButton("⧉ Details")
        self._overlay_btn.setEnabled(False)
        self._overlay_btn.setFixedHeight(22)
        self._overlay_btn.setToolTip("Open professional Schema Overlay")
        self._overlay_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {c.get('bg_input','#3c3c3c')};
                color: {c.get('fg_primary','#cccccc')};
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 3px;
                padding: 0 8px;
                font-size: 11px;
            }}
            QPushButton:hover {{
                background-color: {c.get('border_focus','#007acc')};
                color: white;
            }}
            QPushButton:disabled {{
                color: {c.get('fg_secondary','#666666')};
                background-color: transparent;
                border-color: transparent;
            }}
        """)
        self._overlay_btn.clicked.connect(self._open_overlay)
        hdr_layout.addWidget(self._overlay_btn)

        # Close button
        self._close_btn = QPushButton("×")
        self._close_btn.setFixedSize(18, 18)
        self._close_btn.setToolTip("Close Inspector")
        self._close_btn.setStyleSheet(f"""
            QPushButton {{
                background: transparent;
                color: {c.get('fg_secondary','#969696')};
                border: none;
                font-size: 16px;
                font-weight: bold;
            }}
            QPushButton:hover {{
                color: {c.get('fg_primary','#ffffff')};
            }}
        """)
        self._close_btn.clicked.connect(self.close_requested.emit)
        hdr_layout.addWidget(self._close_btn)
        
        layout.addWidget(hdr)

        from PySide6.QtWidgets import QHeaderView
        self._tree = QTreeWidget()
        self._tree.setColumnCount(2)
        self._tree.setHeaderLabels(["Field", "Type"])
        self._tree.setRootIsDecorated(True)
        self._tree.setIndentation(12)
        self._tree.setColumnWidth(1, 110)
        self._tree.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._tree.header().setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)
        self._tree.setStyleSheet(f"""
            QTreeWidget {{
                background-color: {c.get('bg_panel','#252526')};
                color: {c.get('fg_primary','#cccccc')};
                border: none;
                font-size: 12px;
                outline: none;
            }}
            QTreeWidget::item {{ padding: 2px 6px; }}
            QTreeWidget::item:hover {{ background-color: {c.get('bg_hover','#2a2d2e')}; }}
            QTreeWidget::item:selected {{ background-color: {c.get('bg_selected','#094771')}; }}
            QHeaderView::section {{
                background-color: {c.get('bg_sidebar','#252526')};
                color: {c.get('fg_secondary','#969696')};
                border: none;
                border-bottom: 1px solid {c.get('separator','#3c3c3c')};
                font-size: 11px;
                font-weight: bold;
                padding: 3px 6px;
            }}
        """)
        layout.addWidget(self._tree)

        self._empty = QLabel("  Select a collection\n  to see its schema")
        self._empty.setStyleSheet(
            f"color: {c.get('fg_secondary','#969696')}; font-size: 12px; padding: 12px;"
        )
        self._empty.setAlignment(Qt.AlignmentFlag.AlignTop)
        layout.addWidget(self._empty)
        self._tree.hide()

    def _open_overlay(self) -> None:
        if not self.current_collection:
            return
        try:
            from ui.schema_overlay import SchemaOverlayDialog
            dlg = SchemaOverlayDialog(self.current_collection, self.window())
            dlg.exec()
        except Exception as e:
            log.error("Failed to open schema overlay dialog", collection=self.current_collection, error=str(e))

    def display_schema(self, collection: str, schema: dict) -> None:
        self.current_collection = collection
        self._overlay_btn.setEnabled(True)
        self._empty.hide()
        self._tree.clear()
        self._tree.show()
        c = theme_manager.colors()

        root = QTreeWidgetItem([f"  {collection}", "collection"])
        root.setForeground(0, QBrush(QColor(c.get("tree_icon_coll","#4ec9b0"))))
        root.setForeground(1, QBrush(QColor(c.get("fg_secondary","#969696"))))
        root.setExpanded(True)

        # 1. Fields Section
        fields_root = QTreeWidgetItem(["📋 Fields", ""])
        fields_root.setForeground(0, QBrush(QColor(c.get("tree_icon_coll", "#4ec9b0"))))
        fields_root.setExpanded(True)
        
        for field, ftype in schema.items():
            child = QTreeWidgetItem([f"  {field}", ftype])
            child.setForeground(1, QBrush(QColor(c.get("syn_type","#4ec9b0"))))
            fields_root.addChild(child)
            
        root.addChild(fields_root)

        # 2. Relations Section
        relations_root = QTreeWidgetItem(["🔗 Relations", ""])
        relations_root.setForeground(0, QBrush(QColor(c.get("syn_operator", "#c586c0"))))
        relations_root.setExpanded(True)

        try:
            from ui.schema_overlay import COLLECTION_RELATIONS
            relations = COLLECTION_RELATIONS.get(collection, [])
            if relations:
                for rel in relations:
                    rel_child = QTreeWidgetItem([f"  {rel['field']} ➔ {rel['referenced_collection']}", rel['type']])
                    rel_child.setForeground(1, QBrush(QColor(c.get("syn_string", "#ce9178"))))
                    rel_child.setToolTip(0, rel["description"])
                    relations_root.addChild(rel_child)
            else:
                none_child = QTreeWidgetItem(["  (none)", ""])
                none_child.setForeground(0, QBrush(QColor(c.get("fg_secondary", "#969696"))))
                relations_root.addChild(none_child)
        except Exception as e:
            log.warning("Failed to load schema relations for inspector panel", error=str(e))

        root.addChild(relations_root)
        self._tree.addTopLevelItem(root)


# ── Main Window ──────────────────────────────────────────────────────────────

class MainWindow(QMainWindow):
    """Antigravity IDE-style main window."""

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("MongoSandbox — MongoDB Practice IDE")
        self.setMinimumSize(900, 600)
        self._command_palette: CommandPalette | None = None
        self._setup_menu()
        self._setup_ui()
        self._setup_connections()
        self._setup_shortcuts()
        self._auto_connect()
        log.info("MainWindow initialized")

    # ── Menu Bar ───────────────────────────────────────────────────────────────

    def _setup_menu(self) -> None:
        mb = self.menuBar()
        mb.setObjectName("AppMenuBar")

        # File
        file_menu = mb.addMenu("File")
        file_menu.addAction("New Tab",          self._new_tab,         "Ctrl+T")
        file_menu.addAction("Close Tab",        self._close_current_tab, "Ctrl+W")
        file_menu.addSeparator()
        file_menu.addAction("Save Query",       self._save_query,      "Ctrl+S")
        file_menu.addAction("Load Dataset…",    self._load_dataset)
        file_menu.addSeparator()
        file_menu.addAction("Exit",             self.close,            "Alt+F4")

        # Edit
        edit_menu = mb.addMenu("Edit")
        edit_menu.addAction("Run Query",        self._run_query,       "Ctrl+Return")
        edit_menu.addAction("Format Document",  self._format_query,    "Ctrl+Shift+F")
        edit_menu.addSeparator()
        edit_menu.addAction("Duplicate Line",   self._noop,            "Ctrl+D")
        edit_menu.addAction("Delete Line",      self._noop,            "Ctrl+Shift+K")
        edit_menu.addAction("Toggle Comment",   self._noop,            "Ctrl+/")

        # View
        view_menu = mb.addMenu("View")
        view_menu.addAction("Command Palette…", self._show_command_palette, "Ctrl+Shift+P")
        view_menu.addAction("Intro Page / Dashboard", self._show_welcome_view)
        view_menu.addSeparator()
        view_menu.addAction("Toggle Sidebar",   self._toggle_sidebar)
        view_menu.addAction("Toggle Console",   self._toggle_console)
        view_menu.addAction("Toggle Inspector", self._toggle_inspector, "Ctrl+I")

        # Run
        run_menu = mb.addMenu("Run")
        run_menu.addAction("Run Query",         self._run_query,       "Ctrl+Return")
        run_menu.addAction("Clear Console",     self._clear_console)
        run_menu.addSeparator()
        run_menu.addAction("Load Dataset",      self._load_dataset)
        run_menu.addAction("Refresh Database",  self._refresh_db)

        # Terminal
        terminal_menu = mb.addMenu("Terminal")
        terminal_menu.addAction("Clear Output", self._clear_console)

        # Help
        help_menu = mb.addMenu("Help")
        help_menu.addAction("Intro Page",       self._show_welcome_view)
        help_menu.addAction("User Manual…",     self._show_user_manual, "F1")
        help_menu.addAction("About MongoSandbox", self._show_about)
        help_menu.addAction("Settings…",        self._show_settings)

    # ── UI Layout ──────────────────────────────────────────────────────────────

    def _setup_ui(self) -> None:
        c = theme_manager.colors()

        # Restore window size
        w = config.get("window_width", 1440)
        h = config.get("window_height", 900)

        # Ensure we don't go larger than available screen
        screen = QApplication.primaryScreen()
        if screen:
            avail = screen.availableGeometry()
            w = min(w, avail.width())
            h = min(h, avail.height())
        self.resize(w, h)

        # ── Central widget ─────────────────────────────────────────────────────
        central = QWidget()
        central.setObjectName("CentralWidget")
        self.setCentralWidget(central)

        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # 1. Activity bar (far left, 48px)
        self._activity_bar = ActivityBar(self)
        self._activity_bar.panel_toggled.connect(self._on_panel_toggled)
        self._activity_bar.settings_btn.clicked.connect(self._show_settings)
        root.addWidget(self._activity_bar)

        # Thin separator
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedWidth(1)
        sep.setStyleSheet(f"background-color: {c.get('separator','#3c3c3c')}; border: none;")
        root.addWidget(sep)

        # 2. Horizontal splitter: sidebar | editor+inspector+console
        self._h_splitter = QSplitter(Qt.Orientation.Horizontal)
        self._h_splitter.setHandleWidth(1)
        self._h_splitter.setChildrenCollapsible(False)
        self._h_splitter.setStyleSheet(f"""
            QSplitter::handle {{
                background-color: {c.get('separator','#3c3c3c')};
            }}
            QSplitter::handle:hover {{
                background-color: {c.get('border_focus','#007acc')};
            }}
        """)

        # Sidebar panel (File Explorer / DB Explorer / History / Snippets)
        self._sidebar = SidebarWidget(self)
        self._sidebar.file_opened.connect(lambda name, content: self._tab_manager.new_tab(content, name, mark_clean=True))
        self._sidebar.collection_clicked.connect(self._on_collection_clicked)
        self._sidebar.schema_loaded.connect(self._on_schema_loaded)
        self._sidebar.history_selected.connect(self._load_from_history)
        self._sidebar.snippet_selected.connect(self._insert_snippet)
        self._sidebar.closed.connect(self._activity_bar.uncheck_all)
        self._h_splitter.addWidget(self._sidebar)

        # Right area: vertical splitter (editor | console)
        self._right_area = QWidget()
        right_layout = QVBoxLayout(self._right_area)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)

        # Run bar (slim bar below tabs with Run button + path breadcrumb)
        self._run_bar = self._build_run_bar(c)
        right_layout.addWidget(self._run_bar)

        # Vertical splitter: editor | console
        self._v_splitter = QSplitter(Qt.Orientation.Vertical)
        self._v_splitter.setHandleWidth(4)
        self._v_splitter.setChildrenCollapsible(False)
        self._v_splitter.setStyleSheet(f"""
            QSplitter::handle {{
                background-color: {c.get('bg_toolbar','#2d2d2d')};
                border-top: 1px solid {c.get('separator','#3c3c3c')};
                border-bottom: 1px solid {c.get('separator','#3c3c3c')};
            }}
            QSplitter::handle:hover {{
                background-color: {c.get('border_focus','#007acc')};
            }}
        """)

        self._tab_manager = TabManager(self)
        self._v_splitter.addWidget(self._tab_manager)

        self._console = ConsoleWidget(self)
        self._v_splitter.addWidget(self._console)

        self._v_splitter.setSizes([580, 220])
        self._v_splitter.setStretchFactor(0, 3)
        self._v_splitter.setStretchFactor(1, 1)

        right_layout.addWidget(self._v_splitter, 1)
        self._h_splitter.addWidget(self._right_area)

        # Inspector panel (right)
        self._inspector = InspectorPanel(self)
        self._inspector.close_requested.connect(self._toggle_inspector)
        self._inspector.setMinimumWidth(160)
        self._inspector.setMaximumWidth(400)
        self._h_splitter.addWidget(self._inspector)

        self._h_splitter.setSizes([240, 680, 220])
        self._h_splitter.setStretchFactor(0, 0)
        self._h_splitter.setStretchFactor(1, 1)
        self._h_splitter.setStretchFactor(2, 0)

        root.addWidget(self._h_splitter, 1)

        # Stacked view container to switch between Welcome Intro Page & Main IDE Workspace
        self._view_stack = QStackedWidget()
        self._welcome_view = WelcomeView(self)
        self._welcome_view.enter_ide_requested.connect(self._show_ide_view)

        self._view_stack.addWidget(self._welcome_view) # Index 0: Intro Page
        self._view_stack.addWidget(self._h_splitter)   # Index 1: IDE Workspace

        root.removeWidget(self._h_splitter)
        root.addWidget(self._view_stack, 1)

        # Record app launch in analytics
        analytics_tracker.record_app_launch()

        if config.get("show_welcome_on_startup", True):
            self._show_welcome_view()
        else:
            self._show_ide_view()

        # Status bar
        self._statusbar = StatusBar(self)
        self.setStatusBar(self._statusbar)

    def _build_run_bar(self, c: dict) -> QWidget:
        """Slim bar between tabs and editor for the Run button."""
        bar = QWidget()
        bar.setObjectName("RunBar")
        bar.setFixedHeight(34)
        bar.setStyleSheet(f"""
            #RunBar {{
                background-color: {c.get('bg_toolbar','#2d2d2d')};
                border-bottom: 1px solid {c.get('separator','#3c3c3c')};
            }}
        """)
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(8, 0, 8, 0)
        layout.setSpacing(8)

        # Run button (green, prominent)
        self._run_btn = self._make_btn("▶  Run", "#3a7d0a", "#4a9b10", bold=True)
        self._run_btn.setToolTip("Run Query  (Ctrl+Enter)")
        self._run_btn.clicked.connect(self._run_query)
        self._run_btn.setFixedWidth(90)
        layout.addWidget(self._run_btn)

        # Thin separator
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(16)
        sep.setStyleSheet(f"background: {c.get('separator','#3c3c3c')}; border: none;")
        layout.addWidget(sep)

        # Format button
        fmt_btn = self._make_btn("Format", c.get("bg_input","#3c3c3c"), c.get("bg_hover","#2a2d2e"))
        fmt_btn.setToolTip("Format  Ctrl+Shift+F")
        fmt_btn.clicked.connect(self._format_query)
        layout.addWidget(fmt_btn)

        # Save button
        save_btn = self._make_btn("Save", c.get("bg_input","#3c3c3c"), c.get("bg_hover","#2a2d2e"))
        save_btn.setToolTip("Save  Ctrl+S")
        save_btn.clicked.connect(self._save_query)
        layout.addWidget(save_btn)

        # Intro Page button
        intro_btn = self._make_btn("🏠 Intro Page", c.get("bg_input","#3c3c3c"), c.get("bg_hover","#2a2d2e"))
        intro_btn.setToolTip("Show Welcome & Usage Analytics Dashboard")
        intro_btn.clicked.connect(self._show_welcome_view)
        layout.addWidget(intro_btn)

        layout.addStretch()

        # Toggle Inspector button
        self._toggle_inspector_btn = self._make_btn("⧉ Inspector", c.get("bg_input","#3c3c3c"), c.get("bg_hover","#2a2d2e"))
        self._toggle_inspector_btn.setToolTip("Toggle Inspector Panel  (Ctrl+I)")
        self._toggle_inspector_btn.clicked.connect(self._toggle_inspector)
        layout.addWidget(self._toggle_inspector_btn)

        # DB connection indicator
        self._db_indicator = QLabel("○  Disconnected")
        self._db_indicator.setObjectName("DBIndicator")
        self._db_indicator.setStyleSheet(
            f"color: {c.get('console_warn','#ff9800')}; font-size: 12px; padding-right: 8px;"
        )
        layout.addWidget(self._db_indicator)

        return bar

    @staticmethod
    def _make_btn(text: str, bg: str, hover: str, bold: bool = False) -> QLabel:
        from PySide6.QtWidgets import QPushButton
        btn = QPushButton(text)
        btn.setFixedHeight(26)
        weight = "bold" if bold else "normal"
        bg_col = bg if bg.startswith("#") else "#3c3c3c"
        btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {bg_col};
                color: #cccccc;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 4px;
                padding: 0 12px;
                font-size: 12px;
                font-weight: {weight};
            }}
            QPushButton:hover {{
                background-color: {hover};
                border-color: rgba(255,255,255,0.2);
            }}
            QPushButton:pressed {{
                background-color: rgba(0,0,0,0.2);
            }}
        """)
        return btn

    # ── Signal connections ─────────────────────────────────────────────────────

    def _setup_connections(self) -> None:
        self._tab_manager.active_tab_run_requested.connect(self._run_query)
        self._tab_manager.active_tab_save_requested.connect(self._save_query)
        self._tab_manager.active_tab_format_requested.connect(self._format_query)

        executor.result_ready.connect(self._on_result)
        executor.execution_started.connect(lambda _: self._set_running(True))

        bus.db_connected.connect(self._on_db_connected)
        bus.db_disconnected.connect(self._on_db_disconnected)
        bus.notification_show.connect(
            lambda t, m: NotificationManager.show(t, m, parent=self)
        )

    def _setup_shortcuts(self) -> None:
        QShortcut(QKeySequence("Ctrl+Shift+P"), self).activated.connect(
            self._show_command_palette
        )
        QShortcut(QKeySequence("Ctrl+T"), self).activated.connect(self._new_tab)
        QShortcut(QKeySequence("Ctrl+W"), self).activated.connect(
            self._close_current_tab
        )
        QShortcut(QKeySequence("Ctrl+I"), self).activated.connect(
            self._toggle_inspector
        )
        QShortcut(QKeySequence("F1"), self).activated.connect(
            self._show_user_manual
        )

    # ── Activity Bar / Panel ───────────────────────────────────────────────────

    @Slot(str, bool)
    def _on_panel_toggled(self, key: str, is_active: bool) -> None:
        if key == "welcome":
            if is_active:
                self._show_welcome_view()
            else:
                self._show_ide_view()
            return

        if is_active:
            self._show_ide_view()
            self._sidebar.switch_to(key)
            if not self._sidebar.isVisible():
                self._sidebar.show()
            sizes = self._h_splitter.sizes()
            if sizes[0] < 100:
                self._h_splitter.setSizes([240, sizes[1], sizes[2]])
        else:
            self._sidebar.hide()

    def _show_welcome_view(self) -> None:
        self._welcome_view.refresh_stats()
        self._view_stack.setCurrentIndex(0)
        self._activity_bar.set_active("welcome")

    def _show_ide_view(self) -> None:
        self._view_stack.setCurrentIndex(1)
        if self._activity_bar.active_key == "welcome":
            self._activity_bar.set_active("files")

    def _inspect_collection_profile(self, collection_name: str) -> None:
        self._show_ide_view()
        self._on_collection_clicked(collection_name)
        if not self._inspector.isVisible():
            self._toggle_inspector()

    def _toggle_sidebar(self) -> None:
        if self._sidebar.isVisible():
            self._sidebar.hide()
            self._activity_bar.uncheck_all()
        else:
            key = self._activity_bar.active_key or "db"
            self._activity_bar.set_active(key)
            self._sidebar.switch_to(key)
            self._sidebar.show()
            sizes = self._h_splitter.sizes()
            if sizes[0] < 100:
                self._h_splitter.setSizes([240, sizes[1], sizes[2]])

    def _toggle_console(self) -> None:
        self._console.setVisible(not self._console.isVisible())

    def _toggle_inspector(self) -> None:
        visible = not self._inspector.isVisible()
        self._inspector.setVisible(visible)
        if visible:
            # Restore splitter sizes to keep the Inspector visible
            sizes = self._h_splitter.sizes()
            total_w = sum(sizes)
            sidebar_w = sizes[0] if sizes[0] > 50 else 240
            inspector_w = 220
            editor_w = total_w - sidebar_w - inspector_w
            self._h_splitter.setSizes([sidebar_w, editor_w, inspector_w])

    # ── Query execution ────────────────────────────────────────────────────────

    @Slot()
    def _run_query(self) -> None:
        raw = self._tab_manager.current_text().strip()
        if not raw:
            NotificationManager.show("Empty Query", "Write a MongoDB query first.", "warn", parent=self)
            return
        analytics_tracker.record_query_executed()
        executor.execute_async(raw, timeout_s=config.get("query_timeout_s", 30))

    @Slot(object)
    def _on_result(self, result: QueryResult) -> None:
        self._set_running(False)
        self._console.display_result(result)
        self._sidebar.on_query_executed(result)
        bus.query_executed.emit(result)

        if result.status == "ok":
            NotificationManager.show(
                "Query Complete",
                f"{result.docs_returned:,} docs  ·  {result.timing_ms:.1f} ms",
                "success", parent=self,
            )
        elif result.status == "error":
            NotificationManager.show("Error", result.error[:90], "error", 5000, parent=self)

    def _set_running(self, running: bool) -> None:
        if running:
            self._run_btn.setText("⏹  Stop")
            self._run_btn.setStyleSheet(self._run_btn.styleSheet().replace("#3a7d0a", "#a32929"))
        else:
            self._run_btn.setText("▶  Run")
            self._run_btn.setStyleSheet(self._run_btn.styleSheet().replace("#a32929", "#3a7d0a"))

    # ── Sidebar events ─────────────────────────────────────────────────────────

    @Slot(str)
    def _on_collection_clicked(self, name: str) -> None:
        bus.collection_selected.emit(name)

    @Slot(str, dict)
    def _on_schema_loaded(self, collection: str, schema: dict) -> None:
        self._inspector.display_schema(collection, schema)
        autocomplete_engine.update_schema(list(schema.keys()))

    @Slot(str)
    def _load_from_history(self, query: str) -> None:
        self._tab_manager.set_current_text(query)

    @Slot(str)
    def _insert_snippet(self, body: str) -> None:
        self._tab_manager.insert_snippet(body)

    # ── DB connection ──────────────────────────────────────────────────────────

    @Slot(str, str)
    def _on_db_connected(self, uri: str, db: str) -> None:
        self._db_indicator.setText(f"●  {db or 'practice_db'}")
        self._db_indicator.setStyleSheet(
            "color: #4ec94e; font-size: 12px; padding-right: 8px;"
        )

    @Slot()
    def _on_db_disconnected(self) -> None:
        self._db_indicator.setText("●  practice_db")
        self._db_indicator.setStyleSheet(
            "color: #4ec94e; font-size: 12px; padding-right: 8px;"
        )

    def _auto_connect(self) -> None:
        db_name = config.get("default_db", "practice_db")
        db_manager.connect("", db_name, timeout_ms=0)
        bus.db_connected.emit("", db_name)
        self._console.log(f"Sandbox engine active ({db_name})", "success")
        QTimer.singleShot(600, self._sidebar.refresh_db)

    # ── Menu actions ───────────────────────────────────────────────────────────

    def _new_tab(self) -> None:
        self._tab_manager.new_tab()

    def _close_current_tab(self) -> None:
        self._tab_manager._close_tab(self._tab_manager.currentIndex())

    def _format_query(self) -> None:
        self._tab_manager.format_current()

    def _save_query(self) -> None:
        text = self._tab_manager.current_text()
        path, _ = QFileDialog.getSaveFileName(
            self, "Save Query", "",
            "MongoDB Query (*.mongo);;Text (*.txt);;All (*.*)"
        )
        if path:
            Path(path).write_text(text, encoding="utf-8")
            self._tab_manager.mark_saved()
            NotificationManager.show("Saved", Path(path).name, "success", parent=self)

    def _load_dataset(self) -> None:
        if not db_manager.is_connected():
            QMessageBox.warning(self, "Not Connected", "Connect to MongoDB first.")
            return
        found = next((p for p in _POSSIBLE_PATHS if p.exists()), None)
        if not found:
            p, _ = QFileDialog.getOpenFileName(self, "Locate elite.json", "", "JSON (*.json)")
            if not p:
                return
            found = Path(p)
        try:
            data = json_util.loads(found.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data = [data]
            coll = db_manager.get_collection(config.get("default_collection", "elite_data"))
            if coll is not None:
                coll.drop()
                if data:
                    coll.insert_many(data)
                count = coll.count_documents({})
                self._console.log(f"Loaded {count:,} documents", "success")
                NotificationManager.show("Dataset Loaded", f"{count:,} docs", "success", parent=self)
                self._sidebar.refresh_db()
        except Exception as e:
            QMessageBox.critical(self, "Load Error", str(e))

    def _refresh_db(self) -> None:
        self._sidebar.refresh_db()

    def _clear_console(self) -> None:
        self._console.clear()

    def _show_command_palette(self) -> None:
        if self._command_palette is None:
            self._command_palette = CommandPalette(self)
            self._command_palette.command_selected.connect(self._execute_command)
        self._command_palette.show_centered(self)

    def _execute_command(self, cmd_id: str) -> None:
        dispatch = {
            "run":          self._run_query,
            "format":       self._format_query,
            "save":         self._save_query,
            "new_tab":      self._new_tab,
            "close_tab":    self._close_current_tab,
            "load_dataset": self._load_dataset,
            "settings":         self._show_settings,
            "show_welcome":     self._show_welcome_view,
            "show_user_manual": self._show_user_manual,
            "clear_console":    self._clear_console,
            "refresh_db":   self._refresh_db,
        }
        fn = dispatch.get(cmd_id)
        if fn:
            fn()

    def _show_user_manual(self) -> None:
        try:
            from ui.user_manual_dialog import UserManualDialog
            dlg = UserManualDialog(self)
            dlg.exec()
        except Exception as e:
            log.error("Failed to open User Manual dialog", error=str(e))

    def _show_settings(self) -> None:
        dlg = SettingsDialog(self)
        if dlg.exec():
            self._tab_manager.apply_settings()
            NotificationManager.show("Settings Saved", "Editor font, tab width, and query settings updated.", "success", parent=self)

    def _show_about(self) -> None:
        QMessageBox.about(
            self, "About MongoSandbox",
            "MongoSandbox — MongoDB Practice IDE\n"
            "Version 1.0.0\n\n"
            "The LeetCode of MongoDB. Practice queries,\n"
            "explore data, and master aggregation pipelines."
        )

    @staticmethod
    def _noop() -> None:
        pass

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def closeEvent(self, event) -> None:
        config.update({
            "window_width":  self.width(),
            "window_height": self.height(),
        })
        if db_manager.is_connected():
            db_manager.disconnect()
        event.accept()
