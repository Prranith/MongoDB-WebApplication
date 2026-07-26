"""
ui/editor/tab_manager.py
Multi-tab editor manager — VS Code style tabs with dedicated close buttons and clean styling.
"""

from PySide6.QtCore import Signal, Qt
from PySide6.QtWidgets import (
    QTabWidget, QWidget, QVBoxLayout, QToolButton, QMenu, QTabBar
)

from ui.editor.editor_widget import EditorWidget
from utils.logger import get_logger

log = get_logger(__name__)

DEFAULT_QUERY = '''\
// MongoSandbox — Query Editor
// Press Ctrl+Enter to run  |  Ctrl+Shift+P for commands

db.elite.aggregate([
  // Stage 1: filter paid transactions
  { $match: { status: "PAID" } },

  // Stage 2: group by provider, compute totals
  {
    $group: {
      _id: "$provider",
      total:   { $sum: "$amount" },
      count:   { $sum: 1 },
      avgAmt:  { $avg: "$amount" },
      maxAmt:  { $max: "$amount" }
    }
  },

  // Stage 3: add a computed field
  {
    $addFields: {
      avgFormatted: { $round: ["$avgAmt", 2] }
    }
  },

  // Stage 4: sort by total descending
  { $sort: { total: -1 } },

  // Stage 5: limit results
  { $limit: 10 }
])'''


class EditorTab(QWidget):
    """Container widget for a single editor tab."""

    run_requested    = Signal()
    save_requested   = Signal()
    text_changed     = Signal(str)
    format_requested = Signal()

    def __init__(self, name: str = "Untitled", parent=None) -> None:
        super().__init__(parent)
        self.name = name
        self._modified = False
        self._initialized = False

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.editor = EditorWidget(self)
        layout.addWidget(self.editor)

        self.editor.run_requested.connect(self.run_requested)
        self.editor.save_requested.connect(self.save_requested)
        self.editor.format_requested.connect(self.format_requested)
        self.editor.text_changed.connect(self._on_text_changed)

    @property
    def modified(self) -> bool:
        return self._modified

    def mark_saved(self) -> None:
        self._modified = False

    def _on_text_changed(self, text: str) -> None:
        if self._initialized:
            self._modified = True
        self.text_changed.emit(text)

    def get_text(self) -> str:
        return self.editor.get_text()

    def set_text(self, text: str, mark_clean: bool = False) -> None:
        self.editor.set_text(text)
        if mark_clean:
            self._modified = False
        self._initialized = True

    def insert_snippet(self, body: str) -> None:
        self.editor.insert_snippet(body)

    def format_document(self) -> None:
        self.editor.format_document()

    def focus(self) -> None:
        self.editor.focus()


class TabManager(QTabWidget):
    """
    Multi-document editor tab widget — VS Code style tabs.
    """

    active_tab_run_requested    = Signal()
    active_tab_save_requested   = Signal()
    tab_text_changed            = Signal(str)
    active_tab_format_requested = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("EditorTabBar")
        self.setTabsClosable(False)  # We handle close buttons explicitly via setTabButton
        self.setMovable(True)
        self.setDocumentMode(False)
        self.setUsesScrollButtons(True)
        self.setElideMode(Qt.TextElideMode.ElideRight)

        # "+" new tab button in top-right corner
        new_btn = QToolButton(self)
        new_btn.setText("+")
        new_btn.setFixedSize(28, 28)
        new_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        new_btn.setObjectName("NewTabButton")
        new_btn.setToolTip("New Query Tab (Ctrl+T)")
        new_btn.setStyleSheet("""
            QToolButton {
                background: transparent;
                color: #969696;
                border: none;
                border-radius: 4px;
                font-size: 18px;
                font-weight: bold;
                margin-right: 4px;
            }
            QToolButton:hover {
                color: #ffffff;
                background-color: #2a2d2e;
            }
        """)
        new_btn.clicked.connect(self.new_tab)
        self.setCornerWidget(new_btn, Qt.Corner.TopRightCorner)

        self.currentChanged.connect(self._on_tab_changed)

        # Context menu on tabs
        self.tabBar().setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.tabBar().customContextMenuRequested.connect(self._show_context_menu)

        # Create initial tab with default query
        self.new_tab(DEFAULT_QUERY, "Query 1", mark_clean=True)

    # ── Public API ─────────────────────────────────────────────────────────────

    def new_tab(self, content: str = "", name: str = "Untitled", mark_clean: bool = False) -> EditorTab:
        """Create and activate a new editor tab."""
        tab = EditorTab(name, self)

        tab.run_requested.connect(self.active_tab_run_requested)
        tab.save_requested.connect(self.active_tab_save_requested)
        tab.text_changed.connect(self._on_text_changed)
        tab.format_requested.connect(self.active_tab_format_requested)

        idx = self.addTab(tab, name)
        self.setCurrentIndex(idx)

        if content:
            tab.set_text(content, mark_clean=True)

        tab._initialized = True
        self._sync_all_tabs()
        tab.focus()
        log.debug("New editor tab created", name=name)
        return tab

    def current_tab(self) -> EditorTab | None:
        w = self.currentWidget()
        return w if isinstance(w, EditorTab) else None

    def current_text(self) -> str:
        tab = self.current_tab()
        return tab.get_text() if tab else ""

    def set_current_text(self, text: str) -> None:
        tab = self.current_tab()
        if tab:
            tab.set_text(text)
            tab._initialized = True

    def insert_snippet(self, body: str) -> None:
        tab = self.current_tab()
        if tab:
            tab.insert_snippet(body)

    def format_current(self) -> None:
        tab = self.current_tab()
        if tab:
            tab.format_document()

    def mark_saved(self) -> None:
        idx = self.currentIndex()
        tab = self.current_tab()
        if tab:
            tab.mark_saved()
            self._sync_all_tabs()

    def apply_settings(self) -> None:
        """Apply updated settings (font size, tab width) to all open editor tabs."""
        for i in range(self.count()):
            tab = self.widget(i)
            if isinstance(tab, EditorTab):
                tab.editor.apply_settings()

    # ── Internal ───────────────────────────────────────────────────────────────

    def _setup_tab_button(self, idx: int, tab: EditorTab) -> None:
        """Attach a dedicated VS Code-style '×' close button to the tab."""
        close_btn = QToolButton(self)
        close_btn.setText("×")
        close_btn.setFixedSize(16, 16)
        close_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        close_btn.setToolTip("Close Tab (Ctrl+W)")
        close_btn.setStyleSheet("""
            QToolButton {
                background: transparent;
                color: #858585;
                border: none;
                border-radius: 3px;
                font-size: 13px;
                font-weight: bold;
                margin-left: 2px;
                margin-right: 2px;
                padding: 0;
            }
            QToolButton:hover {
                color: #ffffff;
                background-color: rgba(255, 255, 255, 0.18);
            }
        """)
        close_btn.clicked.connect(lambda _, t=tab: self._close_tab_by_widget(t))
        self.tabBar().setTabButton(idx, QTabBar.ButtonPosition.RightSide, close_btn)

    def _sync_all_tabs(self) -> None:
        """Synchronize titles and close buttons across all tabs."""
        for i in range(self.count()):
            tab = self.widget(i)
            if isinstance(tab, EditorTab):
                dot = "● " if tab.modified else ""
                self.setTabText(i, f"{dot}{tab.name}")
                self._setup_tab_button(i, tab)

    def _on_text_changed(self, text: str) -> None:
        self._sync_all_tabs()
        self.tab_text_changed.emit(text)

    def _close_tab_by_widget(self, tab: EditorTab) -> None:
        idx = self.indexOf(tab)
        if idx >= 0:
            self._close_tab(idx)

    def _close_tab(self, idx: int) -> None:
        if self.count() == 1:
            tab = self.widget(0)
            if isinstance(tab, EditorTab):
                tab.set_text("", mark_clean=True)
                tab.name = "Untitled"
                self._sync_all_tabs()
            return
        self.removeTab(idx)
        self._sync_all_tabs()

    def _on_tab_changed(self, idx: int) -> None:
        tab = self.widget(idx)
        if isinstance(tab, EditorTab):
            self.tab_text_changed.emit(tab.get_text())

    def _show_context_menu(self, pos) -> None:
        idx = self.tabBar().tabAt(pos)
        if idx < 0:
            return
        menu = QMenu(self)
        menu.addAction("New Tab", self.new_tab)
        menu.addAction("Close Tab", lambda: self._close_tab(idx))
        menu.addAction("Close Other Tabs", lambda: self._close_others(idx))
        menu.addSeparator()
        menu.addAction("Duplicate Tab", lambda: self._duplicate_tab(idx))
        menu.exec(self.tabBar().mapToGlobal(pos))

    def _close_others(self, keep_idx: int) -> None:
        for i in range(self.count() - 1, -1, -1):
            if i != keep_idx:
                self.removeTab(i)
        self._sync_all_tabs()

    def _duplicate_tab(self, idx: int) -> None:
        tab = self.widget(idx)
        if isinstance(tab, EditorTab):
            self.new_tab(tab.get_text(), tab.name + " (copy)")
