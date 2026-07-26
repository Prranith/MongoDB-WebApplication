"""
tests/test_analytics.py
Unit tests for the AnalyticsTracker service and metrics calculation.
"""

import pytest
from utils.analytics import AnalyticsTracker


def test_analytics_singleton():
    """Test AnalyticsTracker singleton instance."""
    tracker1 = AnalyticsTracker.instance()
    tracker2 = AnalyticsTracker.instance()
    assert tracker1 is tracker2


def test_record_app_launch():
    """Test recording application launch."""
    tracker = AnalyticsTracker.instance()
    initial_stats = tracker.get_stats()
    initial_visits = initial_stats.get("total_visits", 0)

    updated = tracker.record_app_launch()
    assert updated["total_visits"] == initial_visits + 1
    assert updated["last_visited"] is not None


def test_record_profile_visit():
    """Test recording profile visit for collection."""
    tracker = AnalyticsTracker.instance()
    initial_stats = tracker.get_stats()
    initial_profile_visits = initial_stats.get("total_profile_visits", 0)

    tracker.record_profile_visit("users")
    updated = tracker.get_stats()

    assert updated["total_profile_visits"] == initial_profile_visits + 1
    assert updated["collection_visits"]["users"] >= 1


def test_record_query_executed():
    """Test recording query executions."""
    tracker = AnalyticsTracker.instance()
    initial_stats = tracker.get_stats()
    initial_queries = initial_stats.get("queries_executed", 0)

    tracker.record_query_executed()
    updated = tracker.get_stats()

    assert updated["queries_executed"] == initial_queries + 1
