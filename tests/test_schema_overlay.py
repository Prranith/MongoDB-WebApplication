import sys
from PySide6.QtWidgets import QApplication
from ui.schema_overlay import SchemaOverlayDialog, COLLECTION_RELATIONS

def test_relations_configurations():
    # Verify collections have predefined relations
    assert "orders" in COLLECTION_RELATIONS
    assert "users" in COLLECTION_RELATIONS
    assert "shipments" in COLLECTION_RELATIONS
    assert "inventory" in COLLECTION_RELATIONS
    
    # Check shipments relation properties
    shipment_relations = COLLECTION_RELATIONS["shipments"]
    assert len(shipment_relations) == 1
    assert shipment_relations[0]["field"] == "orderId"
    assert shipment_relations[0]["referenced_collection"] == "orders"
    assert "join_example" in shipment_relations[0]

def test_dialog_init():
    app = QApplication.instance() or QApplication(sys.argv)
    dialog = SchemaOverlayDialog("users")
    
    assert dialog.collection_name == "users"
    assert dialog.windowTitle() == "Schema Details: users"
    assert dialog.table.columnCount() == 3
    assert dialog.table.horizontalHeaderItem(0).text() == "Field Name"
    assert dialog.table.horizontalHeaderItem(1).text() == "BSON Type"
    assert dialog.table.horizontalHeaderItem(2).text() == "Sample Value"
