"""
ui/editor/editor_widget.py
VS Code / Antigravity IDE-style professional code editor.

Features:
- Cascadia Code / Consolas monospace font
- Full MongoDB+Python syntax highlighting (VS Code color-accurate)
- Line number gutter with right-aligned numbers
- Current-line highlight stripe
- Indentation guide lines
- Smart bracket/quote completion
- Smart Enter (auto-indent)
- Tab → spaces, Shift+Tab → un-indent
"""

import re
from PySide6.QtCore import Qt, Signal, QTimer, QRect, QSize, QPoint
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QPlainTextEdit, QTextEdit, QFrame
)
from PySide6.QtGui import (
    QColor, QFont, QFontMetrics, QKeySequence, QTextCharFormat,
    QSyntaxHighlighter, QTextDocument, QPalette, QPainter, QPen,
    QBrush, QTextCursor, QShortcut
)

from utils.theme import theme_manager
from utils.config import config
from utils.logger import get_logger

log = get_logger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Syntax Highlighter (VS Code Dark+ colour-accurate)
# ─────────────────────────────────────────────────────────────────────────────

class MongoHighlighter(QSyntaxHighlighter):
    """
    Full syntax highlighter for MongoDB Shell / PyMongo style queries.
    Colour values match VS Code Dark+ exactly.
    """

    def __init__(self, doc: QTextDocument, colors: dict) -> None:
        super().__init__(doc)
        self._rules: list[tuple[re.Pattern, QTextCharFormat]] = []
        self._build(colors)

    # ── Format helpers ─────────────────────────────────────────────────────────

    @staticmethod
    def _fmt(color: str, bold: bool = False, italic: bool = False,
             underline: bool = False) -> QTextCharFormat:
        f = QTextCharFormat()
        f.setForeground(QColor(color))
        if bold:
            f.setFontWeight(QFont.Weight.Bold)
        if italic:
            f.setFontItalic(True)
        if underline:
            f.setFontUnderline(True)
        return f

    def _build(self, c: dict) -> None:
        # The order matters — later rules override earlier ones for the
        # same character range only if we use setFormat correctly.
        # We apply longest-match first (strings > operators > keywords).

        kw_blue    = c.get("syn_keyword",   "#569cd6")   # from, import, def, return …
        str_orange = c.get("syn_string",    "#ce9178")   # "strings"  'strings'
        num_green  = c.get("syn_number",    "#b5cea8")   # 123  3.14
        cmt_green  = c.get("syn_comment",   "#6a9955")   # // comments
        fn_yellow  = c.get("syn_function",  "#dcdcaa")   # function names after def / .
        op_pink    = c.get("syn_operator",  "#c586c0")   # $match, $group, pipeline ops
        type_cyan  = c.get("syn_type",      "#4ec9b0")   # ObjectId, ISODate, types
        var_blue2  = c.get("syn_variable",  "#9cdcfe")   # local variable references
        op2_cyan   = "#56b6c2"                            # arithmetic / assignment ops
        prop_lbl   = "#9cdcfe"                            # object keys / field names

        self._rules = [
            # ── Block strings (triple-quoted) — must come first ───────────────
            (re.compile(r'""".*?"""', re.DOTALL),
             self._fmt(cmt_green, italic=True)),
            (re.compile(r"'''.*?'''", re.DOTALL),
             self._fmt(cmt_green, italic=True)),

            # ── Single-line comment: // ───────────────────────────────────────
            (re.compile(r"//[^\n]*"),
             self._fmt(cmt_green, italic=True)),

            # ── Double-quoted strings ─────────────────────────────────────────
            (re.compile(r'"(?:\\.|[^"\\])*"'),
             self._fmt(str_orange)),

            # ── Single-quoted strings ─────────────────────────────────────────
            (re.compile(r"'(?:\\.|[^'\\])*'"),
             self._fmt(str_orange)),

            # ── BSON / PyMongo type constructors ─────────────────────────────
            (re.compile(
                r"\b(ObjectId|ISODate|NumberInt|NumberLong|NumberDecimal"
                r"|BinData|Timestamp|MinKey|MaxKey|UUID|datetime|Decimal128)\b"),
             self._fmt(type_cyan)),

            # ── Python keywords ───────────────────────────────────────────────
            (re.compile(
                r"\b(from|import|def|class|return|if|else|elif|for|while|in"
                r"|not|and|or|is|None|True|False|lambda|with|as|try|except"
                r"|finally|raise|pass|break|continue|yield|async|await"
                r"|global|nonlocal|del|assert|print|len|range|type|isinstance"
                r"|str|int|float|bool|list|dict|tuple|set)\b"),
             self._fmt(kw_blue)),

            # ── MongoDB shell reserved words ──────────────────────────────────
            (re.compile(r"\b(db|null|true|false|new)\b"),
             self._fmt(kw_blue)),

            # ── $ pipeline / query operators ──────────────────────────────────
            (re.compile(r"\$[a-zA-Z_]\w*"),
             self._fmt(op_pink)),

            # ── Method names (after dot) ──────────────────────────────────────
            (re.compile(
                r"(?<=\.)(find|findOne|aggregate|insertOne|insertMany"
                r"|updateOne|updateMany|deleteOne|deleteMany|replaceOne"
                r"|countDocuments|estimatedDocumentCount|distinct"
                r"|createIndex|dropIndex|drop|sort|limit|skip|watch"
                r"|bulkWrite|explain)\b"),
             self._fmt(fn_yellow)),

            # ── Function definition name ──────────────────────────────────────
            (re.compile(r"(?<=def )[A-Za-z_]\w*"),
             self._fmt(fn_yellow)),

            # ── Decorator ────────────────────────────────────────────────────
            (re.compile(r"@[A-Za-z_]\w*"),
             self._fmt(op_pink, italic=True)),

            # ── Numbers ───────────────────────────────────────────────────────
            (re.compile(r"\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b"),
             self._fmt(num_green)),

            # ── Arithmetic / comparison operators ─────────────────────────────
            (re.compile(r"[+\-*/%=<>!&|^~]+"),
             self._fmt(op2_cyan)),
        ]

    def highlightBlock(self, text: str) -> None:
        for pattern, fmt in self._rules:
            for m in pattern.finditer(text):
                self.setFormat(m.start(), m.end() - m.start(), fmt)


# ─────────────────────────────────────────────────────────────────────────────
# Line Number Gutter
# ─────────────────────────────────────────────────────────────────────────────

class _Gutter(QWidget):
    """Renders line numbers to the left of the editor."""

    def __init__(self, editor: "CodeEditor") -> None:
        super().__init__(editor)
        self._editor = editor

    def sizeHint(self) -> QSize:
        return QSize(self._editor.gutter_width(), 0)

    def paintEvent(self, event) -> None:   # noqa: N802
        self._editor.paint_gutter(event)


# ─────────────────────────────────────────────────────────────────────────────
# Core Code Editor
# ─────────────────────────────────────────────────────────────────────────────

# VS Code Dark+ exact palette
_DARK_PLUS = {
    "editor_bg":       "#1e1e1e",
    "gutter_bg":       "#1e1e1e",
    "gutter_fg":       "#858585",
    "gutter_fg_active":"#c6c6c6",
    "gutter_border":   "#333333",
    "line_highlight":  "#282828",
    "selection_bg":    "#264f78",
    "indent_guide":    "#404040",
    "cursor_color":    "#aeafad",
    "fg":              "#d4d4d4",
    "scrollbar_bg":    "#1e1e1e",
    "scrollbar_fg":    "#424242",
}


class CodeEditor(QPlainTextEdit):
    """
    VS Code-style code editor:
    - Cascadia Code font (falls back to Consolas → Courier New)
    - Line number gutter (right-aligned, VS Code look)
    - Current-line highlight stripe
    - Indentation guide lines
    - Smart bracket/quote completion
    - Auto-indent on Enter
    - Tab → 2 spaces, Shift+Tab → de-indent
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._p = _DARK_PLUS.copy()
        # Override with theme colors if available
        c = theme_manager.colors()
        if c:
            overrides = {
                "editor_bg":       c.get("bg_editor",       self._p["editor_bg"]),
                "gutter_bg":       c.get("gutter_bg",       self._p["gutter_bg"]),
                "gutter_fg":       c.get("gutter_fg",       self._p["gutter_fg"]),
                "gutter_fg_active":c.get("gutter_active_fg",self._p["gutter_fg_active"]),
                "line_highlight":  c.get("line_highlight",  self._p["line_highlight"]),
                "selection_bg":    c.get("selection_bg",    self._p["selection_bg"]),
                "fg":              c.get("fg_primary",      self._p["fg"]),
            }
            self._p.update(overrides)

        self._setup_font()
        self._setup_palette()
        self._setup_style()

        # Gutter
        self._gutter = _Gutter(self)
        self.blockCountChanged.connect(self._update_gutter_width)
        self.updateRequest.connect(self._update_gutter_area)
        self.cursorPositionChanged.connect(self._on_cursor_moved)
        self._update_gutter_width()

        # Syntax highlighting
        self._highlighter = MongoHighlighter(self.document(), theme_manager.colors())

        # Shortcuts for Zoom In / Zoom Out
        zoom_in_sc = QShortcut(QKeySequence("Ctrl++"), self)
        zoom_in_sc.activated.connect(self._zoom_in)
        zoom_in_eq = QShortcut(QKeySequence("Ctrl+="), self)
        zoom_in_eq.activated.connect(self._zoom_in)
        zoom_out_sc = QShortcut(QKeySequence("Ctrl+-"), self)
        zoom_out_sc.activated.connect(self._zoom_out)

        self._on_cursor_moved()

    def _zoom_in(self) -> None:
        curr = config.get("font_size", 13)
        if curr < 36:
            config.set("font_size", curr + 1)
            self.apply_settings()

    def _zoom_out(self) -> None:
        curr = config.get("font_size", 13)
        if curr > 8:
            config.set("font_size", curr - 1)
            self.apply_settings()

    # ── Font setup ─────────────────────────────────────────────────────────────

    def _setup_font(self) -> None:
        preferred = ["Cascadia Code", "Consolas", "Fira Code", "JetBrains Mono", "Courier New"]
        from PySide6.QtGui import QFontDatabase
        available = set(QFontDatabase.families())
        default_family = next((f for f in preferred if f in available), "Courier New")

        family = config.get("font_family", default_family)
        size = config.get("font_size", 13)
        tab_w = config.get("tab_width", 2)

        font = QFont(family, size)
        font.setStyleHint(QFont.StyleHint.Monospace)
        font.setFixedPitch(True)
        font.setPointSizeF(float(size))
        self.setFont(font)

        fm = QFontMetrics(font)
        self.setTabStopDistance(fm.horizontalAdvance(" ") * max(1, tab_w))

    def apply_settings(self) -> None:
        """Dynamically apply updated font size, font family, and tab width from config."""
        self._setup_font()
        self._setup_style()
        self._update_gutter_width()
        self.viewport().update()

    # ── Palette / stylesheet ───────────────────────────────────────────────────

    def _setup_palette(self) -> None:
        pal = self.palette()
        pal.setColor(QPalette.ColorRole.Base, QColor(self._p["editor_bg"]))
        pal.setColor(QPalette.ColorRole.Text, QColor(self._p["fg"]))
        pal.setColor(QPalette.ColorRole.Highlight, QColor(self._p["selection_bg"]))
        pal.setColor(QPalette.ColorRole.HighlightedText, QColor(self._p["fg"]))
        pal.setColor(QPalette.ColorRole.Window, QColor(self._p["editor_bg"]))
        self.setPalette(pal)

    def _setup_style(self) -> None:
        p = self._p
        family = config.get("font_family", "Cascadia Code")
        size = config.get("font_size", 13)

        self.setStyleSheet(f"""
            QPlainTextEdit {{
                background-color: {p['editor_bg']};
                color: {p['fg']};
                font-family: '{family}', 'Cascadia Code', 'Consolas', monospace;
                font-size: {size}pt;
                border: none;
                selection-background-color: {p['selection_bg']};
                padding: 0;
            }}
            QScrollBar:vertical {{
                background: {p['scrollbar_bg']};
                width: 12px;
                border: none;
            }}
            QScrollBar::handle:vertical {{
                background: {p['scrollbar_fg']};
                min-height: 24px;
                border-radius: 6px;
                margin: 2px 2px 2px 2px;
            }}
            QScrollBar::handle:vertical:hover {{
                background: #686868;
            }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
                height: 0; background: none;
            }}
            QScrollBar:horizontal {{
                background: {p['scrollbar_bg']};
                height: 12px;
                border: none;
            }}
            QScrollBar::handle:horizontal {{
                background: {p['scrollbar_fg']};
                min-width: 24px;
                border-radius: 6px;
                margin: 2px;
            }}
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
                width: 0; background: none;
            }}
        """)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)

    # ── Gutter (line numbers) ──────────────────────────────────────────────────

    def gutter_width(self) -> int:
        """Calculate gutter width based on number of digits in line count."""
        digits = max(3, len(str(self.blockCount())))
        fm = self.fontMetrics()
        return fm.horizontalAdvance("9") * digits + 28  # 14px left + 14px right padding

    def _update_gutter_width(self) -> None:
        self.setViewportMargins(self.gutter_width(), 0, 0, 0)

    def _update_gutter_area(self, rect: QRect, dy: int) -> None:
        if dy:
            self._gutter.scroll(0, dy)
        else:
            self._gutter.update(0, rect.y(), self._gutter.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self._update_gutter_width()

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        cr = self.contentsRect()
        self._gutter.setGeometry(
            QRect(cr.left(), cr.top(), self.gutter_width(), cr.height())
        )

    def paint_gutter(self, event) -> None:
        """Paint line numbers onto the gutter widget."""
        p = self._p
        painter = QPainter(self._gutter)
        painter.fillRect(event.rect(), QColor(p["gutter_bg"]))

        # Subtle right border
        painter.setPen(QPen(QColor(p["gutter_border"]), 1))
        painter.drawLine(
            self._gutter.width() - 1, event.rect().top(),
            self._gutter.width() - 1, event.rect().bottom()
        )

        block      = self.firstVisibleBlock()
        block_num  = block.blockNumber()
        offset     = self.contentOffset()
        top        = round(self.blockBoundingGeometry(block).translated(offset).top())
        bottom     = top + round(self.blockBoundingRect(block).height())
        cur_block  = self.textCursor().blockNumber()
        fm         = self.fontMetrics()
        line_h     = fm.height()

        font = self.font()

        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                is_current = (block_num == cur_block)

                if is_current:
                    # Highlight current line number background
                    painter.fillRect(
                        0, top, self._gutter.width() - 1, line_h + 2,
                        QColor(p["line_highlight"])
                    )
                    painter.setPen(QColor(p["gutter_fg_active"]))
                    font_cur = QFont(font)
                    font_cur.setWeight(QFont.Weight.Medium)
                    painter.setFont(font_cur)
                else:
                    painter.setPen(QColor(p["gutter_fg"]))
                    painter.setFont(font)

                painter.drawText(
                    QRect(0, top, self._gutter.width() - 8, line_h),
                    Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                    str(block_num + 1)
                )

            block     = block.next()
            top       = bottom
            bottom    = top + round(self.blockBoundingRect(block).height())
            block_num += 1

        painter.end()

    # ── Current line highlight + indentation guides ────────────────────────────

    def _on_cursor_moved(self) -> None:
        self._highlight_current_line()

    def _highlight_current_line(self) -> None:
        """Paint a subtle horizontal stripe on the active line."""
        p = self._p
        selection = QTextEdit.ExtraSelection()
        selection.format.setBackground(QColor(p["line_highlight"]))
        selection.format.setProperty(
            QTextCharFormat.Property.FullWidthSelection, True
        )
        selection.cursor = self.textCursor()
        selection.cursor.clearSelection()
        self.setExtraSelections([selection])

    # ── Painting (indentation guides) ─────────────────────────────────────────

    def paintEvent(self, event) -> None:   # noqa: N802
        """Override to draw indentation guide lines after normal painting."""
        super().paintEvent(event)
        self._draw_indent_guides()

    def _draw_indent_guides(self) -> None:
        """Draw subtle vertical lines at each indentation level."""
        p = self._p
        fm   = self.fontMetrics()
        indent_w = fm.horizontalAdvance(" ") * 2   # 2 spaces per level
        if indent_w <= 0:
            return

        painter  = QPainter(self.viewport())
        pen      = QPen(QColor(p.get("indent_guide", "#404040")))
        pen.setWidth(1)
        painter.setPen(pen)

        block    = self.firstVisibleBlock()
        offset   = self.contentOffset()
        vp_rect  = self.viewport().rect()
        gw       = self.gutter_width()     # left margin already accounted for by viewport

        while block.isValid():
            geom = self.blockBoundingGeometry(block).translated(offset)
            top  = round(geom.top())
            if top > vp_rect.bottom():
                break
            if block.isVisible():
                text  = block.text()
                # Count leading spaces
                leading = len(text) - len(text.lstrip(" "))
                levels  = leading // 2
                h       = round(geom.height())
                for lvl in range(1, levels + 1):
                    x = round(lvl * indent_w) - 1
                    if x > 0:
                        painter.drawLine(x, top, x, top + h - 1)
            block = block.next()
        painter.end()

    # ── Smart editing ──────────────────────────────────────────────────────────

    def keyPressEvent(self, event) -> None:  # noqa: N802
        key = event.key()
        mod = event.modifiers()
        ctrl  = bool(mod & Qt.KeyboardModifier.ControlModifier)
        shift = bool(mod & Qt.KeyboardModifier.ShiftModifier)

        # ── Shift+Tab → de-indent ──────────────────────────────────────────────
        if key == Qt.Key.Key_Tab and shift:
            self._de_indent()
            return

        # ── Tab → insert 2 spaces ─────────────────────────────────────────────
        if key == Qt.Key.Key_Tab and not ctrl:
            cursor = self.textCursor()
            if cursor.hasSelection():
                self._indent_selection()
            else:
                cursor.insertText("  ")
            return

        # ── Auto-close pairs ───────────────────────────────────────────────────
        _pairs = {
            Qt.Key.Key_BraceLeft:    ('{', '}'),
            Qt.Key.Key_BracketLeft:  ('[', ']'),
            Qt.Key.Key_ParenLeft:    ('(', ')'),
        }
        if key in _pairs and not ctrl:
            cursor = self.textCursor()
            if not cursor.hasSelection():
                open_c, close_c = _pairs[key]
                cursor.insertText(open_c + close_c)
                cursor.movePosition(QTextCursor.MoveOperation.Left)
                self.setTextCursor(cursor)
                return

        # ── Auto-close quotes ─────────────────────────────────────────────────
        if key in (Qt.Key.Key_QuoteDbl, Qt.Key.Key_Apostrophe) and not ctrl:
            cursor = self.textCursor()
            if not cursor.hasSelection():
                ch = event.text()
                cursor.insertText(ch + ch)
                cursor.movePosition(QTextCursor.MoveOperation.Left)
                self.setTextCursor(cursor)
                return

        # ── Smart Enter: preserve + increase indent ───────────────────────────
        if key == Qt.Key.Key_Return and not ctrl:
            cursor = self.textCursor()
            line   = cursor.block().text()
            m      = re.match(r"^(\s*)", line)
            indent = m.group(1) if m else ""
            # Increase indent after {, [, (
            stripped = line.rstrip()
            extra = "  " if stripped and stripped[-1] in "{[(:" else ""
            super().keyPressEvent(event)
            self.textCursor().insertText(indent + extra)
            return

        # ── Backspace: delete closing pair if empty ───────────────────────────
        if key == Qt.Key.Key_Backspace and not ctrl:
            cursor = self.textCursor()
            if not cursor.hasSelection():
                doc  = self.document()
                pos  = cursor.position()
                if pos > 0:
                    before = doc.characterAt(pos - 1)
                    after  = doc.characterAt(pos)
                    _close_of = {'{': '}', '[': ']', '(': ')', '"': '"', "'": "'"}
                    if before in _close_of and after == _close_of[before]:
                        cursor.movePosition(QTextCursor.MoveOperation.Right,
                                            QTextCursor.MoveMode.KeepAnchor)
                        cursor.deletePreviousChar()
                        cursor.deletePreviousChar()
                        self.setTextCursor(cursor)
                        return

        super().keyPressEvent(event)

    def _de_indent(self) -> None:
        cursor = self.textCursor()
        cursor.beginEditBlock()
        if cursor.hasSelection():
            start = cursor.selectionStart()
            end   = cursor.selectionEnd()
            cursor.setPosition(start)
            cursor.movePosition(QTextCursor.MoveOperation.StartOfLine)
            while cursor.position() <= end:
                line = cursor.block().text()
                if line.startswith("  "):
                    cursor.movePosition(QTextCursor.MoveOperation.Right,
                                        QTextCursor.MoveMode.KeepAnchor, 2)
                    cursor.removeSelectedText()
                if not cursor.movePosition(QTextCursor.MoveOperation.NextBlock):
                    break
        else:
            line = cursor.block().text()
            if line.startswith("  "):
                cursor.movePosition(QTextCursor.MoveOperation.StartOfLine)
                cursor.movePosition(QTextCursor.MoveOperation.Right,
                                    QTextCursor.MoveMode.KeepAnchor, 2)
                cursor.removeSelectedText()
        cursor.endEditBlock()

    def _indent_selection(self) -> None:
        cursor = self.textCursor()
        start  = cursor.selectionStart()
        end    = cursor.selectionEnd()
        cursor.beginEditBlock()
        cursor.setPosition(start)
        cursor.movePosition(QTextCursor.MoveOperation.StartOfLine)
        while cursor.position() <= end:
            cursor.insertText("  ")
            end += 2
            if not cursor.movePosition(QTextCursor.MoveOperation.NextBlock):
                break
        cursor.endEditBlock()

    # ── Public helpers ─────────────────────────────────────────────────────────

    def get_text(self) -> str:
        return self.toPlainText()

    def set_text(self, text: str) -> None:
        self.setPlainText(text)
        # Move cursor to start
        c = self.textCursor()
        c.movePosition(QTextCursor.MoveOperation.Start)
        self.setTextCursor(c)

    def insert_at_cursor(self, text: str) -> None:
        self.textCursor().insertText(text)


# ─────────────────────────────────────────────────────────────────────────────
# Public EditorWidget wrapper (used by TabManager)
# ─────────────────────────────────────────────────────────────────────────────

class EditorWidget(QWidget):
    """
    Thin wrapper around CodeEditor.
    Exposes the same signals the TabManager / MainWindow expect.
    """

    run_requested    = Signal()
    text_changed     = Signal(str)
    save_requested   = Signal()
    format_requested = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._editor = CodeEditor(self)
        layout.addWidget(self._editor)

        # Debounced text-changed signal
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(200)
        self._timer.timeout.connect(
            lambda: self.text_changed.emit(self._editor.get_text())
        )
        self._editor.textChanged.connect(self._timer.start)

        # Keyboard shortcuts
        QShortcut(QKeySequence("Ctrl+Return"),   self).activated.connect(self.run_requested)
        QShortcut(QKeySequence("Ctrl+S"),         self).activated.connect(self.save_requested)
        QShortcut(QKeySequence("Ctrl+Shift+F"),   self).activated.connect(self.format_requested)
        QShortcut(QKeySequence("Ctrl+D"),         self).activated.connect(self._duplicate_line)
        QShortcut(QKeySequence("Ctrl+Shift+K"),   self).activated.connect(self._delete_line)
        QShortcut(QKeySequence("Ctrl+/"),         self).activated.connect(self._toggle_comment)
        QShortcut(QKeySequence("Alt+Up"),         self).activated.connect(self._move_up)
        QShortcut(QKeySequence("Alt+Down"),       self).activated.connect(self._move_down)

    # ── Public API ─────────────────────────────────────────────────────────────

    def get_text(self) -> str:
        return self._editor.get_text()

    def set_text(self, text: str) -> None:
        self._editor.set_text(text)

    def insert_snippet(self, body: str) -> None:
        self._editor.insert_at_cursor(body)

    def format_document(self) -> None:
        import json
        text = self.get_text().strip()
        try:
            if text.startswith(("[", "{")):
                self._editor.set_text(json.dumps(json.loads(text), indent=2))
        except Exception:
            pass

    def clear(self) -> None:
        self._editor.set_text("")

    def focus(self) -> None:
        self._editor.setFocus()

    # ── Editing operations ─────────────────────────────────────────────────────

    def _duplicate_line(self) -> None:
        ed = self._editor
        c  = ed.textCursor()
        c.select(QTextCursor.SelectionType.LineUnderCursor)
        text = c.selectedText()
        c.movePosition(QTextCursor.MoveOperation.EndOfLine)
        c.insertText("\n" + text)

    def _delete_line(self) -> None:
        ed = self._editor
        c  = ed.textCursor()
        c.select(QTextCursor.SelectionType.LineUnderCursor)
        c.removeSelectedText()
        c.deleteChar()   # remove the newline

    def _toggle_comment(self) -> None:
        ed = self._editor
        c  = ed.textCursor()
        c.select(QTextCursor.SelectionType.LineUnderCursor)
        text = c.selectedText()
        if text.lstrip().startswith("//"):
            new = re.sub(r"^(\s*)//\s?", r"\1", text)
        else:
            indent = re.match(r"^(\s*)", text).group(1)
            new    = indent + "// " + text.lstrip()
        c.insertText(new)

    def _move_up(self) -> None:
        ed  = self._editor
        cur = ed.textCursor()
        blk = cur.block()
        if not blk.previous().isValid():
            return
        col  = cur.positionInBlock()
        cur.select(QTextCursor.SelectionType.LineUnderCursor)
        text = cur.selectedText()
        cur.removeSelectedText()
        cur.deletePreviousChar()
        cur.movePosition(QTextCursor.MoveOperation.StartOfLine)
        cur.insertText(text + "\n")
        cur.movePosition(QTextCursor.MoveOperation.Up)
        cur.movePosition(QTextCursor.MoveOperation.StartOfLine)
        for _ in range(col):
            cur.movePosition(QTextCursor.MoveOperation.Right)
        ed.setTextCursor(cur)

    def _move_down(self) -> None:
        ed  = self._editor
        cur = ed.textCursor()
        blk = cur.block()
        if not blk.next().isValid():
            return
        col  = cur.positionInBlock()
        cur.select(QTextCursor.SelectionType.LineUnderCursor)
        text = cur.selectedText()
        cur.removeSelectedText()
        cur.deleteChar()
        cur.movePosition(QTextCursor.MoveOperation.EndOfLine)
        cur.insertText("\n" + text)
        cur.movePosition(QTextCursor.MoveOperation.StartOfLine)
        for _ in range(col):
            cur.movePosition(QTextCursor.MoveOperation.Right)
        ed.setTextCursor(cur)

    def apply_settings(self) -> None:
        self._editor.apply_settings()
