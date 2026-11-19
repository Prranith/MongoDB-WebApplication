"""Secure email/password authentication backed by MongoDB Atlas."""

import hashlib
import os
import secrets
import base64
import requests
import re
import html
from pathlib import Path
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from services.shared.redis_client import get_auth_db


SESSION_TTL_DAYS = int(os.getenv("AUTH_SESSION_TTL_DAYS", "14"))
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "0").strip().lower() in {"1", "true", "yes"}
# Email ownership is mandatory; a deployment variable must not accidentally
# disable this security gate.
EMAIL_VERIFICATION_REQUIRED = True
OTP_TTL_MINUTES = max(5, int(os.getenv("AUTH_OTP_TTL_MINUTES", "10")))
OTP_MAX_ATTEMPTS = max(3, int(os.getenv("AUTH_OTP_MAX_ATTEMPTS", "5")))
_COLLEGE_MASTER_PATH = Path(__file__).resolve().parents[2] / "college_list_master.txt"
_college_master_cache = None


def _now():
    return datetime.now(timezone.utc)


def _email(value):
    return str(value or "").strip().lower()


def _safe_user(doc):
    if not doc:
        return None
    preferences = doc.get("preferences") if isinstance(doc.get("preferences"), dict) else {}
    return {
        "id": str(doc.get("_id", "")),
        "email": doc.get("email", ""),
        "name": doc.get("name") or doc.get("email", "").split("@")[0],
        "avatar": doc.get("avatar", ""),
        "cover": doc.get("cover", ""),
        "college": doc.get("college", ""),
        "linkedin": doc.get("linkedin", ""),
        "bio": doc.get("bio", ""),
        "phone": doc.get("phone", ""),
        "links": doc.get("links", []),
        "preferences": {
            "emailNotifications": bool(preferences.get("emailNotifications", True)),
            "assessmentReminders": bool(preferences.get("assessmentReminders", True)),
            "profileVisibility": preferences.get("profileVisibility", "members"),
        },
        "providers": sorted(doc.get("providers", [])),
        "emailVerified": bool(doc.get("emailVerified", False)),
        "createdAt": doc.get("createdAt").isoformat() if hasattr(doc.get("createdAt"), "isoformat") else doc.get("createdAt"),
    }


def _db():
    return get_auth_db()


def _master_colleges():
    """Load the supplied India college directory once per worker."""
    global _college_master_cache
    if _college_master_cache is None:
        try:
            text = _COLLEGE_MASTER_PATH.read_text(encoding="utf-8")
            _college_master_cache = sorted({html.unescape(name).strip() for name in re.findall(r'"([^"\r\n]+)"', text) if html.unescape(name).strip()}, key=str.casefold)
        except OSError:
            _college_master_cache = []
    return _college_master_cache


def college_options():
    """Return the master directory plus colleges added by users."""
    names = set(_master_colleges())
    db = _db()
    if db is not None:
        try:
            names.update(str(doc.get("name") or "").strip() for doc in db.colleges.find({}, {"name": 1}) if str(doc.get("name") or "").strip())
        except Exception:
            pass
    return sorted(names, key=str.casefold)


def remember_college(name):
    """Persist a custom college so it is available to later signups."""
    name = str(name or "").strip()[:180]
    if len(name) < 2:
        return
    db = _db()
    if db is None:
        return
    try:
        db.colleges.create_index("name", unique=True)
        db.colleges.update_one({"name": name}, {"$setOnInsert": {"name": name, "createdAt": _now()}}, upsert=True)
    except Exception:
        pass


def init_indexes():
    db = _db()
    if db is None:
        return
    db.users.create_index("email", unique=True, sparse=True)
    db.identities.create_index([("provider", 1), ("subject", 1)], unique=True)
    db.sessions.create_index("expiresAt", expireAfterSeconds=0)
    db.auth_events.create_index("createdAt")
    db.email_otps.create_index("expiresAt", expireAfterSeconds=0)
    db.pending_signups.create_index("expiresAt", expireAfterSeconds=0)
    db.pending_signups.create_index("email", unique=True)
    db.password_resets.create_index("expiresAt", expireAfterSeconds=0)


def _otp_digest(email, code):
    secret = os.getenv("AUTH_SECRET_KEY", "").strip() or "development-only-secret"
    return hashlib.sha256(f"{secret}:{email}:{code}".encode()).hexdigest()


def _secret_env(name):
    """Read a deployment secret while tolerating copied surrounding quotes."""
    value = str(os.getenv(name, "") or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1].strip()
    return value


def _send_email_message(subject, recipient, body):
    client_id = _secret_env("GOOGLE_CLIENT_ID")
    client_secret = _secret_env("GOOGLE_CLIENT_SECRET")
    refresh_token = _secret_env("GOOGLE_REFRESH_TOKEN")
    sender = _secret_env("GMAIL_SENDER_EMAIL")
    if not client_id or not client_secret or not refresh_token or not sender:
        if os.getenv("AUTH_EMAIL_DEV_MODE", "0").strip().lower() in {"1", "true", "yes"}:
            print(f"[auth] development email queued for {recipient}")
            return True
        raise RuntimeError("Gmail API is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, and GMAIL_SENDER_EMAIL.")
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content(body)
    try:
        token_response = requests.post(
            "https://oauth2.googleapis.com/token",
            data={"client_id": client_id, "client_secret": client_secret,
                  "refresh_token": refresh_token, "grant_type": "refresh_token"},
            timeout=15,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Gmail OAuth token request failed: {exc}") from exc
    if token_response.status_code != 200:
        try:
            token_error = token_response.json().get("error", "")
        except (ValueError, AttributeError):
            token_error = ""
        if token_error == "invalid_grant":
            raise RuntimeError(
                "CodeLeaf email verification is temporarily unavailable because the Gmail authorization "
                "has expired or been revoked. The administrator must generate a new refresh token using "
                "the same Google OAuth client and update GOOGLE_REFRESH_TOKEN in Vercel."
            )
        if token_error == "invalid_client":
            raise RuntimeError(
                "CodeLeaf email verification is temporarily unavailable because the configured Google OAuth "
                "client credentials are invalid. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel."
            )
        raise RuntimeError(f"Gmail OAuth token request failed (HTTP {token_response.status_code}).")
    access_token = token_response.json().get("access_token")
    if not access_token:
        raise RuntimeError("Gmail OAuth token response did not contain an access token.")
    raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
    try:
        response = requests.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json={"raw": raw_message}, timeout=15,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"Gmail API request failed: {exc}") from exc
    if response.status_code not in {200, 201}:
        raise RuntimeError(f"Gmail API rejected the message ({response.status_code}): {response.text[:240]}")
    return True


def _send_verification_email(email, name, code):
    return _send_email_message(
        "Verify your CodeLeaf email", email,
        f"Hi {name},\n\nYour CodeLeaf verification code is {code}.\n"
        f"This code expires in {OTP_TTL_MINUTES} minutes.\n\nCodeLeaf Security",
    )


def _send_password_reset_email(email, name, token):
    base_url = os.getenv("APP_BASE_URL", "https://codexa-labs.vercel.app").strip().rstrip("/")
    reset_url = f"{base_url}/?reset={token}"
    return _send_email_message(
        "Reset your CodeLeaf password", email,
        f"Hi {name},\n\nWe received a request to reset your CodeLeaf password.\n"
        f"Open this link within 30 minutes to choose a new password:\n{reset_url}\n\n"
        "If you did not request this, you can safely ignore this email.\n\nCodeLeaf Security",
    )


def request_password_reset(email):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    email = _email(email)
    user = db.users.find_one({"email": email, "status": "active"})
    if not user:
        return True
    token = secrets.token_urlsafe(48)
    now = _now()
    db.password_resets.delete_many({"email": email})
    _send_password_reset_email(email, user.get("name", "there"), token)
    db.password_resets.insert_one({"email": email, "tokenHash": _otp_digest(email, token),
                                   "createdAt": now, "expiresAt": now + timedelta(minutes=30), "used": False})
    return True


def reset_password(token, new_password):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    if len(new_password or "") < 10:
        raise ValueError("Password must contain at least 10 characters.")
    token = str(token or "").strip()
    record = db.password_resets.find_one({"expiresAt": {"$gt": _now()}, "used": False})
    if not record or not secrets.compare_digest(record.get("tokenHash", ""), _otp_digest(record.get("email", ""), token)):
        raise ValueError("This password reset link is invalid or expired.")
    result = db.users.update_one({"email": record["email"], "status": "active"}, {"$set": {"passwordHash": generate_password_hash(new_password, method="scrypt"), "updatedAt": _now()}})
    if result.matched_count != 1:
        raise ValueError("This password reset link is invalid or expired.")
    db.password_resets.update_one({"_id": record["_id"]}, {"$set": {"used": True, "usedAt": _now()}})
    user = db.users.find_one({"email": record["email"]}, {"_id": 1})
    if user:
        db.sessions.delete_many({"userId": user["_id"]})
    return True


def issue_email_otp(user):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    email = _email(user.get("email"))
    code = f"{secrets.randbelow(1000000):06d}"
    now = _now()
    db.email_otps.delete_many({"email": email})
    _send_verification_email(email, user.get("name", "there"), code)
    db.email_otps.insert_one({"email": email, "codeHash": _otp_digest(email, code), "attempts": 0,
                              "createdAt": now, "expiresAt": now + timedelta(minutes=OTP_TTL_MINUTES)})


def create_pending_signup(name, email, password, college=""):
    """Send OTP first; persist signup data only in a temporary collection."""
    email = _email(email)
    name = str(name or "").strip()[:100]
    college = str(college or "").strip()[:180]
    if len(name) < 2 or "@" not in email or len(email) > 254:
        raise ValueError("Enter a valid name and email address.")
    if len(college) < 2:
        raise ValueError("College or university is required.")
    if len(password or "") < 10:
        raise ValueError("Password must contain at least 10 characters.")
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    init_indexes()
    if db.users.find_one({"email": email}):
        raise ValueError("An account with this email already exists.")
    code = f"{secrets.randbelow(1000000):06d}"
    _send_verification_email(email, name, code)
    remember_college(college)
    now = _now()
    db.pending_signups.replace_one(
        {"email": email},
        {"email": email, "name": name, "college": college, "passwordHash": generate_password_hash(password, method="scrypt"),
         "otpHash": _otp_digest(email, code), "attempts": 0, "createdAt": now,
         "expiresAt": now + timedelta(minutes=OTP_TTL_MINUTES)},
        upsert=True,
    )
    return {"email": email}


def resend_pending_signup_otp(email):
    db = _db()
    email = _email(email)
    pending = db.pending_signups.find_one({"email": email}) if db is not None else None
    if not pending:
        raise ValueError("No pending verification was found. Please create the account again.")
    code = f"{secrets.randbelow(1000000):06d}"
    _send_verification_email(email, pending.get("name", "there"), code)
    db.pending_signups.update_one({"_id": pending["_id"]}, {"$set": {
        "otpHash": _otp_digest(email, code), "attempts": 0,
        "expiresAt": _now() + timedelta(minutes=OTP_TTL_MINUTES),
    }})
    return True


def verify_pending_signup(email, code):
    db = _db()
    email = _email(email)
    pending = db.pending_signups.find_one({"email": email, "expiresAt": {"$gt": _now()}}) if db is not None else None
    if not pending or pending.get("attempts", 0) >= OTP_MAX_ATTEMPTS:
        raise ValueError("This verification code is expired or locked. Request a new code.")
    if not secrets.compare_digest(pending.get("otpHash", ""), _otp_digest(email, str(code or ""))):
        db.pending_signups.update_one({"_id": pending["_id"]}, {"$inc": {"attempts": 1}})
        raise ValueError("Incorrect verification code.")
    now = _now()
    user = {"email": email, "name": pending["name"], "college": pending.get("college", ""), "passwordHash": pending["passwordHash"],
            "providers": ["password"], "createdAt": now, "updatedAt": now,
            "status": "active", "emailVerified": True}
    try:
        result = db.users.insert_one(user)
    except Exception as exc:
        if "duplicate" in str(exc).lower():
            raise ValueError("An account with this email already exists.")
        raise
    user["_id"] = result.inserted_id
    db.pending_signups.delete_one({"_id": pending["_id"]})
    _event("signup", str(result.inserted_id), "password")
    return user


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
    if user and (not EMAIL_VERIFICATION_REQUIRED or user.get("emailVerified", False)):
        db.sessions.update_one({"_id": digest}, {"$set": {"lastSeenAt": _now()}})
        return _safe_user(user)
    db.sessions.delete_one({"_id": digest})
    session.pop("auth_session", None)
    return None


def logout():
    raw = session.pop("auth_session", None)
    db = _db()
    if raw and db is not None:
        db.sessions.delete_one({"_id": hashlib.sha256(raw.encode()).hexdigest()})
    session.clear()


def delete_account(user_id):
    """Permanently remove the account and its authentication records."""
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    user = db.users.find_one({"_id": user_id}, {"email": 1})
    result = db.users.delete_one({"_id": user_id})
    if not result.deleted_count:
        raise ValueError("Account not found.")
    for collection in (db.sessions, db.identities, db.email_otps, db.password_resets):
        collection.delete_many({"userId": user_id})
    if user and user.get("email"):
        db.pending_signups.delete_many({"email": user["email"]})
    session.pop("auth_session", None)
    session.clear()
    return True


def update_profile(user_id, updates):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    allowed = {"name", "avatar", "cover", "college", "phone", "bio"}
    clean = {key: str(updates.get(key) or "").strip()[:500 if key == "bio" else 180]
             for key in allowed if key in updates}
    if "name" in clean and len(clean["name"]) < 2:
        raise ValueError("Name must contain at least 2 characters.")
    if "linkedin" in clean and clean["linkedin"] and not clean["linkedin"].startswith(("https://", "http://")):
        raise ValueError("LinkedIn URL must start with https:// or http://.")
    if "avatar" in updates:
        avatar = str(updates.get("avatar") or "")
        if avatar and (not avatar.startswith("data:image/") or len(avatar) > 1_500_000):
            raise ValueError("Profile photo must be an image smaller than 1 MB.")
        clean["avatar"] = avatar
    if "cover" in updates:
        cover = str(updates.get("cover") or "")
        if cover and (not cover.startswith("data:image/") or len(cover) > 2_500_000):
            raise ValueError("Cover image must be an image smaller than 2 MB.")
        clean["cover"] = cover
    if "links" in updates:
        links = updates.get("links") if isinstance(updates.get("links"), list) else []
        clean["links"] = [{"label": str(item.get("label") or "Website")[:40], "url": str(item.get("url") or "")[:300]}
                           for item in links[:20] if isinstance(item, dict) and str(item.get("url") or "").startswith(("https://", "http://"))]
    if "preferences" in updates and isinstance(updates.get("preferences"), dict):
        prefs = updates["preferences"]
        clean["preferences"] = {
            "emailNotifications": bool(prefs.get("emailNotifications", True)),
            "assessmentReminders": bool(prefs.get("assessmentReminders", True)),
            "profileVisibility": "public" if prefs.get("profileVisibility") == "public" else "members",
        }
    if clean:
        if "college" in clean:
            if len(clean["college"]) < 2:
                raise ValueError("College or university is required.")
            remember_college(clean["college"])
        clean["updatedAt"] = _now()
        db.users.update_one({"_id": user_id}, {"$set": clean})
    return db.users.find_one({"_id": user_id, "status": "active"})


def change_password(user_id, current_password, new_password):
    db = _db()
    if db is None:
        raise RuntimeError("Authentication database is not configured.")
    user = db.users.find_one({"_id": user_id, "status": "active"})
    if not user or not user.get("passwordHash") or not check_password_hash(user["passwordHash"], current_password or ""):
        raise ValueError("Current password is incorrect.")
    if len(new_password or "") < 10:
        raise ValueError("New password must contain at least 10 characters.")
    db.users.update_one({"_id": user_id}, {"$set": {"passwordHash": generate_password_hash(new_password, method="scrypt"), "updatedAt": _now()}})


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
        g.user = user
        return view(*args, **kwargs)
    return wrapped


