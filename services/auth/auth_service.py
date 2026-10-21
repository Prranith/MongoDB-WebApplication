"""Secure email/password authentication backed by MongoDB Atlas."""

import hashlib
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from services.shared.redis_client import get_auth_db


SESSION_TTL_DAYS = int(os.getenv("AUTH_SESSION_TTL_DAYS", "14"))
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "0").strip().lower() in {"1", "true", "yes"}


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


