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


def test_gmail_smtp_app_password_is_preferred(monkeypatch):
    monkeypatch.setenv("GMAIL_SENDER_EMAIL", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")
    smtp = MagicMock()
    smtp.__enter__.return_value = smtp
    with patch("services.auth.auth_service.smtplib.SMTP", return_value=smtp) as smtp_factory:
        assert _send_email_message("Subject", "recipient@example.com", "Body") is True

    smtp_factory.assert_called_once_with("smtp.gmail.com", 587, timeout=15)
    smtp.starttls.assert_called_once_with()
    smtp.login.assert_called_once_with("sender@example.com", "app-password")
    smtp.send_message.assert_called_once()
