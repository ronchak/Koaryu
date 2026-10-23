"""Transactional synthetic action engine. No Koaryu provider or environment imports."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import date
from pathlib import Path
from uuid import UUID, uuid4

ACTIONS = frozenset({"student_tag_add", "lead_followup_set"})
PURPOSE = "koaryu-synthetic-actions-v1"
PROPOSAL_SECONDS = 300
SESSION_SECONDS = 900
NO_CSRF = object()


class ActionError(ValueError):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def ensure(condition, status, message):
    if not condition:
        raise ActionError(status, message)


def identifier(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ActionError(422, "Use a valid UUID.") from None


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def normalized_arguments(action, value):
    ensure(action in ACTIONS, 422, "Unsupported predefined action.")
    if action == "student_tag_add":
        ensure(
            isinstance(value, str) and value.isprintable(), 422, "Use a printable tag."
        )
        value = value.strip()
        ensure(1 <= len(value) <= 64, 422, "Use a tag between 1 and 64 characters.")
        return {"tag": value}
    if value is not None:
        ensure(
            isinstance(value, str) and len(value) == 10,
            422,
            "Use an ISO calendar date or null.",
        )
        try:
            parsed = date.fromisoformat(value)
        except ValueError:
            raise ActionError(422, "Use an ISO calendar date or null.") from None
        ensure(parsed.isoformat() == value, 422, "Use an ISO calendar date or null.")
    return {"follow_up_date": value}


SCHEMA = """
CREATE TABLE metadata (purpose TEXT NOT NULL);
CREATE TABLE studios (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, active INTEGER NOT NULL);
CREATE TABLE actors (id TEXT NOT NULL, studio_id TEXT NOT NULL REFERENCES studios, role TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(id,studio_id));
CREATE TABLE owner_accounts (actor_id TEXT NOT NULL, studio_id TEXT NOT NULL, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, FOREIGN KEY(actor_id,studio_id) REFERENCES actors);
CREATE TABLE connections (id TEXT PRIMARY KEY, studio_id TEXT NOT NULL REFERENCES studios, actor_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, purpose TEXT NOT NULL, actions TEXT NOT NULL, revision INTEGER NOT NULL, session_nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL, FOREIGN KEY(actor_id,studio_id) REFERENCES actors);
CREATE TABLE owner_sessions (id_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, studio_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(actor_id,studio_id) REFERENCES actors);
CREATE TABLE students (id TEXT PRIMARY KEY, studio_id TEXT NOT NULL REFERENCES studios, name TEXT NOT NULL, tags TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL);
CREATE TABLE leads (id TEXT PRIMARY KEY, studio_id TEXT NOT NULL REFERENCES studios, name TEXT NOT NULL, follow_up_date TEXT, converted_student_id TEXT, revision INTEGER NOT NULL, deleted INTEGER NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections, studio_id TEXT NOT NULL REFERENCES studios, actor_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','executed')), approved_by TEXT, approved_at INTEGER, approved_digest TEXT);
CREATE TRIGGER immutable_proposal BEFORE UPDATE OF id,connection_id,studio_id,actor_id,kind,body,digest ON proposals BEGIN SELECT RAISE(ABORT,'Proposal contents are immutable'); END;
CREATE TABLE receipts (id TEXT PRIMARY KEY, proposal_id TEXT UNIQUE NOT NULL REFERENCES proposals, connection_id TEXT NOT NULL REFERENCES connections, request_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(connection_id,request_key));
CREATE TABLE audit (id TEXT PRIMARY KEY, receipt_id TEXT UNIQUE NOT NULL REFERENCES receipts, body TEXT NOT NULL);
"""


class Store:
    def __init__(self, path: Path, *, clock=time.time):
        self.path = Path(path).absolute()
        self.clock = clock
        ensure(
            self.path.is_file() and not self.path.is_symlink(),
            500,
            "Use the prototype's private state database.",
        )
        with closing(
            sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        ) as connection:
            row = connection.execute("SELECT purpose FROM metadata").fetchone()
            ensure(
                row and row[0] == PURPOSE,
                500,
                "This is not a synthetic action database.",
            )

    @classmethod
    def create(cls, directory: Path, *, clock=time.time):
        directory = Path(directory).absolute()
        directory.mkdir(mode=0o700, exist_ok=False)
        path = directory / "actions.sqlite3"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        with closing(sqlite3.connect(path)) as connection:
            connection.executescript(SCHEMA)
            connection.execute("INSERT INTO metadata VALUES (?)", (PURPOSE,))
            connection.commit()
        return cls(path, clock=clock)

    @contextmanager
    def transaction(self):
        connection = sqlite3.connect(self.path, isolation_level=None, timeout=2)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def now(self):
        return int(self.clock())

    def seed(self):
        """Create two completely synthetic studios. Called once by the demo/tests."""
        result = []
        with self.transaction() as db:
            ensure(
                db.execute("SELECT count(*) FROM studios").fetchone()[0] == 0,
                409,
                "The synthetic fixture is already initialized.",
            )
            for index, name in enumerate(["Cedar", "Maple"]):
                studio, actor, connection, student, lead = [
                    str(uuid4()) for _ in range(5)
                ]
                password, token, salt = (
                    secrets.token_urlsafe(24),
                    secrets.token_urlsafe(32),
                    secrets.token_hex(16),
                )
                username = f"owner-{index + 1}@example.invalid"
                hashed = hashlib.pbkdf2_hmac(
                    "sha256", password.encode(), bytes.fromhex(salt), 180_000
                ).hex()
                db.execute(
                    "INSERT INTO studios VALUES (?,?,1,1)",
                    (studio, f"Synthetic {name} Studio"),
                )
                db.execute(
                    "INSERT INTO actors VALUES (?,?,?,1)", (actor, studio, "admin")
                )
                db.execute(
                    "INSERT INTO owner_accounts VALUES (?,?,?,?,?)",
                    (actor, studio, username, salt, hashed),
                )
                db.execute(
                    "INSERT INTO connections VALUES (?,?,?,?,?,?,?,?,?,0)",
                    (
                        connection,
                        studio,
                        actor,
                        digest(token),
                        PURPOSE,
                        canonical(sorted(ACTIONS)),
                        1,
                        secrets.token_urlsafe(24),
                        self.now() + 3600,
                    ),
                )
                db.execute(
                    "INSERT INTO students VALUES (?,?,?,?,1,0)",
                    (student, studio, f"{name} Example Student", canonical(["youth"])),
                )
                db.execute(
                    "INSERT INTO leads VALUES (?,?,?,?,NULL,1,0)",
                    (lead, studio, f"{name} Example Lead", "2026-10-20"),
                )
                result.append(
                    {
                        "studio_id": studio,
                        "actor_id": actor,
                        "connection_id": connection,
                        "student_id": student,
                        "lead_id": lead,
                        "username": username,
                        "password": password,
                        "assistant_token": token,
                    }
                )
        return result

    def _member(self, db, actor, studio):
        row = db.execute(
            "SELECT actors.role,actors.active,studios.enabled,studios.active AS studio_active FROM actors JOIN studios ON studios.id=actors.studio_id WHERE actors.id=? AND actors.studio_id=?",
            (actor, studio),
        ).fetchone()
        ensure(
            row
            and row["active"]
            and row["role"] == "admin"
            and row["enabled"]
            and row["studio_active"],
            403,
            "Current studio action access is unavailable.",
        )

    def _connection(self, db, row, action=None):
        ensure(
            row
            and row["purpose"] == PURPOSE
            and not row["revoked"]
            and row["expires_at"] > self.now(),
            401,
            "Assistant action access is unavailable.",
        )
        self._member(db, row["actor_id"], row["studio_id"])
        allowed = json.loads(row["actions"])
        ensure(
            isinstance(allowed, list) and bool(allowed) and set(allowed) <= ACTIONS,
            403,
            "Action capability is unavailable.",
        )
        if action:
            ensure(action in allowed, 403, "Action capability is unavailable.")
        return row

    def _token(self, db, token, action=None):
        ensure(
            isinstance(token, str) and 20 <= len(token) <= 128,
            401,
            "Assistant action access is unavailable.",
        )
        row = db.execute(
            "SELECT * FROM connections WHERE token_hash=?", (digest(token),)
        ).fetchone()
        return self._connection(db, row, action)

    def authorize(self, token):
        with self.transaction() as db:
            row = self._token(db, token)
            return {
                "connection_id": row["id"],
                "studio_id": row["studio_id"],
                "actor_id": row["actor_id"],
            }

    def _owner(self, db, session, csrf=NO_CSRF):
        ensure(
            isinstance(session, str) and 20 <= len(session) <= 128,
            401,
            "Sign in as the synthetic owner.",
        )
        row = db.execute(
            "SELECT * FROM owner_sessions WHERE id_hash=?", (digest(session),)
        ).fetchone()
        ensure(
            row and row["expires_at"] > self.now(),
            401,
            "Sign in as the synthetic owner.",
        )
        self._member(db, row["actor_id"], row["studio_id"])
        if csrf is not NO_CSRF:
            ensure(
                isinstance(csrf, str)
                and hmac.compare_digest(row["csrf"].encode(), csrf.encode()),
                403,
                "Owner confirmation is unavailable. Reload the page.",
            )
        return row

    def login(self, username, password):
        ensure(
            isinstance(username, str)
            and len(username) <= 200
            and isinstance(password, str)
            and len(password) <= 200,
            401,
            "Invalid synthetic owner sign-in.",
        )
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM owner_accounts WHERE username=?", (username,)
            ).fetchone()
            salt = row["salt"] if row else "00" * 16
            hashed = hashlib.pbkdf2_hmac(
                "sha256", password.encode(), bytes.fromhex(salt), 180_000
            ).hex()
            ensure(
                row and hmac.compare_digest(hashed, row["password_hash"]),
                401,
                "Invalid synthetic owner sign-in.",
            )
            self._member(db, row["actor_id"], row["studio_id"])
            session, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            db.execute(
                "INSERT INTO owner_sessions VALUES (?,?,?,?,?)",
                (
                    digest(session),
                    row["actor_id"],
                    row["studio_id"],
                    csrf,
                    self.now() + SESSION_SECONDS,
                ),
            )
            return {"session": session, "csrf": csrf}

    def _target(self, db, connection, action, target_id):
        table = "students" if action == "student_tag_add" else "leads"
        # Table is chosen only by our closed action mapping; values are parameters.
        row = db.execute(
            f"SELECT * FROM {table} WHERE id=? AND studio_id=? AND deleted=0",
            (target_id, connection["studio_id"]),
        ).fetchone()
        ensure(row, 404, "Target is unavailable in this studio.")
        if action == "lead_followup_set":
            ensure(
                row["converted_student_id"] is None,
                409,
                "Converted leads cannot use this action.",
            )
        return row

    def _values(self, target, action, arguments):
        if action == "student_tag_add":
            tags = json.loads(target["tags"])
            ensure(
                isinstance(tags, list) and all(isinstance(tag, str) for tag in tags),
                409,
                "Target data is unavailable.",
            )
            before = {"tags": tags}
            after = {
                "tags": tags
                if arguments["tag"] in tags
                else sorted(set(tags) | {arguments["tag"]})
            }
        else:
            before = {"follow_up_date": target["follow_up_date"]}
            after = arguments
        return before, after

    def preview(self, token, action, target_id, value):
        target_id = identifier(target_id)
        arguments = normalized_arguments(action, value)
        with self.transaction() as db:
            connection = self._token(db, token, action)
            target = self._target(db, connection, action, target_id)
            before, after = self._values(target, action, arguments)
            proposal_id = str(uuid4())
            body = {
                "version": 1,
                "proposal_id": proposal_id,
                "connection_id": connection["id"],
                "studio_id": connection["studio_id"],
                "actor_id": connection["actor_id"],
                "action": action,
                "target_id": target_id,
                "target_name": target["name"],
                "arguments": arguments,
                "before": before,
                "after": after,
                "target_version": target["revision"],
                "grant_version": connection["revision"],
                "session_nonce": connection["session_nonce"],
                "created_at": self.now(),
                "expires_at": min(
                    self.now() + PROPOSAL_SECONDS, connection["expires_at"]
                ),
            }
            serialized = canonical(body)
            checksum = digest(serialized)
            db.execute(
                "INSERT INTO proposals VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL,NULL)",
                (
                    proposal_id,
                    connection["id"],
                    connection["studio_id"],
                    connection["actor_id"],
                    action,
                    serialized,
                    checksum,
                ),
            )
            return self._public_proposal(
                db.execute(
                    "SELECT * FROM proposals WHERE id=?", (proposal_id,)
                ).fetchone()
            )

    def _public_proposal(self, proposal):
        body = json.loads(proposal["body"])
        # Session/generation remain an internal binding, not model credentials.
        return {
            key: body[key]
            for key in [
                "proposal_id",
                "action",
                "target_id",
                "target_name",
                "before",
                "after",
                "target_version",
                "expires_at",
            ]
        } | {
            "digest": proposal["digest"],
            "status": proposal["status"],
            "change_required": body["before"] != body["after"],
        }

    def _binding(self, connection, body):
        ensure(
            body["connection_id"] == connection["id"]
            and body["actor_id"] == connection["actor_id"]
            and body["studio_id"] == connection["studio_id"]
            and body["grant_version"] == connection["revision"]
            and body["session_nonce"] == connection["session_nonce"],
            409,
            "Connection access changed. Create a new preview.",
        )

    def _fresh(self, db, connection, proposal):
        body = json.loads(proposal["body"])
        ensure(
            hmac.compare_digest(digest(canonical(body)), proposal["digest"]),
            409,
            "The proposal is invalid. Create a new preview.",
        )
        ensure(
            body["expires_at"] > self.now(),
            409,
            "The proposal expired. Create a new preview.",
        )
        self._binding(connection, body)
        target = self._target(db, connection, proposal["kind"], body["target_id"])
        before, after = self._values(target, proposal["kind"], body["arguments"])
        ensure(
            target["revision"] == body["target_version"]
            and before == body["before"]
            and after == body["after"],
            409,
            "The target changed. Create a new preview.",
        )
        return body, target

    def _owner_proposal(self, db, proposal):
        result = self._public_proposal(proposal)
        result["reviewable"] = False
        if proposal["status"] in {"pending", "approved"}:
            try:
                connection = self._connection(
                    db,
                    db.execute(
                        "SELECT * FROM connections WHERE id=?",
                        (proposal["connection_id"],),
                    ).fetchone(),
                    proposal["kind"],
                )
                self._fresh(db, connection, proposal)
                result["reviewable"] = True
            except ActionError as error:
                result["notice"] = str(error)
        return result

    def owner_view(self, session, proposal_id=None):
        with self.transaction() as db:
            owner = self._owner(db, session)
            parameters = (owner["actor_id"], owner["studio_id"])
            if proposal_id is not None:
                rows = db.execute(
                    "SELECT * FROM proposals WHERE id=? AND actor_id=? AND studio_id=?",
                    (identifier(proposal_id), *parameters),
                ).fetchall()
                ensure(rows, 404, "Proposal is unavailable.")
            else:
                rows = db.execute(
                    "SELECT * FROM proposals WHERE actor_id=? AND studio_id=? ORDER BY rowid DESC LIMIT 100",
                    parameters,
                ).fetchall()
            connections = db.execute(
                "SELECT id,revoked,expires_at FROM connections WHERE actor_id=? AND studio_id=?",
                parameters,
            ).fetchall()
            studio = db.execute(
                "SELECT name FROM studios WHERE id=?", (owner["studio_id"],)
            ).fetchone()
            receipts = db.execute(
                "SELECT receipts.body FROM receipts JOIN proposals ON proposals.id=receipts.proposal_id WHERE proposals.actor_id=? AND proposals.studio_id=? ORDER BY receipts.rowid DESC LIMIT 100",
                parameters,
            ).fetchall()
            return {
                "studio_name": studio["name"],
                "csrf": owner["csrf"],
                "proposals": [self._owner_proposal(db, row) for row in rows],
                "connections": [dict(row) for row in connections],
                "receipts": [json.loads(row["body"]) for row in receipts],
            }

    def decide(self, session, csrf, proposal_id, expected_digest, decision):
        proposal_id = identifier(proposal_id)
        ensure(decision in {"approve", "deny"}, 422, "Choose Approve or Deny.")
        ensure(
            isinstance(expected_digest, str)
            and re.fullmatch(r"[0-9a-f]{64}", expected_digest),
            422,
            "Use the displayed proposal digest.",
        )
        with self.transaction() as db:
            owner = self._owner(db, session, csrf)
            proposal = db.execute(
                "SELECT * FROM proposals WHERE id=? AND actor_id=? AND studio_id=?",
                (proposal_id, owner["actor_id"], owner["studio_id"]),
            ).fetchone()
            ensure(proposal, 404, "Proposal is unavailable.")
            ensure(
                proposal["status"] == "pending",
                409,
                "This proposal already has a decision.",
            )
            ensure(
                hmac.compare_digest(proposal["digest"], expected_digest),
                409,
                "The reviewed proposal changed. Reload the page.",
            )
            if decision == "approve":
                connection = self._connection(
                    db,
                    db.execute(
                        "SELECT * FROM connections WHERE id=?",
                        (proposal["connection_id"],),
                    ).fetchone(),
                    proposal["kind"],
                )
                self._fresh(db, connection, proposal)
            db.execute(
                "UPDATE proposals SET status=?,approved_by=?,approved_at=?,approved_digest=? WHERE id=?",
                (
                    "approved" if decision == "approve" else "denied",
                    owner["actor_id"],
                    self.now(),
                    expected_digest,
                    proposal_id,
                ),
            )
            return {
                "proposal_id": proposal_id,
                "status": "approved" if decision == "approve" else "denied",
            }

    def revoke(self, session, csrf, connection_id):
        with self.transaction() as db:
            owner = self._owner(db, session, csrf)
            row = db.execute(
                "UPDATE connections SET revoked=1,revision=revision+1 WHERE id=? AND actor_id=? AND studio_id=? RETURNING id",
                (identifier(connection_id), owner["actor_id"], owner["studio_id"]),
            ).fetchone()
            ensure(row, 404, "Connection is unavailable.")
            return {"status": "revoked"}

    def _after_domain_change(self):
        """Fault-injection seam for the transactional rollback test; no HTTP input selects it."""

    def execute(self, token, action, proposal_id, request_key):
        ensure(action in ACTIONS, 422, "Unsupported predefined action.")
        proposal_id, request_key = identifier(proposal_id), identifier(request_key)
        with self.transaction() as db:
            connection = self._token(db, token, action)
            previous = db.execute(
                "SELECT * FROM receipts WHERE connection_id=? AND request_key=?",
                (connection["id"], request_key),
            ).fetchone()
            if previous:
                receipt = json.loads(previous["body"])
                ensure(
                    previous["proposal_id"] == proposal_id
                    and receipt["action"] == action,
                    409,
                    "Retry identity belongs to another request.",
                )
                original = db.execute(
                    "SELECT body FROM proposals WHERE id=? AND connection_id=?",
                    (proposal_id, connection["id"]),
                ).fetchone()
                ensure(original, 409, "The execution receipt is unavailable.")
                self._binding(connection, json.loads(original["body"]))
                return receipt | {"replayed": True}
            proposal = db.execute(
                "SELECT * FROM proposals WHERE id=? AND connection_id=? AND actor_id=? AND studio_id=?",
                (
                    proposal_id,
                    connection["id"],
                    connection["actor_id"],
                    connection["studio_id"],
                ),
            ).fetchone()
            ensure(proposal, 404, "Proposal is unavailable.")
            ensure(
                proposal["kind"] == action, 409, "Use the proposal's predefined action."
            )
            ensure(
                proposal["status"] == "approved"
                and proposal["approved_by"] == connection["actor_id"]
                and hmac.compare_digest(
                    proposal["approved_digest"] or "", proposal["digest"]
                ),
                409,
                "Owner approval is required or this proposal was already used.",
            )
            body, target = self._fresh(db, connection, proposal)
            changed = body["before"] != body["after"]
            if changed:
                if action == "student_tag_add":
                    cursor = db.execute(
                        "UPDATE students SET tags=?,revision=revision+1 WHERE id=? AND studio_id=? AND revision=? AND deleted=0",
                        (
                            canonical(body["after"]["tags"]),
                            target["id"],
                            connection["studio_id"],
                            body["target_version"],
                        ),
                    )
                else:
                    cursor = db.execute(
                        "UPDATE leads SET follow_up_date=?,revision=revision+1 WHERE id=? AND studio_id=? AND revision=? AND deleted=0 AND converted_student_id IS NULL",
                        (
                            body["after"]["follow_up_date"],
                            target["id"],
                            connection["studio_id"],
                            body["target_version"],
                        ),
                    )
                ensure(
                    cursor.rowcount == 1,
                    409,
                    "The target changed. Create a new preview.",
                )
                self._after_domain_change()
            self._connection(db, connection, action)
            ensure(
                body["expires_at"] > self.now(),
                409,
                "The proposal expired. Create a new preview.",
            )
            receipt_id = str(uuid4())
            receipt = {
                "receipt_id": receipt_id,
                "proposal_id": proposal_id,
                "action": action,
                "target_id": body["target_id"],
                "studio_id": connection["studio_id"],
                "connection_id": connection["id"],
                "approved_by": proposal["approved_by"],
                "proposal_digest": proposal["digest"],
                "before": body["before"],
                "after": body["after"],
                "target_version": target["revision"] + int(changed),
                "outcome": "applied" if changed else "no_change",
                "executed_at": self.now(),
            }
            serialized = canonical(receipt)
            db.execute(
                "INSERT INTO receipts VALUES (?,?,?,?,?)",
                (receipt_id, proposal_id, connection["id"], request_key, serialized),
            )
            db.execute(
                "INSERT INTO audit VALUES (?,?,?)",
                (str(uuid4()), receipt_id, serialized),
            )
            db.execute(
                "UPDATE proposals SET status='executed' WHERE id=?", (proposal_id,)
            )
            return receipt | {"replayed": False}
