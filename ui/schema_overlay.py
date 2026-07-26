"""
ui/schema_overlay.py
Professional schema visualization and relationship mapping dialog.
"""

from typing import Any
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QBrush, QFont, QGuiApplication
from PySide6.QtWidgets import (
    QDialog, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QTableWidget,
    QTableWidgetItem, QTabWidget, QPushButton, QScrollArea, QFrame,
    QHeaderView, QMessageBox
)

from core.database import db_manager
from utils.theme import theme_manager
from utils.logger import get_logger

log = get_logger(__name__)

# Predefined schema relationships mapping collection fields to target collections
COLLECTION_RELATIONS = {
    "orders": [
        {
            "field": "userId",
            "type": "Many-to-One",
            "referenced_collection": "users",
            "referenced_field": "userId",
            "description": "Links the order to the customer profile who placed it.",
            "join_example": (
                "db.orders.aggregate([\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"users\",\n"
                "      localField: \"userId\",\n"
                "      foreignField: \"userId\",\n"
                "      as: \"customer\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        },
        {
            "field": "items.sku",
            "type": "Many-to-One",
            "referenced_collection": "inventory",
            "referenced_field": "sku",
            "description": "Links each ordered item to its inventory stock/warehouse profile.",
            "join_example": (
                "db.orders.aggregate([\n"
                "  { $unwind: \"$items\" },\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"inventory\",\n"
                "      localField: \"items.sku\",\n"
                "      foreignField: \"sku\",\n"
                "      as: \"product\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        }
    ],
    "shipments": [
        {
            "field": "orderId",
            "type": "One-to-One",
            "referenced_collection": "orders",
            "referenced_field": "orderId",
            "description": "Links the shipment details to the specific order being delivered.",
            "join_example": (
                "db.shipments.aggregate([\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"orders\",\n"
                "      localField: \"orderId\",\n"
                "      foreignField: \"orderId\",\n"
                "      as: \"order\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        }
    ],
    "users": [
        {
            "field": "userId",
            "type": "One-to-Many",
            "referenced_collection": "orders",
            "referenced_field": "userId",
            "description": "Bridges customer profiles to all orders they have placed.",
            "join_example": (
                "db.users.aggregate([\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"orders\",\n"
                "      localField: \"userId\",\n"
                "      foreignField: \"userId\",\n"
                "      as: \"userOrders\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        }
    ],
    "inventory": [
        {
            "field": "sku",
            "type": "One-to-Many",
            "referenced_collection": "orders",
            "referenced_field": "items.sku",
            "description": "Maps the inventory product sku to line items ordered across the system.",
            "join_example": (
                "db.inventory.aggregate([\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"orders\",\n"
                "      localField: \"sku\",\n"
                "      foreignField: \"items.sku\",\n"
                "      as: \"productOrders\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        }
    ],
    "elite": [
        {
            "field": "userId",
            "type": "Many-to-One",
            "referenced_collection": "users",
            "referenced_field": "userId",
            "description": "Links paid/failed elite transactions to the corresponding user profile.",
            "join_example": (
                "db.elite.aggregate([\n"
                "  {\n"
                "    $lookup: {\n"
                "      from: \"users\",\n"
                "      localField: \"userId\",\n"
                "      foreignField: \"userId\",\n"
                "      as: \"user\"\n"
                "    }\n"
                "  }\n"
                "])"
            )
        }
    ]
}


class SchemaOverlayDialog(QDialog):
    """
    Sleek schema visualizer overlay displaying BSON fields, stats,
    and schema relationships/lookup scripts.
    """

    def __init__(self, collection_name: str, parent=None) -> None:
        super().__init__(parent)
        self.collection_name = collection_name
        self.setWindowTitle(f"Schema Details: {collection_name}")
        self.resize(720, 560)
        self.setMinimumSize(600, 450)
        self.setModal(True)

        c = theme_manager.colors()
        self.setStyleSheet(f"""
            QDialog {{
                background-color: {c.get('bg_panel','#1e1e1e')};
                color: {c.get('fg_primary','#cccccc')};
            }}
            QTabWidget::pane {{
                border: 1px solid {c.get('separator','#3c3c3c')};
                background: {c.get('bg_sidebar','#252526')};
                border-radius: 4px;
            }}
            QTabBar::tab {{
                background: {c.get('bg_toolbar','#2d2d2d')};
                color: {c.get('fg_secondary','#969696')};
                padding: 8px 16px;
                border-top-left-radius: 4px;
                border-top-right-radius: 4px;
                border: 1px solid {c.get('separator','#3c3c3c')};
                border-bottom: none;
                margin-right: 2px;
            }}
            QTabBar::tab:selected {{
                background: {c.get('bg_sidebar','#252526')};
                color: {c.get('fg_primary','#ffffff')};
                font-weight: bold;
            }}
            QTabBar::tab:hover:!selected {{
                background: {c.get('bg_hover','#2a2d2e')};
                color: {c.get('fg_primary','#cccccc')};
            }}
        """)

        self._setup_layout(c)
        self._load_collection_data()

    def _setup_layout(self, c: dict) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # ── Header ─────────────────────────────────────────────────────────────
        header = QHBoxLayout()
        title_label = QLabel(f"☰  {self.collection_name}")
        title_label.setFont(QFont("Segoe UI", 16, QFont.Weight.Bold))
        title_label.setStyleSheet(f"color: {c.get('tree_icon_coll','#4ec9b0')};")
        header.addWidget(title_label)

        header.addStretch()

        self.stats_label = QLabel("Loading stats...")
        self.stats_label.setFont(QFont("Segoe UI", 11))
        self.stats_label.setStyleSheet(f"color: {c.get('fg_secondary','#969696')};")
        header.addWidget(self.stats_label)
        layout.addLayout(header)

        # Separator line
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet(f"background-color: {c.get('separator','#3c3c3c')}; border: none; height: 1px;")
        layout.addWidget(sep)

        # ── Tabs Container ─────────────────────────────────────────────────────
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Segoe UI", 10))

        # Tab 1: Fields Table
        self.tab_fields = QWidget()
        tf_layout = QVBoxLayout(self.tab_fields)
        tf_layout.setContentsMargins(8, 8, 8, 8)

        self.table = QTableWidget()
        self.table.setColumnCount(3)
        self.table.setHorizontalHeaderLabels(["Field Name", "BSON Type", "Sample Value"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 180)
        self.table.setColumnWidth(1, 100)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setStyleSheet(f"""
            QTableWidget {{
                background-color: {c.get('bg_sidebar','#252526')};
                color: {c.get('fg_primary','#cccccc')};
                gridline-color: {c.get('separator','#3c3c3c')};
                border: none;
                font-size: 12px;
            }}
            QHeaderView::section {{
                background-color: {c.get('bg_toolbar','#2d2d2d')};
                color: {c.get('fg_secondary','#969696')};
                padding: 6px;
                border: 1px solid {c.get('separator','#3c3c3c')};
                font-weight: bold;
            }}
        """)
        tf_layout.addWidget(self.table)
        self.tabs.addTab(self.tab_fields, "📋 Fields Schema")

        # Tab 2: Relations Panel
        self.tab_relations = QWidget()
        tr_layout = QVBoxLayout(self.tab_relations)
        tr_layout.setContentsMargins(8, 8, 8, 8)

        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setStyleSheet(f"background: transparent; border: none;")

        self.scroll_content = QWidget()
        self.scroll_content.setStyleSheet("background: transparent;")
        self.relations_layout = QVBoxLayout(self.scroll_content)
        self.relations_layout.setContentsMargins(0, 0, 0, 0)
        self.relations_layout.setSpacing(12)
        self.relations_layout.addStretch()

        self.scroll_area.setWidget(self.scroll_content)
        tr_layout.addWidget(self.scroll_area)
        self.tabs.addTab(self.tab_relations, "⚡ Relations & Joins")

        layout.addWidget(self.tabs, 1)

        # ── Bottom controls ─────────────────────────────────────────────────────
        bottom_layout = QHBoxLayout()
        bottom_layout.addStretch()

        close_btn = QPushButton("Close")
        close_btn.setFixedWidth(80)
        close_btn.setFixedHeight(28)
        close_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {c.get('bg_input','#3c3c3c')};
                color: {c.get('fg_primary','#cccccc')};
                border: 1px solid {c.get('border','#3f3f3f')};
                border-radius: 4px;
            }}
            QPushButton:hover {{
                background-color: {c.get('bg_hover','#2a2d2e')};
            }}
        """)
        close_btn.clicked.connect(self.accept)
        bottom_layout.addWidget(close_btn)
        layout.addLayout(bottom_layout)

    def _load_collection_data(self) -> None:
        """Fetch statistics, infer schema fields, and load relationship information."""
        try:
            coll = db_manager.get_collection(self.collection_name)
            if coll is None:
                self.stats_label.setText("Error: Collection not found")
                return

            # Retrieve Document Count
            count = coll.count_documents({})
            self.stats_label.setText(f"{count:,} documents")

            # Extract fields from sample documents
            sample_docs = list(coll.find().limit(20))
            fields_map = {}
            for doc in sample_docs:
                self._extract_fields_rec(doc, "", fields_map)

            # Populates fields table
            self.table.setRowCount(len(fields_map))
            c = theme_manager.colors()
            for row, (field_name, info) in enumerate(sorted(fields_map.items())):
                item_name = QTableWidgetItem(f"  {field_name}")
                item_name.setForeground(QBrush(QColor(c.get("fg_primary", "#cccccc"))))
                item_name.setFont(QFont("Consolas", 11))

                item_type = QTableWidgetItem(info["type"])
                item_type.setForeground(QBrush(QColor(c.get("syn_type", "#4ec9b0"))))
                item_type.setFont(QFont("Segoe UI", 10, QFont.Weight.Medium))

                item_val = QTableWidgetItem(info["sample"])
                item_val.setForeground(QBrush(QColor(c.get("fg_secondary", "#969696"))))
                item_val.setFont(QFont("Consolas", 10))

                self.table.setItem(row, 0, item_name)
                self.table.setItem(row, 1, item_type)
                self.table.setItem(row, 2, item_val)

            # Populates relationships tab
            self._load_relations(c)

        except Exception as e:
            log.error("Failed to load schema overlay data", collection=self.collection_name, error=str(e))
            self.stats_label.setText("Error loading schema info")

    def _extract_fields_rec(self, val: Any, prefix: str, fields_map: dict) -> None:
        """Helper to recursively map fields, types, and samples."""
        if not isinstance(val, dict):
            return
        for key, item in val.items():
            field_name = f"{prefix}.{key}" if prefix else key
            # Skip internal MongoDB structures if necessary, but keep _id
            if key.startswith("$") and key != "$oid" and key != "$date":
                continue
                
            # Deduce pretty BSON type name
            type_name = type(item).__name__
            if item is None:
                type_name = "Null"
            elif isinstance(item, bool):
                type_name = "Boolean"
            elif isinstance(item, int):
                type_name = "Int32"
            elif isinstance(item, float):
                type_name = "Double"
            elif isinstance(item, str):
                type_name = "String"
            elif isinstance(item, list):
                type_name = "Array"
            elif isinstance(item, dict):
                # Handle Mongo Dates/ObjectIds in JSON format
                if "$oid" in item:
                    type_name = "ObjectId"
                    item = item["$oid"]
                elif "$date" in item:
                    type_name = "Date"
                    item = item["$date"]
                else:
                    type_name = "Object"

            sample_str = str(item)
            if len(sample_str) > 70:
                sample_str = sample_str[:67] + "..."

            if field_name not in fields_map:
                fields_map[field_name] = {"type": type_name, "sample": sample_str}

            if isinstance(item, dict) and type_name == "Object":
                self._extract_fields_rec(item, field_name, fields_map)
            elif isinstance(item, list) and item and isinstance(item[0], dict):
                # Recurse inside array elements if they are dicts
                self._extract_fields_rec(item[0], f"{field_name}[]", fields_map)

    def _load_relations(self, c: dict) -> None:
        """Renders relationship visual cards for the collection."""
        relations = COLLECTION_RELATIONS.get(self.collection_name, [])
        if not relations:
            no_relations = QLabel("No defined relationships for this collection.")
            no_relations.setAlignment(Qt.AlignmentFlag.AlignCenter)
            no_relations.setStyleSheet(f"color: {c.get('fg_secondary','#969696')}; font-size: 13px; padding: 24px;")
            self.relations_layout.insertWidget(0, no_relations)
            return

        for idx, rel in enumerate(relations):
            card = QFrame()
            card.setFrameShape(QFrame.Shape.StyledPanel)
            card.setStyleSheet(f"""
                QFrame {{
                    background-color: {c.get('bg_panel','#1e1e1e')};
                    border: 1px solid {c.get('separator','#3c3c3c')};
                    border-radius: 6px;
                    padding: 12px;
                }}
            """)
            card_layout = QVBoxLayout(card)
            card_layout.setSpacing(6)

            # Link details title
            link_title = QLabel(f"🔗  {self.collection_name}.{rel['field']}  ➔  {rel['referenced_collection']}.{rel['referenced_field']}")
            link_title.setFont(QFont("Segoe UI", 12, QFont.Weight.Bold))
            link_title.setStyleSheet(f"color: {c.get('tree_icon_coll','#4ec9b0')}; border: none;")
            card_layout.addWidget(link_title)

            # Description
            desc = QLabel(rel["description"])
            desc.setFont(QFont("Segoe UI", 10))
            desc.setWordWrap(True)
            desc.setStyleSheet(f"color: {c.get('fg_primary','#cccccc')}; border: none;")
            card_layout.addWidget(desc)

            # Relation Type Badge
            type_badge = QLabel(f"Type: {rel['type']}")
            type_badge.setFont(QFont("Segoe UI", 9, QFont.Weight.Bold))
            type_badge.setStyleSheet(f"color: {c.get('fg_secondary','#969696')}; border: none;")
            card_layout.addWidget(type_badge)

            # Join code sample
            code_block = QLabel(rel["join_example"])
            code_block.setFont(QFont("Consolas", 10))
            code_block.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            code_block.setStyleSheet(f"""
                QLabel {{
                    background-color: {c.get('bg_sidebar','#252526')};
                    color: {c.get('syn_string','#ce9178')};
                    border: 1px solid {c.get('separator','#3c3c3c')};
                    border-radius: 4px;
                    padding: 8px;
                }}
            """)
            card_layout.addWidget(code_block)

            # Copy button
            copy_btn = QPushButton("📋 Copy Join Code")
            copy_btn.setFont(QFont("Segoe UI", 10))
            copy_btn.setFixedHeight(28)
            copy_btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: {c.get('bg_input','#3c3c3c')};
                    color: {c.get('fg_primary','#cccccc')};
                    border: 1px solid {c.get('border','#3f3f3f')};
                    border-radius: 4px;
                }}
                QPushButton:hover {{
                    background-color: {c.get('border_focus','#007acc')};
                    color: white;
                }}
            """)
            copy_btn.clicked.connect(lambda _, code=rel["join_example"]: self._copy_to_clipboard(code))
            card_layout.addWidget(copy_btn)

            self.relations_layout.insertWidget(idx, card)

    def _copy_to_clipboard(self, text: str) -> None:
        QGuiApplication.clipboard().setText(text)
        QMessageBox.information(
            self, "Copied",
            "The lookup join query has been copied to your clipboard!"
        )
