"""Encrypted, revision-checked OAuth state. No plaintext credentials cross RPCs."""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.services.automation_email import normalize_email_address

PROVIDER_KEY = "microsoft_graph:primary"
_MAX_CIPHERTEXT = 131072


class CredentialError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class CredentialConflict(CredentialError):
    def __init__(self):
        super().__init__("credential_conflict")


@dataclass(frozen=True)
class CredentialState:
    client_id: str = field(repr=False)
    mailbox: str = field(repr=False)
    refresh_token: str = field(repr=False)
    access_token: str | None = field(default=None, repr=False)
    expires_at: float = 0

    def has_valid_access_token(self, now: float) -> bool:
        return bool(self.access_token) and self.expires_at > now + 60


@dataclass(frozen=True)
class CredentialEnvelope:
    revision: int
    state: CredentialState | None = field(repr=False)


class CredentialCodec:
    def __init__(self, encryption_key: str, client_id: str, mailbox: str):
        try:
            self._fernet = Fernet(encryption_key.encode("ascii"))
            self._mailbox = normalize_email_address(mailbox)
        except (AttributeError, UnicodeError, TypeError, ValueError):
            raise CredentialError("credential_configuration_invalid") from None
        self._client_id = client_id

    def _validate(self, payload: Any) -> CredentialState:
        if not isinstance(payload, dict) or set(payload) != {
            "version",
            "client_id",
            "mailbox",
            "refresh_token",
            "access_token",
            "expires_at",
        }:
            raise CredentialError("credential_state_invalid")
        if type(payload["version"]) is not int or payload["version"] != 1:
            raise CredentialError("credential_state_invalid")
        try:
            mailbox = normalize_email_address(payload["mailbox"])
        except (ValueError, TypeError):
            raise CredentialError("credential_state_invalid") from None
        if payload["client_id"] != self._client_id or mailbox != self._mailbox:
            raise CredentialError("credential_binding_mismatch")
        for name in ("refresh_token", "access_token"):
            token = payload[name]
            if name == "access_token" and token is None:
                continue
            if (
                not isinstance(token, str)
                or not token
                or len(token) > 32768
                or any(char.isspace() or ord(char) < 33 or ord(char) > 126 for char in token)
            ):
                raise CredentialError("credential_state_invalid")
        expiry = payload["expires_at"]
        if (
            type(expiry) not in (int, float)
            or not 0 <= expiry <= 253402300799
            or not math.isfinite(expiry)
        ):
            raise CredentialError("credential_state_invalid")
        return CredentialState(
            client_id=self._client_id,
            mailbox=mailbox,
            refresh_token=payload["refresh_token"],
            access_token=payload["access_token"],
            expires_at=float(expiry),
        )

    def encrypt(self, state: CredentialState) -> str:
        payload = {"version": 1, **asdict(state)}
        self._validate(payload)
        encrypted = self._fernet.encrypt(
            json.dumps(payload, separators=(",", ":")).encode()
        ).decode("ascii")
        if len(encrypted) > _MAX_CIPHERTEXT:
            raise CredentialError("credential_state_invalid")
        return encrypted

    def decrypt(self, encrypted_credentials: str) -> CredentialState:
        if (
            not isinstance(encrypted_credentials, str)
            or not 1 <= len(encrypted_credentials) <= _MAX_CIPHERTEXT
        ):
            raise CredentialError("credential_state_invalid")
        try:
            plaintext = self._fernet.decrypt(encrypted_credentials.encode("ascii"))
            payload = json.loads(plaintext)
        except (InvalidToken, UnicodeError, TypeError, ValueError, RecursionError):
            raise CredentialError("credential_state_invalid") from None
        return self._validate(payload)


class CredentialRepository:
    def __init__(self, supabase_client: Any, codec: CredentialCodec):
        self._client = supabase_client
        self._codec = codec

    def _call(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            result = self._client.rpc(name, params).execute()
        except Exception as exc:  # noqa: BLE001 - Provider exceptions may contain secret RPC data.
            if (
                getattr(exc, "code", None) == "P0001"
                and getattr(exc, "message", "") == "AUTOMATION_EMAIL_CREDENTIAL_CONFLICT"
            ):
                raise CredentialConflict() from None
            raise CredentialError("credential_store_unavailable") from None
        data = getattr(result, "data", None)
        if isinstance(data, list) and len(data) == 1:
            data = data[0]
        if not isinstance(data, dict) or data.get("provider_key") != PROVIDER_KEY:
            raise CredentialError("credential_store_unavailable")
        revision = data.get("revision")
        if type(revision) is not int or not 0 <= revision <= 2**63 - 1:
            raise CredentialError("credential_store_unavailable")
        if "encrypted_credentials" not in data:
            raise CredentialError("credential_store_unavailable")
        return data

    def load(self) -> CredentialEnvelope:
        data = self._call("get_automation_email_credential_v1", {"p_provider_key": PROVIDER_KEY})
        ciphertext = data["encrypted_credentials"]
        revision = data["revision"]
        if ciphertext is None and revision == 0:
            return CredentialEnvelope(0, None)
        if ciphertext is None or revision == 0:
            raise CredentialError("credential_store_unavailable")
        return CredentialEnvelope(revision, self._codec.decrypt(ciphertext))

    def save(self, state: CredentialState, expected_revision: int) -> CredentialEnvelope:
        if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
            raise CredentialError("credential_state_invalid")
        ciphertext = self._codec.encrypt(state)
        data = self._call(
            "save_automation_email_credential_v1",
            {
                "p_provider_key": PROVIDER_KEY,
                "p_expected_revision": expected_revision,
                "p_encrypted_credentials": ciphertext,
            },
        )
        if data["revision"] != expected_revision + 1 or data["encrypted_credentials"] != ciphertext:
            raise CredentialError("credential_store_unavailable")
        return CredentialEnvelope(data["revision"], state)
