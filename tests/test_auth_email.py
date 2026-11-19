from unittest.mock import MagicMock, patch

import pytest

from services.auth.auth_service import _secret_env, _send_email_message


def test_secret_env_removes_accidental_surrounding_quotes(monkeypatch):
    monkeypatch.setenv("CODELEAF_TEST_SECRET", '"refresh-token-value"')
    assert _secret_env("CODELEAF_TEST_SECRET") == "refresh-token-value"


def test_gmail_invalid_grant_returns_actionable_configuration_error(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "refresh-token")
    monkeypatch.setenv("GMAIL_SENDER_EMAIL", "sender@example.com")
    response = MagicMock(status_code=400)
    response.json.return_value = {"error": "invalid_grant", "error_description": "Bad Request"}

    with patch("services.auth.auth_service.requests.post", return_value=response):
        with pytest.raises(RuntimeError, match="generate a new refresh token"):
            _send_email_message("Subject", "recipient@example.com", "Body")
