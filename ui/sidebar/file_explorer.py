"""
ui/sidebar/file_explorer.py
VS Code-identical workspace file explorer dedicated to user query files and folders.
App source files remain hidden from the end user workspace.
"""

from pathlib import Path
from PySide6.QtCore import Qt, Signal, QByteArray
from PySide6.QtGui import QColor, QBrush, QFont, QIcon, QPixmap, QPainter
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLabel, QLineEdit, QMenu, QInputDialog, QMessageBox,
    QToolButton
)

from utils.theme import theme_manager
from utils.logger import get_logger

log = get_logger(__name__)

_TYPE_FOLDER = "folder"
_TYPE_FILE   = "file"
_IGNORE_DIRS = {".git", "__pycache__", ".venv", "venv", ".idea", ".vscode", "build", "dist"}


def _svg_to_icon(svg_str: str, color_hex: str = "#cccccc", size: int = 16) -> QIcon:
    """Render an SVG string to a high-DPI QIcon."""
    svg_colored = svg_str.replace("COLOR_PLACEHOLDER", color_hex)
    renderer = QSvgRenderer(QByteArray(svg_colored.encode("utf-8")))
    pix = QPixmap(size, size)
    pix.fill(Qt.GlobalColor.transparent)
    p = QPainter(pix)
    renderer.render(p)
    p.end()
    return QIcon(pix)


# ── SVG Vector Definitions (100% Monochrome Icons, No Emojis) ─────────────────

SVG_NEW_FILE = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M13 7h-2v2H9v2h2v2h2v-2h2V9h-2V7zM4 2h5l3 3v2h-1V5.5L8.5 3H4v10h4v1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
</svg>"""

SVG_NEW_FOLDER = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M14 6V5a1 1 0 0 0-1-1H7.41L6 2.59A1 1 0 0 0 5.29 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6v-1H2V5h11v1h1zm-1 3h-2v2H9v2h2v2h2v-2h2V9h-2z"/>
</svg>"""

SVG_REFRESH = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M13.65 2.35A7.958 7.958 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/>
</svg>"""

SVG_COLLAPSE_ALL = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M9 4H1v1h8V4zM9 7H1v1h8V7zM9 10H1v1h8v-1zM13.35 4.15L12.65 3.45 10 6.1 7.35 3.45l-.7.7L9.3 6.8l-2.65 2.65.7.7L10 7.5l2.65 2.65.7-.7L10.7 6.8l2.65-2.65z"/>
</svg>"""

SVG_FOLDER = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M7.25 4l-1.5-1.5H2a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.25z"/>
</svg>"""

SVG_PYTHON = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="#3776ab" d="M7.9 1a3.9 3.9 0 0 0-3.9 3.9v1.3h3.9v.4H2.6a2.6 2.6 0 0 0-2.6 2.6v2.6a2.6 2.6 0 0 0 2.6 2.6h1.3v-1.8a2.1 2.1 0 0 1 2.1-2.1h3.9a1.7 1.7 0 0 0 1.7-1.7V4.9A3.9 3.9 0 0 0 7.9 1zm-1.3 1.3a.7.7 0 1 1 0 1.3.7.7 0 0 1 0-1.3z"/>
<path fill="#ffd343" d="M8.1 15a3.9 3.9 0 0 0 3.9-3.9V9.8H8.1v-.4h5.3a2.6 2.6 0 0 0 2.6-2.6V4.2a2.6 2.6 0 0 0-2.6-2.6h-1.3v1.8a2.1 2.1 0 0 1-2.1 2.1H6.1a1.7 1.7 0 0 0-1.7 1.7v3.9A3.9 3.9 0 0 0 8.1 15zm1.3-1.3a.7.7 0 1 1 0-1.3.7.7 0 0 1 0 1.3z"/>
</svg>"""

SVG_MONGO = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="#47a248" d="M8 1s-4.5 4.5-4.5 8.5C3.5 12 5.5 15 8 15s4.5-3 4.5-5.5C12.5 5.5 8 1 8 1zm0 12.5c-1.5 0-2.5-1.5-2.5-3 0-2.5 2.5-6 2.5-6s2.5 3.5 2.5 6c0 1.5-1 3-2.5 3z"/>
</svg>"""

SVG_DOC = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
<path fill="COLOR_PLACEHOLDER" d="M4 2h5l3 3v9H4V2zm5 1v3h3L9 3zM5 7v1h6V7H5zm0 2v1h6V9H5zm0 2v1h4v-1H5z"/>
</svg>"""


class FileExplorer(QWidget):
    """
    VS Code-identical workspace file tree explorer for user queries.
    Focuses exclusively on user-created `.mongo` scripts, data files, and sub-folders.
    """

    file_opened = Signal(str, str)  # (path, content)

    def __init__(self, workspace_path: Path | None = None, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("FileExplorer")
        c = theme_manager.colors()

        if workspace_path is None:
            workspace_path = Path.cwd() / "queries"
        self._workspace = workspace_path
        self._workspace.mkdir(parents=True, exist_ok=True)
        self._ensure_sample_files()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Cache vector icons
        fg_sec = c.get("fg_secondary", "#969696")
        self._icon_new_file = _svg_to_icon(SVG_NEW_FILE, fg_sec)
        self._icon_new_folder = _svg_to_icon(SVG_NEW_FOLDER, fg_sec)
        self._icon_refresh = _svg_to_icon(SVG_REFRESH, fg_sec)
        self._icon_collapse = _svg_to_icon(SVG_COLLAPSE_ALL, fg_sec)
        self._icon_folder = _svg_to_icon(SVG_FOLDER, "#80a0c0")
        self._icon_python = _svg_to_icon(SVG_PYTHON)
        self._icon_mongo = _svg_to_icon(SVG_MONGO)
        self._icon_doc = _svg_to_icon(SVG_DOC, fg_sec)

        # ── Root header bar (VS Code section header) ─────────────────────────
        root_bar = QWidget()
        root_bar.setFixedHeight(28)
        root_bar.setStyleSheet(f"""
            background-color: {c.get('bg_sidebar','#252526')};
            border-bottom: 1px solid {c.get('separator','#3c3c3c')};
        """)
        rb_layout = QHBoxLayout(root_bar)
        rb_layout.setContentsMargins(10, 0, 6, 0)
        rb_layout.setSpacing(2)

        self._root_label = QLabel(f"∨  {self._workspace.name.upper()}")
        self._root_label.setStyleSheet(f"color: {c.get('fg_primary','#cccccc')}; font-size: 11px; font-weight: bold;")
        rb_layout.addWidget(self._root_label)
        rb_layout.addStretch()

        # Action buttons with vector SVG icons
        new_file_btn = self._make_tool_btn(self._icon_new_file, "New File...")
        new_file_btn.clicked.connect(self._create_new_file)
        rb_layout.addWidget(new_file_btn)

        new_folder_btn = self._make_tool_btn(self._icon_new_folder, "New Folder...")
        new_folder_btn.clicked.connect(self._create_new_folder)
        rb_layout.addWidget(new_folder_btn)

        refresh_btn = self._make_tool_btn(self._icon_refresh, "Refresh Explorer")
        refresh_btn.clicked.connect(self.refresh)
        rb_layout.addWidget(refresh_btn)

        collapse_btn = self._make_tool_btn(self._icon_collapse, "Collapse All")
        collapse_btn.clicked.connect(self._collapse_all)
        rb_layout.addWidget(collapse_btn)

        layout.addWidget(root_bar)

        # ── Tree Widget ──────────────────────────────────────────────────────
        self._tree = QTreeWidget()
        self._tree.setColumnCount(1)
        self._tree.setHeaderHidden(True)
        self._tree.setRootIsDecorated(True)
        self._tree.setAnimated(True)
        self._tree.setIndentation(12)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_context_menu)
        self._tree.itemDoubleClicked.connect(self._on_item_double_clicked)
        self._tree.setStyleSheet(f"""
            QTreeWidget {{
                background-color: {c.get('bg_sidebar','#252526')};
                color: {c.get('fg_primary','#cccccc')};
                border: none;
                font-size: 12px;
                outline: none;
            }}
            QTreeWidget::item {{
                padding: 2px 0px;
                border: none;
            }}
            QTreeWidget::item:hover {{
                background-color: {c.get('bg_hover','#2a2d2e')};
            }}
            QTreeWidget::item:selected {{
                background-color: {c.get('bg_selected','#094771')};
                color: #ffffff;
            }}
        """)
        layout.addWidget(self._tree, 1)

        # ── Collapsible Accordion Footers (> OUTLINE, > TIMELINE) ───────────
        layout.addWidget(self._make_accordion_bar("OUTLINE"))
        layout.addWidget(self._make_accordion_bar("TIMELINE"))

        self.refresh()

    def _ensure_sample_files(self) -> None:
        """Create sample query files in the user workspace if empty."""
        f1 = self._workspace / "01_find_paid.mongo"
        f1.write_text(
            "// MongoSandbox — Sample Query 1: Find Paid Transactions\n"
            "db.elite.find({\n"
            "  status: \"PAID\"\n"
            "})\n",
            encoding="utf-8"
        )

        f2 = self._workspace / "02_aggregate_pipeline.mongo"
        f2.write_text(
            "// MongoSandbox — Sample Query 2: Aggregation Pipeline\n"
            "db.elite.aggregate([\n"
            "  { $match: { status: \"PAID\" } },\n"
            "  {\n"
            "    $group: {\n"
            "      _id: \"$provider\",\n"
            "      totalAmount: { $sum: \"$amount\" },\n"
            "      transactionCount: { $sum: 1 }\n"
            "    }\n"
            "  },\n"
            "  { $sort: { totalAmount: -1 } }\n"
            "])\n",
            encoding="utf-8"
        )

    @staticmethod
    def _make_tool_btn(icon: QIcon, tooltip: str) -> QToolButton:
        c = theme_manager.colors()
        btn = QToolButton()
        btn.setIcon(icon)
        btn.setFixedSize(22, 22)
        btn.setToolTip(tooltip)
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        btn.setStyleSheet(f"""
            QToolButton {{
                background: transparent;
                border: none;
                border-radius: 3px;
            }}
            QToolButton:hover {{
                background: {c.get('bg_hover','#2a2d2e')};
            }}
        """)
        return btn

    @staticmethod
    def _make_accordion_bar(title: str) -> QWidget:
        c = theme_manager.colors()
        bar = QWidget()
        bar.setFixedHeight(24)
        bar.setStyleSheet(f"""
            background-color: {c.get('bg_sidebar','#252526')};
            border-top: 1px solid {c.get('separator','#3c3c3c')};
        """)
        l = QHBoxLayout(bar)
        l.setContentsMargins(10, 0, 8, 0)
        lbl = QLabel(f"›  {title}")
        lbl.setStyleSheet(f"color: {c.get('fg_secondary','#969696')}; font-size: 11px; font-weight: bold;")
        l.addWidget(lbl)
        l.addStretch()
        return bar

    # ── Public API ─────────────────────────────────────────────────────────────

    def refresh(self) -> None:
        """Populate file tree with user query files."""
        self._tree.clear()
        self._populate_dir(self._workspace, self._tree.invisibleRootItem())

    def _collapse_all(self) -> None:
        self._tree.collapseAll()

    def _populate_dir(self, directory: Path, parent_item: QTreeWidgetItem) -> None:
        c = theme_manager.colors()
        try:
            items = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            for p in items:
                if p.name in _IGNORE_DIRS or p.name.startswith("."):
                    continue

                if p.is_dir():
                    item = QTreeWidgetItem([f" {p.name}"])
                    item.setIcon(0, self._icon_folder)
                    item.setData(0, Qt.ItemDataRole.UserRole, _TYPE_FOLDER)
                    item.setData(0, Qt.ItemDataRole.UserRole + 1, str(p))
                    item.setForeground(0, QBrush(QColor(c.get("fg_primary", "#cccccc"))))
                    self._populate_dir(p, item)
                    parent_item.addChild(item)
                else:
                    item = QTreeWidgetItem([f" {p.name}"])
                    item.setIcon(0, self._get_file_icon(p.suffix))
                    item.setData(0, Qt.ItemDataRole.UserRole, _TYPE_FILE)
                    item.setData(0, Qt.ItemDataRole.UserRole + 1, str(p))
                    item.setForeground(0, QBrush(QColor(c.get("fg_primary", "#cccccc"))))
                    parent_item.addChild(item)
        except Exception as e:
            log.warning("Failed to populate directory", path=str(directory), error=str(e))

    def _get_file_icon(self, suffix: str) -> QIcon:
        s = suffix.lower()
        if s == ".py":
            return self._icon_python
        elif s in (".mongo", ".js", ".json"):
            return self._icon_mongo
        return self._icon_doc

    # ── Context menu & File operations ──────────────────────────────────────────

    def _show_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        target_dir = self._workspace
        target_path = None

        if item:
            item_type = item.data(0, Qt.ItemDataRole.UserRole)
            path_str  = item.data(0, Qt.ItemDataRole.UserRole + 1)
            if path_str:
                target_path = Path(path_str)
                target_dir = target_path if item_type == _TYPE_FOLDER else target_path.parent

        menu = QMenu(self)
        menu.addAction("New File...", lambda: self._create_new_file(target_dir))
        menu.addAction("New Folder...", lambda: self._create_new_folder(target_dir))
        menu.addSeparator()

        if target_path and target_path != self._workspace:
            menu.addAction("Rename...", lambda: self._rename_path(target_path))
            menu.addAction("Delete", lambda: self._delete_path(target_path))
            menu.addSeparator()

        menu.addAction("Refresh Explorer", self.refresh)
        menu.exec(self._tree.mapToGlobal(pos))

    def _create_new_file(self, target_dir: Path | None = None) -> None:
        if not isinstance(target_dir, Path):
            target_dir = self._workspace
        name, ok = QInputDialog.getText(self, "New File", "File Name (e.g. my_query.mongo):")
        if ok and name.strip():
            filepath = target_dir / name.strip()
            if not filepath.suffix:
                filepath = filepath.with_suffix(".mongo")
            filepath.write_text("// New MongoDB Query\n\n", encoding="utf-8")
            self.refresh()
            self.file_opened.emit(filepath.name, filepath.read_text(encoding="utf-8"))

    def _create_new_folder(self, target_dir: Path | None = None) -> None:
        if not isinstance(target_dir, Path):
            target_dir = self._workspace
        name, ok = QInputDialog.getText(self, "New Folder", "Folder Name:")
        if ok and name.strip():
            folderpath = target_dir / name.strip()
            folderpath.mkdir(parents=True, exist_ok=True)
            self.refresh()

    def _rename_path(self, target_path: Path) -> None:
        new_name, ok = QInputDialog.getText(self, "Rename", "New Name:", QLineEdit.EchoMode.Normal, target_path.name)
        if ok and new_name.strip() and new_name.strip() != target_path.name:
            new_path = target_path.parent / new_name.strip()
            target_path.rename(new_path)
            self.refresh()

    def _delete_path(self, target_path: Path) -> None:
        res = QMessageBox.question(self, "Confirm Delete", f"Delete '{target_path.name}'?",
                                   QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        if res == QMessageBox.StandardButton.Yes:
            if target_path.is_dir():
                import shutil
                shutil.rmtree(target_path)
            else:
                target_path.unlink()
            self.refresh()

    def _on_item_double_clicked(self, item: QTreeWidgetItem, col: int) -> None:
        item_type = item.data(0, Qt.ItemDataRole.UserRole)
        path_str  = item.data(0, Qt.ItemDataRole.UserRole + 1)
        if item_type == _TYPE_FILE and path_str:
            p = Path(path_str)
            if p.exists():
                try:
                    content = p.read_text(encoding="utf-8")
                    self.file_opened.emit(p.name, content)
                except Exception as e:
                    log.warning("Could not read file", path=path_str, error=str(e))
