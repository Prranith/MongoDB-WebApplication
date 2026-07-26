"""
ui/console/result_tree.py
JSON tree view for displaying query results.
Builds a collapsible QTreeWidget from nested BSON/JSON data.
"""

from PySide6.QtWidgets import QTreeWidget, QTreeWidgetItem, QAbstractItemView, QHeaderView
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QBrush, QFont

from utils.theme import theme_manager
from core.formatter import build_tree_nodes


_TYPE_ICONS = {
    "object":   "{}",
    "array":    "[]",
    "string":   '"a"',
    "number":   "123",
    "boolean":  "T/F",
    "null":     "nil",
    "date":     "📅",
    "objectid": "🆔",
    "unknown":  "?",
    "recent":   "⏱",
}


class ResultTree(QTreeWidget):
    """
    Collapsible JSON tree widget for displaying MongoDB query results.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        c = theme_manager.colors()

        self.setColumnCount(3)
        self.setHeaderLabels(["Key", "Value", "Type"])
        self.setObjectName("ResultTree")
        self.setAlternatingRowColors(True)
        self.setRootIsDecorated(True)
        self.setAnimated(True)
        self.setUniformRowHeights(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)

        # Set default sizes and configure middle column to stretch dynamically
        self.setColumnWidth(0, 220)
        self.setColumnWidth(2, 80)
        self.header().setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        self.header().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.header().setSectionResizeMode(2, QHeaderView.ResizeMode.Interactive)

        self.setStyleSheet(f"""
            QTreeWidget {{
                background-color: {c.get('bg_console', '#1e1e1e')};
                color: {c.get('fg_primary', '#d4d4d4')};
                font-family: Consolas, monospace;
                font-size: 13px;
                border: none;
                alternate-background-color: rgba(255,255,255,0.03);
            }}
            QTreeWidget::item:selected {{
                background-color: {c.get('bg_selected', '#264f78')};
            }}
            QHeaderView::section {{
                background-color: {c.get('bg_panel', '#2d2d30')};
                color: {c.get('fg_secondary', '#858585')};
                border: none;
                border-bottom: 1px solid {c.get('separator', '#333333')};
                padding: 4px 8px;
                font-size: 12px;
                font-weight: bold;
            }}
        """)

    def display_results(self, data) -> None:
        """Populate tree from a QueryResult's data field."""
        self.clear()

        if data is None:
            item = QTreeWidgetItem(["(null)", "null", "null"])
            self.addTopLevelItem(item)
            return

        if isinstance(data, list):
            for i, doc in enumerate(data):
                node = build_tree_nodes(doc, f"[{i}]")
                item = self._build_item(node)
                self.addTopLevelItem(item)
            # Expand first few
            for i in range(min(3, self.topLevelItemCount())):
                self.topLevelItem(i).setExpanded(True)
        else:
            node = build_tree_nodes(data, "result")
            item = self._build_item(node)
            self.addTopLevelItem(item)
            item.setExpanded(True)

    def _build_item(self, node: dict) -> QTreeWidgetItem:
        key = node["key"]
        value = node["value"]
        typ = node["type"]

        item = QTreeWidgetItem([key, value, _TYPE_ICONS.get(typ, typ)])
        item.setToolTip(0, key)
        item.setToolTip(1, value)

        # Color-code by type
        c = theme_manager.colors()
        color_map = {
            "string":   c.get("syn_string", "#ce9178"),
            "number":   c.get("syn_number", "#b5cea8"),
            "boolean":  c.get("syn_keyword", "#569cd6"),
            "null":     c.get("fg_secondary", "#858585"),
            "date":     c.get("syn_type", "#4ec9b0"),
            "objectid": c.get("syn_type", "#4ec9b0"),
            "object":   c.get("fg_primary", "#d4d4d4"),
            "array":    c.get("syn_operator", "#c586c0"),
        }
        col = color_map.get(typ)
        if col:
            brush = QBrush(QColor(col))
            item.setForeground(1, brush)

        for child_node in node.get("children", []):
            item.addChild(self._build_item(child_node))

        return item

    def expand_all_items(self) -> None:
        self.expandAll()

    def collapse_all_items(self) -> None:
        self.collapseAll()
