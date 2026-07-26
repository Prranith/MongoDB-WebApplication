"""
tests/test_user_manual.py
Unit tests for the UserManualDialog and Help menu User Manual action.
"""

import pytest
from PySide6.QtWidgets import QApplication

# Ensure QApplication instance exists for Qt widget tests
@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    yield app


def test_user_manual_dialog_init(qapp):
    """Test instantiation and basic properties of UserManualDialog."""
    from ui.user_manual_dialog import UserManualDialog, MANUAL_STEPS

    dlg = UserManualDialog()
    assert dlg.windowTitle() == "MongoSandbox — Interactive User Manual"
    assert dlg._stacked_widget.count() == len(MANUAL_STEPS)
    assert len(MANUAL_STEPS) == 8
    assert dlg._current_step == 0


def test_user_manual_navigation(qapp):
    """Test step navigation: next_step(), previous_step(), and bounds."""
    from ui.user_manual_dialog import UserManualDialog, MANUAL_STEPS

    dlg = UserManualDialog()

    # Step 0 initially
    assert dlg._current_step == 0
    assert dlg._prev_btn.isEnabled() is False

    # Navigate next
    dlg.next_step()
    assert dlg._current_step == 1
    assert dlg._prev_btn.isEnabled() is True

    # Navigate to last step
    for _ in range(10):
        dlg.next_step()
    assert dlg._current_step == len(MANUAL_STEPS) - 1

    # Navigate back
    dlg.previous_step()
    assert dlg._current_step == len(MANUAL_STEPS) - 2
