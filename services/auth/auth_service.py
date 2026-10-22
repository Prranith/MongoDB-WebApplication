"""Secure email/password authentication backed by MongoDB Atlas."""

import hashlib
import os
import secrets
import smtplib
import time
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
    db.pending_signups.create_index("expiresAt", expireAfterSeconds=0)
    db.pending_signups.create_index("email", unique=True)


def _otp_digest(email, code):
    secret = os.getenv("AUTH_SECRET_KEY", "").strip() or "development-only-secret"
    return hashlib.sha256(f"{secret}:{email}:{code}".encode()).hexdigest()


def _send_verification_email(email, name, code):
    host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
    port = int(os.getenv("SMTP_PORT", "465"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "").replace(" ", "").strip()
    sender = os.getenv("AUTH_EMAIL_FROM", username).strip()
    if not username or not password or not sender:
        if os.getenv("AUTH_EMAIL_DEV_MODE", "0").strip().lower() in {"1", "true", "yes"}:
            print(f"[auth] development email OTP for {email}: {code}")
            return True
        raise RuntimeError("Gmail SMTP is not configured. Set SMTP_USERNAME, SMTP_PASSWORD, and AUTH_EMAIL_FROM.")
    if "<" in sender and ">" in sender:
        sender = sender[sender.find("<") + 1:sender.rfind(">")].strip()
    message = EmailMessage()
    message["Subject"] = "Verify your CodeLeaf email"
    message["From"] = sender
    message["To"] = email
    message.set_content(
        f"Hi {name},\n\nYour CodeLeaf verification code is {code}.\n"
        f"This code expires in {OTP_TTL_MINUTES} minutes.\n\nCodeLeaf Security"
    )
    ports = [port] + ([465] if port == 587 else [587])
    failures = []
    for attempt_port in ports:
        try:
            if attempt_port == 465:
                with smtplib.SMTP_SSL(host, attempt_port, timeout=6) as smtp:
                    smtp.login(username, password)
                    smtp.send_message(message)
            else:
                with smtplib.SMTP(host, attempt_port, timeout=6) as smtp:
                    smtp.ehlo()
                    smtp.starttls()
                    smtp.ehlo()
                    smtp.login(username, password)
                    smtp.send_message(message)
            return True
        except (OSError, smtplib.SMTPException) as exc:
            failures.append(f"port {attempt_port}: {str(exc)[:160]}")
    raise RuntimeError(f"Gmail SMTP delivery failed ({'; '.join(failures)}). Verify the App Password and SMTP settings.")


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


def create_pending_signup(name, email, password):
    """Send OTP first; persist signup data only in a temporary collection."""
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
    code = f"{secrets.randbelow(1000000):06d}"
    _send_verification_email(email, name, code)
    now = _now()
    db.pending_signups.replace_one(
        {"email": email},
        {"email": email, "name": name, "passwordHash": generate_password_hash(password, method="scrypt"),
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
    user = {"email": email, "name": pending["name"], "passwordHash": pending["passwordHash"],
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


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"error": "Authentication required", "code": "AUTH_REQUIRED"}), 401
        g.user = user
        return view(*args, **kwargs)
    return wrapped


