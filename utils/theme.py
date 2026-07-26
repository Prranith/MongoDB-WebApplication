"""
utils/theme.py
Single Antigravity Dark theme + QSS generation.
Colours match VS Code Dark+ exactly.
"""

from __future__ import annotations
from typing import Any
from pathlib import Path

THEMES_DIR = Path(__file__).parent.parent / "assets" / "themes"

# ── Single Antigravity Dark theme ─────────────────────────────────────────────

ANTIGRAVITY: dict[str, Any] = {
    "name": "Antigravity Dark",
    "type": "dark",
    "colors": {
        # ── Base backgrounds ─────────────────────────────────────────────────
        "bg_app":           "#1e1e1e",
        "bg_sidebar":       "#252526",
        "bg_panel":         "#252526",
        "bg_toolbar":       "#181818",
        "bg_statusbar":     "#1e1e1e",
        "bg_editor":        "#1e1e1e",
        "bg_console":       "#1e1e1e",
        "bg_input":         "#3c3c3c",
        "bg_hover":         "#2a2d2e",
        "bg_selected":      "#094771",
        "bg_tab_active":    "#1e1e1e",
        "bg_tab_inactive":  "#252526",
        "bg_activity":      "#333333",
        # ── Foregrounds ──────────────────────────────────────────────────────
        "fg_primary":       "#cccccc",
        "fg_secondary":     "#969696",
        "fg_disabled":      "#636363",
        "fg_statusbar":     "#ffffff",
        "fg_tab_active":    "#ffffff",
        "fg_tab_inactive":  "#969696",
        # ── Borders ──────────────────────────────────────────────────────────
        "border":           "#3f3f3f",
        "border_focus":     "#007acc",
        "separator":        "#3c3c3c",
        # ── Buttons ──────────────────────────────────────────────────────────
        "btn_primary_bg":   "#0e639c",
        "btn_primary_fg":   "#ffffff",
        "btn_primary_hover":"#1177bb",
        "btn_run_bg":       "#3a7d0a",
        "btn_run_hover":    "#4a9b10",
        "btn_danger_bg":    "#a32929",
        "btn_danger_hover": "#c02a2a",
        # ── Scrollbar ────────────────────────────────────────────────────────
        "scrollbar_bg":     "#1e1e1e",
        "scrollbar_fg":     "#424242",
        "scrollbar_hover":  "#686868",
        # ── Console ──────────────────────────────────────────────────────────
        "console_success":  "#4ec94e",
        "console_error":    "#f44336",
        "console_warn":     "#ff9800",
        "console_info":     "#569cd6",
        "console_timing":   "#9cdcfe",
        # ── Syntax (VS Code Dark+ exact) ─────────────────────────────────────
        "syn_keyword":      "#569cd6",
        "syn_string":       "#ce9178",
        "syn_number":       "#b5cea8",
        "syn_operator":     "#c586c0",
        "syn_comment":      "#6a9955",
        "syn_function":     "#dcdcaa",
        "syn_type":         "#4ec9b0",
        "syn_variable":     "#9cdcfe",
        "syn_error":        "#f44336",
        # ── Editor chrome ────────────────────────────────────────────────────
        "gutter_bg":        "#1e1e1e",
        "gutter_fg":        "#858585",
        "gutter_active_fg": "#c6c6c6",
        "line_highlight":   "#282828",
        "selection_bg":     "#264f78",
        "caret":            "#aeafad",
        "indent_guide":     "#404040",
        # ── Badges ───────────────────────────────────────────────────────────
        "badge_green":      "#166534",
        "badge_red":        "#7f1d1d",
        "badge_blue":       "#1e3a5f",
        # ── Tree icons ───────────────────────────────────────────────────────
        "tree_icon_db":     "#e8a040",
        "tree_icon_coll":   "#4ec9b0",
        "tree_icon_idx":    "#9cdcfe",
        "tree_icon_field":  "#d4d4d4",
    },
}

BUILTIN_THEMES: dict[str, dict] = {
    "antigravity": ANTIGRAVITY,
}


# ── Theme Manager ──────────────────────────────────────────────────────────────

class ThemeManager:
    """Manages the single Antigravity theme and generates QSS."""

    def __init__(self) -> None:
        self._current     = ANTIGRAVITY
        self._current_name = "antigravity"

    def apply(self, name: str, app) -> dict:
        theme = BUILTIN_THEMES.get(name, ANTIGRAVITY)
        self._current      = theme
        self._current_name = name
        c   = theme["colors"]
        qss = self._build_qss(c)
        if app:
            app.setStyleSheet(qss)
        return theme

    def current(self) -> dict:
        return self._current

    def current_name(self) -> str:
        return self._current_name

    def colors(self) -> dict[str, str]:
        return self._current.get("colors", {})

    def c(self, key: str, fallback: str = "#888888") -> str:
        return self._current.get("colors", {}).get(key, fallback)

    def get_theme(self, name: str) -> dict:
        return BUILTIN_THEMES.get(name, ANTIGRAVITY)

    def is_dark(self) -> bool:
        return True

    @staticmethod
    def list_themes() -> list[str]:
        return list(BUILTIN_THEMES.keys())

    def _build_qss(self, c: dict) -> str:
        return f"""
/* ═══════════════════════════════════════════════════════════════
   MongoSandbox — Antigravity Dark Stylesheet
   ═══════════════════════════════════════════════════════════════ */

/* ── Reset / Base ─────────────────────────────────────────────── */
QWidget {{
    background-color: {c['bg_app']};
    color: {c['fg_primary']};
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    border: none;
    outline: none;
}}
QMainWindow {{
    background-color: {c['bg_app']};
}}

/* ── Menu Bar ─────────────────────────────────────────────────── */
QMenuBar {{
    background-color: {c['bg_toolbar']};
    color: {c['fg_primary']};
    border-bottom: 1px solid {c['separator']};
    padding: 2px 0;
    spacing: 0;
}}
QMenuBar::item {{
    background-color: transparent;
    padding: 4px 10px;
    border-radius: 3px;
}}
QMenuBar::item:selected {{
    background-color: {c['bg_hover']};
}}
QMenuBar::item:pressed {{
    background-color: {c['bg_selected']};
}}
QMenu {{
    background-color: {c['bg_panel']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    padding: 4px 0;
}}
QMenu::item {{
    padding: 5px 24px 5px 16px;
    border-radius: 0;
}}
QMenu::item:selected {{
    background-color: {c['bg_selected']};
    color: {c['fg_primary']};
}}
QMenu::item:disabled {{
    color: {c['fg_disabled']};
}}
QMenu::separator {{
    height: 1px;
    background-color: {c['separator']};
    margin: 3px 0;
}}

/* ── Activity Bar ──────────────────────────────────────────────── */
#ActivityBar {{
    background-color: {c['bg_activity']};
    border-right: 1px solid {c['separator']};
}}
#ActivityBarBtn {{
    background-color: transparent;
    color: {c['fg_secondary']};
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    padding: 0;
    font-size: 16px;
}}
#ActivityBarBtn:hover {{
    color: {c['fg_primary']};
    background-color: rgba(255,255,255,0.07);
}}
#ActivityBarBtn:checked {{
    color: {c['fg_primary']};
    border-left: 2px solid {c['border_focus']};
    background-color: rgba(255,255,255,0.1);
}}

/* ── Sidebar Panel ─────────────────────────────────────────────── */
#SidebarPanel {{
    background-color: {c['bg_sidebar']};
    border-right: 1px solid {c['separator']};
}}
#SidebarPanelHeader {{
    background-color: {c['bg_sidebar']};
    border-bottom: 1px solid {c['separator']};
}}
#SidebarHeader {{
    color: {c['fg_secondary']};
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1.5px;
    background-color: transparent;
}}

/* ── Tree Views (DB Explorer, Inspector) ───────────────────────── */
QTreeWidget, QTreeView {{
    background-color: {c['bg_sidebar']};
    color: {c['fg_primary']};
    border: none;
    outline: none;
    font-size: 13px;
    selection-background-color: {c['bg_selected']};
}}
QTreeWidget::item, QTreeView::item {{
    padding: 3px 4px;
    border-radius: 0;
}}
QTreeWidget::item:hover, QTreeView::item:hover {{
    background-color: {c['bg_hover']};
}}
QTreeWidget::item:selected, QTreeView::item:selected {{
    background-color: {c['bg_selected']};
    color: {c['fg_primary']};
}}
QHeaderView {{
    background-color: {c['bg_sidebar']};
    border: none;
}}
QHeaderView::section {{
    background-color: {c['bg_sidebar']};
    color: {c['fg_secondary']};
    border: none;
    border-bottom: 1px solid {c['separator']};
    font-size: 11px;
    font-weight: bold;
    padding: 3px 6px;
}}

/* ── List Views ────────────────────────────────────────────────── */
QListWidget, QListView {{
    background-color: {c['bg_sidebar']};
    color: {c['fg_primary']};
    border: none;
    outline: none;
}}
QListWidget::item {{
    padding: 4px 10px;
}}
QListWidget::item:hover {{
    background-color: {c['bg_hover']};
}}
QListWidget::item:selected {{
    background-color: {c['bg_selected']};
    color: {c['fg_primary']};
}}

/* ── Run Bar ───────────────────────────────────────────────────── */
#RunBar {{
    background-color: {c['bg_toolbar']};
    border-bottom: 1px solid {c['separator']};
}}

/* ── Editor Tab Bar ────────────────────────────────────────────── */
#EditorTabBar {{
    background-color: {c['bg_tab_inactive']};
}}
#EditorTabBar QTabBar {{
    background-color: {c['bg_tab_inactive']};
}}
#EditorTabBar QTabBar::tab {{
    background-color: {c['bg_tab_inactive']};
    color: {c['fg_tab_inactive']};
    padding: 0 6px 0 12px;
    height: 28px;
    border: none;
    border-right: 1px solid {c['separator']};
    border-top: 2px solid transparent;
    font-size: 12px;
    min-width: 100px;
    max-width: 320px;
}}
#EditorTabBar QTabBar::tab:selected {{
    background-color: {c['bg_tab_active']};
    color: {c['fg_tab_active']};
    border-top: 2px solid {c['border_focus']};
}}
#EditorTabBar QTabBar::tab:hover:!selected {{
    background-color: {c['bg_hover']};
    color: {c['fg_primary']};
}}
QTabWidget::pane {{
    border: none;
    background-color: {c['bg_editor']};
}}

/* ── Console Area ──────────────────────────────────────────────── */
#ConsoleArea {{
    background-color: {c['bg_console']};
    border-top: 1px solid {c['separator']};
}}
#ConsoleHeader {{
    background-color: {c['bg_toolbar']};
    border-bottom: 1px solid {c['separator']};
}}
#ConsoleArea QTabBar::tab {{
    background-color: {c['bg_toolbar']};
    color: {c['fg_secondary']};
    padding: 4px 16px;
    height: 30px;
    border: none;
    border-right: 1px solid {c['separator']};
    border-top: 1px solid transparent;
    font-size: 12px;
    min-width: 60px;
}}
#ConsoleArea QTabBar::tab:selected {{
    background-color: {c['bg_console']};
    color: {c['fg_primary']};
    border-top: 2px solid {c['border_focus']};
}}
#ConsoleArea QTabBar::tab:hover:!selected {{
    background-color: {c['bg_hover']};
    color: {c['fg_primary']};
}}
#ConsoleArea QTabWidget::pane {{
    border: none;
    background-color: {c['bg_console']};
}}

/* ── Status Bar ────────────────────────────────────────────────── */
QStatusBar {{
    background-color: {c['bg_statusbar']};
    color: {c['fg_statusbar']};
    font-size: 12px;
    border: none;
    min-height: 22px;
    max-height: 22px;
    padding: 0;
}}
QStatusBar QLabel {{
    color: {c['fg_statusbar']};
    background-color: transparent;
    padding: 0 6px;
    font-size: 12px;
}}
QStatusBar QPushButton {{
    background-color: transparent;
    color: {c['fg_statusbar']};
    border: none;
    padding: 0 8px;
    font-size: 12px;
}}
QStatusBar QPushButton:hover {{
    background-color: rgba(255,255,255,0.15);
}}
#BadgeConnected {{
    background-color: rgba(0,0,0,0.2);
    color: {c['fg_statusbar']};
    border: none;
    padding: 0 8px;
    font-size: 12px;
}}

/* ── Buttons ───────────────────────────────────────────────────── */
QPushButton {{
    background-color: {c['bg_input']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    border-radius: 4px;
    padding: 4px 14px;
    font-size: 13px;
}}
QPushButton:hover {{
    background-color: {c['bg_hover']};
    border-color: {c['border_focus']};
}}
QPushButton:pressed {{
    background-color: {c['bg_selected']};
}}
QPushButton:disabled {{
    color: {c['fg_disabled']};
    border-color: {c['separator']};
    background-color: {c['bg_app']};
}}
#RunButton {{
    background-color: {c['btn_run_bg']};
    color: #ffffff;
    border: none;
    border-radius: 4px;
    padding: 4px 16px;
    font-weight: bold;
    font-size: 13px;
}}
#RunButton:hover {{
    background-color: {c['btn_run_hover']};
}}
#PrimaryButton {{
    background-color: {c['btn_primary_bg']};
    color: {c['btn_primary_fg']};
    border: none;
    border-radius: 4px;
}}
#PrimaryButton:hover {{
    background-color: {c['btn_primary_hover']};
}}
#IconButton {{
    background-color: {c['bg_input']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 12px;
}}
#IconButton:hover {{
    background-color: {c['bg_hover']};
    border-color: {c['border_focus']};
}}
QToolButton {{
    background-color: transparent;
    color: {c['fg_secondary']};
    border: none;
    border-radius: 3px;
    padding: 2px;
}}
QToolButton:hover {{
    background-color: {c['bg_hover']};
    color: {c['fg_primary']};
}}

/* ── Inputs / Forms ────────────────────────────────────────────── */
QLineEdit, QTextEdit, QPlainTextEdit {{
    background-color: {c['bg_input']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    border-radius: 3px;
    padding: 3px 8px;
    selection-background-color: {c['selection_bg']};
}}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
    border-color: {c['border_focus']};
}}
QSpinBox {{
    background-color: {c['bg_input']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    border-radius: 3px;
    padding: 2px 8px;
}}
QSpinBox:focus {{
    border-color: {c['border_focus']};
}}
QSpinBox::up-button, QSpinBox::down-button {{
    background-color: {c['bg_hover']};
    border: none;
    width: 14px;
}}
QComboBox {{
    background-color: {c['bg_input']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    border-radius: 3px;
    padding: 3px 8px;
    min-width: 80px;
}}
QComboBox:focus {{
    border-color: {c['border_focus']};
}}
QComboBox::drop-down {{
    border: none;
    width: 20px;
}}
QComboBox QAbstractItemView {{
    background-color: {c['bg_panel']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
    selection-background-color: {c['bg_selected']};
    outline: none;
}}

/* ── Scrollbars ────────────────────────────────────────────────── */
QScrollBar:vertical {{
    background: {c['scrollbar_bg']};
    width: 10px;
    border: none;
    margin: 0;
}}
QScrollBar::handle:vertical {{
    background: {c['scrollbar_fg']};
    min-height: 20px;
    border-radius: 5px;
    margin: 2px 2px;
}}
QScrollBar::handle:vertical:hover {{
    background: {c['scrollbar_hover']};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0; background: none;
}}
QScrollBar:horizontal {{
    background: {c['scrollbar_bg']};
    height: 10px;
    border: none;
    margin: 0;
}}
QScrollBar::handle:horizontal {{
    background: {c['scrollbar_fg']};
    min-width: 20px;
    border-radius: 5px;
    margin: 2px 2px;
}}
QScrollBar::handle:horizontal:hover {{
    background: {c['scrollbar_hover']};
}}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0; background: none;
}}

/* ── Dialogs ───────────────────────────────────────────────────── */
QDialog {{
    background-color: {c['bg_panel']};
    color: {c['fg_primary']};
    border: 1px solid {c['border']};
}}
QLabel {{
    background-color: transparent;
    color: {c['fg_primary']};
    border: none;
}}

/* ── Inspector Panel ───────────────────────────────────────────── */
#InspectorPanel {{
    background-color: {c['bg_panel']};
    border-left: 1px solid {c['separator']};
}}

/* ── Command Palette ───────────────────────────────────────────── */
#CommandPalette {{
    background-color: {c['bg_panel']};
    border: 1px solid {c['border']};
    border-radius: 6px;
}}

/* ── Splitter handles ──────────────────────────────────────────── */
QSplitter::handle {{
    background-color: {c['separator']};
}}
QSplitter::handle:hover {{
    background-color: {c['border_focus']};
}}
QSplitter::handle:horizontal {{
    width: 1px;
}}
QSplitter::handle:vertical {{
    height: 4px;
}}
"""


# ── Singleton ──────────────────────────────────────────────────────────────────

theme_manager = ThemeManager()
