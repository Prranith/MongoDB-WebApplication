"""Secure email/password authentication backed by MongoDB Atlas."""

import hashlib
import os
import re
import secrets
import time
import requests
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from services.shared.redis_client import get_auth_db


SESSION_TTL_DAYS = int(os.getenv("AUTH_SESSION_TTL_DAYS", "14"))
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "0").strip().lower() in {"1", "true", "yes"}
EMAIL_VERIFICATION_REQUIRED = os.getenv(
    "AUTH_EMAIL_VERIFICATION_REQUIRED",
    "1" if os.getenv("BREVO_API_KEY", "").strip() else "0",
).strip().lower() in {"1", "true", "yes"}
OTP_TTL_MINUTES = max(5, int(os.getenv("AUTH_OTP_TTL_MINUTES", "10")))
OTP_MAX_ATTEMPTS = max(3, int(os.getenv("AUTH_OTP_MAX_ATTEMPTS", "5")))


def _now():
    return datetime.now(timezone.utc)


def _email(value):
    return str(value or "").strip().lower()


def _safe_user(doc):
    if not doc:
        return None
    return {
        "id": str(doc.get("_id", "")),
        "email": doc.get("email", ""),
        "name": doc.get("name") or doc.get("email", "").split("@")[0],
        "avatar": doc.get("avatar", ""),
        "providers": sorted(doc.get("providers", [])),
        "emailVerified": bool(doc.get("emailVerified", False)),
        "createdAt": doc.get("createdAt").isoformat() if hasattr(doc.get("createdAt"), "isoformat") else doc.get("createdAt"),
    }


def _db():
    return get_auth_db()


def init_indexes():
    db = _db()
    if db is None:
        return
    db.users.create_index("email", unique=True, sparse=True)
    db.identities.create_index([("provider", 1), ("subject", 1)], unique=True)
    db.sessions.create_index("expiresAt", expireAfterSeconds=0)
    db.auth_events.create_index("createdAt")
    db.email_otps.create_index("expiresAt", expireAfterSeconds=0)


def _otp_digest(email, code):
    secret = os.getenv("AUTH_SECRET_KEY", "").strip() or "development-only-secret"
    return hashlib.sha256(f"{secret}:{email}:{code}".encode()).hexdigest()


def _send_verification_email(email, name, code):
    api_key = os.getenv("BREVO_API_KEY", "").strip()
    sender = os.getenv("BREVO_EMAIL_FROM", os.getenv("AUTH_EMAIL_FROM", "")).strip()
    if not api_key or not sender:
        if os.getenv("AUTH_EMAIL_DEV_MODE", "0").strip().lower() in {"1", "true", "yes"}:
            print(f"[auth] development email OTP for {email}: {code}")
            return True
        return False
    match = re.match(r"^(.*?)\s*<([^<>]+)>\s*$", sender)
    sender_name = (match.group(1).strip() if match else "CodeLeaf") or "CodeLeaf"
    sender_email = match.group(2).strip() if match else sender
    try:
        response = requests.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": api_key, "accept": "application/json", "Content-Type": "application/json"},
            json={
                "sender": {"name": sender_name, "email": sender_email},
                "to": [{"email": email, "name": name}],
                "subject": "Verify your CodeLeaf email",
                "htmlContent": f"<p>Hi {name},</p><p>Your CodeLeaf verification code is <strong>{code}</strong>.</p><p>This code expires in {OTP_TTL_MINUTES} minutes.</p>",
            },
            timeout=8,
        )
        return response.ok
    except requests.RequestException:
        return False


def issue_email_otp(user):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    email = _email(user.get("email"))
    code = f"{secrets.randbelow(1000000):06d}"
    now = _now()
    db.email_otps.delete_many({"email": email})
    sent = _send_verification_email(email, user.get("name", "there"), code)
    if not sent:
        raise RuntimeError("Email delivery is not configured. Set BREVO_API_KEY and BREVO_EMAIL_FROM.")
    db.email_otps.insert_one({"email": email, "codeHash": _otp_digest(email, code), "attempts": 0,
                              "createdAt": now, "expiresAt": now + timedelta(minutes=OTP_TTL_MINUTES)})


def verify_email_otp(email, code):
    db = _db()
    email = _email(email)
    record = db.email_otps.find_one({"email": email, "expiresAt": {"$gt": _now()}}) if db is not None else None
    if not record or record.get("attempts", 0) >= OTP_MAX_ATTEMPTS:
        raise ValueError("This verification code is expired or locked. Request a new code.")
    if not secrets.compare_digest(record.get("codeHash", ""), _otp_digest(email, str(code or ""))):
        db.email_otps.update_one({"_id": record["_id"]}, {"$inc": {"attempts": 1}})
        raise ValueError("Incorrect verification code.")
    db.users.update_one({"email": email}, {"$set": {"emailVerified": True, "updatedAt": _now()}})
    db.email_otps.delete_one({"_id": record["_id"]})
    return db.users.find_one({"email": email})


def _event(kind, user_id=None, provider=None, success=True, reason=""):
    db = _db()
    if db is not None:
        db.auth_events.insert_one({
            "kind": kind,
            "userId": user_id,
            "provider": provider,
            "success": bool(success),
            "reason": reason[:300],
            "ip": request.headers.get("X-Forwarded-For", request.remote_addr or "")[:120],
            "userAgent": request.headers.get("User-Agent", "")[:300],
            "createdAt": _now(),
        })


def create_password_user(name, email, password):
    email = _email(email)
    name = str(name or "").strip()[:100]
    if len(name) < 2 or "@" not in email or len(email) > 254:
        raise ValueError("Enter a valid name and email address.")
    if len(password or "") < 10:
        raise ValueError("Password must contain at least 10 characters.")
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    init_indexes()
    if db.users.find_one({"email": email}):
        raise ValueError("An account with this email already exists.")
    now = _now()
    doc = {
        "email": email,
        "name": name,
        "passwordHash": generate_password_hash(password, method="scrypt"),
        "providers": ["password"],
        "createdAt": now,
        "updatedAt": now,
        "status": "active",
        "emailVerified": not EMAIL_VERIFICATION_REQUIRED,
    }
    result = db.users.insert_one(doc)
    doc["_id"] = result.inserted_id
    _event("signup", str(result.inserted_id), "password")
    return doc


def password_login(email, password):
    db = _db()
    email = _email(email)
    user = db.users.find_one({"email": email}) if db is not None else None
    if not user or not user.get("passwordHash") or not check_password_hash(user["passwordHash"], password or ""):
        _event("login", None, "password", False, "invalid_credentials")
        raise ValueError("Invalid email or password.")
    if user.get("status", "active") != "active":
        raise ValueError("This account is not active.")
    if EMAIL_VERIFICATION_REQUIRED and not user.get("emailVerified", False):
        raise ValueError("Verify your email before signing in.")
    _event("login", str(user["_id"]), "password")
    return user


def create_session(user):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    raw = secrets.token_urlsafe(48)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    now = _now()
    db.sessions.insert_one({
        "_id": digest,
        "userId": user["_id"],
        "createdAt": now,
        "lastSeenAt": now,
        "expiresAt": now + timedelta(days=SESSION_TTL_DAYS),
        "ip": request.headers.get("X-Forwarded-For", request.remote_addr or "")[:120],
        "userAgent": request.headers.get("User-Agent", "")[:300],
    })
    session.clear()
    session["auth_session"] = raw
    session.permanent = True
    return _safe_user(user)


def current_user():
    db = _db()
    raw = session.get("auth_session")
    if db is None or not raw:
        return None
    digest = hashlib.sha256(raw.encode()).hexdigest()
    record = db.sessions.find_one({"_id": digest, "expiresAt": {"$gt": _now()}})
    if not record:
        session.pop("auth_session", None)
        return None
    user = db.users.find_one({"_id": record["userId"], "status": "active"})
    if user:
        db.sessions.update_one({"_id": digest}, {"$set": {"lastSeenAt": _now()}})
    return _safe_user(user)


def logout():
    raw = session.pop("auth_session", None)
    db = _db()
    if raw and db is not None:
        db.sessions.delete_one({"_id": hashlib.sha256(raw.encode()).hexdigest()})
    session.clear()


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
        g.user = user
        return view(*args, **kwargs)
    return wrapped


