"""One Graph submission, with persisted OAuth refresh and conservative outcomes."""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any, Literal
from uuid import UUID

import httpx

from app.services.automation_email import (
    DeliveryConfiguration,
    DeliveryResult,
    EmailMessage,
    SyntheticTestEmailMessage,
    _assemble_synthetic_test_content,
    delivery_configuration,
    normalize_email_address,
    sender_identity_binding,
)
from app.services.automation_email_credentials import (
    CredentialCodec,
    CredentialConflict,
    CredentialEnvelope,
    CredentialError,
    CredentialRepository,
    CredentialState,
)

GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail"
_TIMEOUT_SECONDS = 5.0
_PREPARED_MAX_AGE_SECONDS = 60.0


@dataclass(frozen=True)
class PreparedEmailSender:
    """Trusted, short-lived in-process handle. Never serialize or persist it."""

    envelope: CredentialEnvelope = field(repr=False)
    sender_binding: str
    _configuration: DeliveryConfiguration = field(repr=False)
    _prepared_at: float = field(repr=False)


class _BudgetExhausted(Exception):
    pass


def _finite_number(value: Any) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _remaining(deadline: float | None, *, database: bool = False) -> float:
    if deadline is None:
        return _TIMEOUT_SECONDS
    if not _finite_number(deadline):
        raise _BudgetExhausted
    now = time.monotonic()
    if not _finite_number(now):
        raise _BudgetExhausted
    remaining = deadline - now
    if (
        not _finite_number(remaining)
        or remaining <= 0
        or (database and remaining < _TIMEOUT_SECONDS)
    ):
        raise _BudgetExhausted
    return min(_TIMEOUT_SECONDS, remaining)


def _request_id(response: httpx.Response) -> str | None:
    value = response.headers.get("request-id", "")
    try:
        return str(UUID(value)) if len(value) == 36 else None
    except ValueError:
        return None


def _retry_after(response: httpx.Response) -> int:
    raw = response.headers.get("Retry-After", "")
    try:
        if re.fullmatch(r"[0-9]{1,10}", raw):
            seconds = int(raw)
        else:
            parsed = parsedate_to_datetime(raw)
            if parsed.tzinfo is None:
                raise ValueError
            seconds = math.ceil((parsed - datetime.now(UTC)).total_seconds())
        return max(1, min(3600, seconds))
    except (TypeError, ValueError, OverflowError):
        return 60


def _valid_message(message: EmailMessage) -> bool:
    if isinstance(message, SyntheticTestEmailMessage):
        try:
            content = _assemble_synthetic_test_content(message.subject, message.text_body)
        except ValueError:
            return False
        return (
            isinstance(message.html_body, str)
            and message.html_body == content.html_body
            and isinstance(message.attempt_id, str)
            and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", message.attempt_id) is not None
        )
    return (
        isinstance(message.subject, str)
        and bool(message.subject.strip())
        and len(message.subject) <= 200
        and not re.search(r"[\x00-\x1f\x7f-\x9f]", message.subject)
        and isinstance(message.html_body, str)
        and bool(message.html_body.strip())
        and len(message.html_body) <= 150000
        and isinstance(message.text_body, str)
        and bool(message.text_body.strip())
        and isinstance(message.attempt_id, str)
        and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", message.attempt_id) is not None
    )


def _not_submitted(
    outcome: Literal["retryable_failure", "permanent_failure"],
    error_code: str,
    *,
    scope: Literal[
        "sender_auth", "sender_transient", "message", "unclassified"
    ] = "sender_transient",
    revision: int | None = None,
    retry_after_seconds: int | None = None,
) -> DeliveryResult:
    return DeliveryResult(
        outcome,
        error_code,
        retry_after_seconds=retry_after_seconds,
        submission_evidence="not_submitted",
        failure_scope=scope,
        credential_revision=revision,
    )


def _close_client(client: httpx.Client) -> None:
    try:
        client.close()
    except Exception:  # noqa: BLE001, S110 - Never log credential-bearing client exceptions.
        # Cleanup cannot erase observed submission evidence.
        pass


def _preparation_is_current(prepared_at: float) -> bool:
    now = time.monotonic()
    return (
        _finite_number(prepared_at)
        and _finite_number(now)
        and 0 <= now - prepared_at < _PREPARED_MAX_AGE_SECONDS
    )


class MicrosoftGraphEmailTransport:
    def __init__(
        self,
        settings: Any,
        supabase_client: Any,
        *,
        client_factory: Callable[..., Any] | None = None,
    ):
        self._settings = settings
        self._supabase = supabase_client
        self._client_factory = client_factory or httpx.Client

    def _refresh(
        self,
        client: httpx.Client,
        config: DeliveryConfiguration,
        repository: CredentialRepository,
        state: CredentialState,
        revision: int,
        deadline: float | None,
    ) -> CredentialEnvelope | DeliveryResult:
        timeout = _remaining(deadline)
        try:
            with client.stream(
                "POST",
                f"https://login.microsoftonline.com/{config.tenant}/oauth2/v2.0/token",
                data={
                    "client_id": config.client_id,
                    "client_secret": config.client_secret,
                    "grant_type": "refresh_token",
                    "refresh_token": state.refresh_token,
                },
                timeout=timeout,
            ) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    _remaining(deadline)
                    if len(body) + len(chunk) > 131072:
                        return _not_submitted("retryable_failure", "token_refresh_invalid")
                    body.extend(chunk)
        except httpx.HTTPError:
            return _not_submitted("retryable_failure", "token_refresh_unavailable")
        if response.status_code == 429:
            return _not_submitted(
                "retryable_failure",
                "token_refresh_throttled",
                retry_after_seconds=_retry_after(response),
            )
        if response.status_code >= 500 or response.status_code == 408:
            return _not_submitted("retryable_failure", "token_refresh_unavailable")
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError, RecursionError):
            payload = None
        if response.status_code != 200:
            error = payload.get("error") if isinstance(payload, dict) else None
            if (
                isinstance(error, str)
                and error
                in {
                    "invalid_grant",
                    "interaction_required",
                    "consent_required",
                    "invalid_client",
                    "unauthorized_client",
                }
            ) or response.status_code in (401, 403):
                return _not_submitted(
                    "permanent_failure", "authentication_required", scope="sender_auth"
                )
            return _not_submitted(
                "permanent_failure", "token_refresh_rejected", scope="unclassified"
            )
        if not isinstance(payload, dict):
            return _not_submitted("retryable_failure", "token_refresh_invalid")
        expiry = payload.get("expires_in")
        token_type = payload.get("token_type")
        if (
            type(expiry) not in (int, float)
            or not 60 < expiry <= 172800
            or not math.isfinite(expiry)
            or not isinstance(token_type, str)
            or token_type.casefold() != "bearer"
        ):
            return _not_submitted("retryable_failure", "token_refresh_invalid")
        replacement = CredentialState(
            client_id=state.client_id,
            mailbox=state.mailbox,
            refresh_token=payload.get("refresh_token", state.refresh_token),
            access_token=payload.get("access_token"),
            expires_at=time.time() + expiry,
        )
        if not replacement.access_token:
            return _not_submitted("retryable_failure", "token_refresh_invalid")
        # A rotated token is never used before the encrypted CAS has succeeded.
        _remaining(deadline, database=True)
        try:
            return repository.save(replacement, revision)
        except CredentialConflict:
            _remaining(deadline, database=True)
            winner = repository.load()
            if (
                winner.revision > revision
                and winner.state is not None
                and winner.state.has_valid_access_token(time.time())
            ):
                return winner
            return _not_submitted("retryable_failure", "credential_refresh_conflict")

    def _configuration(self) -> DeliveryConfiguration | DeliveryResult:
        # Rechecked even when a caller constructs this transport directly.
        if (
            getattr(self._settings, "EMAIL_SEND_ENABLED", False) is not True
            or getattr(self._settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
        ):
            return _not_submitted("permanent_failure", "sending_disabled")
        try:
            return delivery_configuration(self._settings)
        except ValueError:
            return _not_submitted("permanent_failure", "setup_required")

    @staticmethod
    def _message_addresses(
        message: EmailMessage, config: DeliveryConfiguration
    ) -> tuple[str, str] | DeliveryResult:
        try:
            recipient = normalize_email_address(message.to_address)
            reply_to = normalize_email_address(message.reply_to)
        except ValueError:
            return _not_submitted("permanent_failure", "invalid_message", scope="message")
        if config.allowed_recipients and recipient not in config.allowed_recipients:
            return _not_submitted("permanent_failure", "recipient_not_allowed", scope="message")
        if not _valid_message(message):
            return _not_submitted("permanent_failure", "invalid_message", scope="message")
        return recipient, reply_to

    def prepare(self, *, deadline: float | None = None) -> PreparedEmailSender | DeliveryResult:
        """Load and, if needed, persist refreshed credentials before any durable begin."""
        config = self._configuration()
        if isinstance(config, DeliveryResult):
            return config
        prepared_at = time.monotonic()
        if not _preparation_is_current(prepared_at):
            return _not_submitted("retryable_failure", "credential_refresh_conflict")
        try:
            _remaining(deadline, database=True)
            codec = CredentialCodec(config.encryption_key, config.client_id, config.sender)
            repository = CredentialRepository(self._supabase, codec)
            envelope = repository.load()
            if envelope.state is None:
                return _not_submitted("permanent_failure", "setup_required")
            _remaining(deadline)
            if not envelope.state.has_valid_access_token(time.time()):
                client = self._client_factory(
                    timeout=_remaining(deadline), trust_env=False, follow_redirects=False
                )
                try:
                    refreshed = self._refresh(
                        client, config, repository, envelope.state, envelope.revision, deadline
                    )
                    if isinstance(refreshed, DeliveryResult):
                        return refreshed
                    envelope = refreshed
                finally:
                    _close_client(client)
            _remaining(deadline)
            if not _preparation_is_current(
                prepared_at
            ) or not envelope.state.has_valid_access_token(time.time()):
                return _not_submitted("retryable_failure", "credential_refresh_conflict")
            return PreparedEmailSender(
                envelope, sender_identity_binding(config), config, prepared_at
            )
        except _BudgetExhausted:
            return _not_submitted("retryable_failure", "send_budget_exhausted")
        except CredentialError as exc:
            if exc.code == "credential_store_unavailable":
                return _not_submitted("retryable_failure", "credential_store_unavailable")
            return _not_submitted(
                "permanent_failure", "authentication_required", scope="sender_auth"
            )
        except Exception:  # noqa: BLE001 - Keep the transport boundary secret-safe for all provider failures.
            return _not_submitted("retryable_failure", "provider_unavailable")

    def send_prepared(
        self, message: EmailMessage, prepared: PreparedEmailSender, *, deadline: float | None = None
    ) -> DeliveryResult:
        """Submit once with this exact envelope. Gate and begin ownership belong to the caller."""
        config = self._configuration()
        if isinstance(config, DeliveryResult):
            return config
        if (
            sender_identity_binding(config) != prepared.sender_binding
            or config.client_secret != prepared._configuration.client_secret
            or config.encryption_key != prepared._configuration.encryption_key
        ):
            return _not_submitted("permanent_failure", "setup_required")
        addresses = self._message_addresses(message, config)
        if isinstance(addresses, DeliveryResult):
            return addresses
        recipient, reply_to = addresses
        state = prepared.envelope.state
        if (
            not _preparation_is_current(prepared._prepared_at)
            or state is None
            or not state.has_valid_access_token(time.time())
        ):
            return _not_submitted("retryable_failure", "credential_refresh_conflict")
        revision = prepared.envelope.revision
        submission_started = False
        response = None
        try:
            client = self._client_factory(
                timeout=_remaining(deadline), trust_env=False, follow_redirects=False
            )
            try:
                timeout = _remaining(deadline)
                # A client factory can consume time too; recheck at the submission boundary.
                if not _preparation_is_current(
                    prepared._prepared_at
                ) or not state.has_valid_access_token(time.time()):
                    return _not_submitted("retryable_failure", "credential_refresh_conflict")
                submission_started = True
                with client.stream(
                    "POST",
                    GRAPH_SEND_URL,
                    headers={
                        "Authorization": "Bearer " + state.access_token,
                        "client-request-id": message.attempt_id,
                    },
                    json={
                        "message": {
                            "subject": message.subject,
                            "body": {"contentType": "HTML", "content": message.html_body},
                            "from": {
                                "emailAddress": {
                                    "address": config.sender,
                                    "name": config.sender_name,
                                }
                            },
                            "toRecipients": [{"emailAddress": {"address": recipient}}],
                            "replyTo": [{"emailAddress": {"address": reply_to}}],
                        },
                        "saveToSentItems": True,
                    },
                    timeout=timeout,
                ) as submitted_response:
                    # Headers establish the outcome. Do not load a sendMail response body.
                    response = submitted_response
            finally:
                _close_client(client)
        except _BudgetExhausted:
            if submission_started and response is None:
                return DeliveryResult(
                    "unknown",
                    "provider_submission_unknown",
                    submission_evidence="unknown",
                    failure_scope="unclassified",
                    credential_revision=revision,
                )
            if response is None:
                return _not_submitted("retryable_failure", "send_budget_exhausted")
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            if response is None:
                return _not_submitted(
                    "retryable_failure",
                    "provider_connection_failed" if submission_started else "provider_unavailable",
                    revision=revision if submission_started else None,
                )
        except Exception:  # noqa: BLE001 - Preserve observed headers and keep provider errors private.
            if response is None:
                if submission_started:
                    return DeliveryResult(
                        "unknown",
                        "provider_submission_unknown",
                        submission_evidence="unknown",
                        failure_scope="unclassified",
                        credential_revision=revision,
                    )
                return _not_submitted("retryable_failure", "provider_unavailable")
        request_id = _request_id(response)
        if response.status_code == 202:
            return DeliveryResult(
                "accepted",
                provider_request_id=request_id,
                submission_evidence="accepted",
                credential_revision=revision,
            )
        if response.status_code == 429:
            return DeliveryResult(
                "retryable_failure",
                "provider_throttled",
                request_id,
                _retry_after(response),
                "rejected",
                "sender_transient",
                revision,
            )
        if 400 <= response.status_code < 500 and response.status_code != 408:
            return DeliveryResult(
                "permanent_failure",
                "authentication_required" if response.status_code == 401 else "provider_rejected",
                request_id,
                submission_evidence="rejected",
                failure_scope="sender_auth"
                if response.status_code in (401, 403)
                else "unclassified",
                credential_revision=revision,
            )
        return DeliveryResult(
            "unknown",
            "provider_submission_unknown",
            request_id,
            submission_evidence="unknown",
            failure_scope="unclassified",
            credential_revision=revision,
        )

    def send(self, message: EmailMessage, *, deadline: float | None = None) -> DeliveryResult:
        # Legacy validation order: disabled/config, recipient/message, then credentials.
        config = self._configuration()
        if isinstance(config, DeliveryResult):
            return config
        addresses = self._message_addresses(message, config)
        if isinstance(addresses, DeliveryResult):
            return addresses
        prepared = self.prepare(deadline=deadline)
        if isinstance(prepared, DeliveryResult):
            return prepared
        return self.send_prepared(message, prepared, deadline=deadline)
