"""One Graph submission, with persisted OAuth refresh and conservative outcomes."""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from uuid import UUID

import httpx

from app.services.automation_email import (
    DeliveryConfiguration,
    DeliveryResult,
    EmailMessage,
    delivery_configuration,
    normalize_email_address,
)
from app.services.automation_email_credentials import (
    CredentialCodec,
    CredentialConflict,
    CredentialError,
    CredentialRepository,
    CredentialState,
)

GRAPH_SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail"
_TIMEOUT_SECONDS = 5.0


class _BudgetExhausted(Exception):
    pass


def _remaining(deadline: float | None, *, database: bool = False) -> float:
    if deadline is None:
        return _TIMEOUT_SECONDS
    if not math.isfinite(deadline):
        raise _BudgetExhausted
    remaining = deadline - time.monotonic()
    if remaining <= 0 or (database and remaining < _TIMEOUT_SECONDS):
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
    ) -> CredentialState | DeliveryResult:
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
                        return DeliveryResult("retryable_failure", "token_refresh_invalid")
                    body.extend(chunk)
        except httpx.HTTPError:
            return DeliveryResult("retryable_failure", "token_refresh_unavailable")
        if response.status_code == 429:
            return DeliveryResult(
                "retryable_failure",
                "token_refresh_throttled",
                retry_after_seconds=_retry_after(response),
            )
        if response.status_code >= 500 or response.status_code == 408:
            return DeliveryResult("retryable_failure", "token_refresh_unavailable")
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
                return DeliveryResult("permanent_failure", "authentication_required")
            return DeliveryResult("permanent_failure", "token_refresh_rejected")
        if not isinstance(payload, dict):
            return DeliveryResult("retryable_failure", "token_refresh_invalid")
        expiry = payload.get("expires_in")
        token_type = payload.get("token_type")
        if (
            type(expiry) not in (int, float)
            or not 60 < expiry <= 172800
            or not math.isfinite(expiry)
            or not isinstance(token_type, str)
            or token_type.casefold() != "bearer"
        ):
            return DeliveryResult("retryable_failure", "token_refresh_invalid")
        replacement = CredentialState(
            client_id=state.client_id,
            mailbox=state.mailbox,
            refresh_token=payload.get("refresh_token", state.refresh_token),
            access_token=payload.get("access_token"),
            expires_at=time.time() + expiry,
        )
        if not replacement.access_token:
            return DeliveryResult("retryable_failure", "token_refresh_invalid")
        # A rotated token is never used before the encrypted CAS has succeeded.
        _remaining(deadline, database=True)
        try:
            return repository.save(replacement, revision).state
        except CredentialConflict:
            _remaining(deadline, database=True)
            winner = repository.load()
            if (
                winner.revision > revision
                and winner.state is not None
                and winner.state.has_valid_access_token(time.time())
            ):
                return winner.state
            return DeliveryResult("retryable_failure", "credential_refresh_conflict")

    def send(self, message: EmailMessage, *, deadline: float | None = None) -> DeliveryResult:
        # Rechecked on every send even when a caller constructs this transport directly.
        if (
            getattr(self._settings, "EMAIL_SEND_ENABLED", False) is not True
            or getattr(self._settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
        ):
            return DeliveryResult("permanent_failure", "sending_disabled")
        try:
            config = delivery_configuration(self._settings)
        except ValueError:
            return DeliveryResult("permanent_failure", "setup_required")
        try:
            recipient = normalize_email_address(message.to_address)
            reply_to = normalize_email_address(message.reply_to)
        except ValueError:
            return DeliveryResult("permanent_failure", "invalid_message")
        if config.allowed_recipients and recipient not in config.allowed_recipients:
            return DeliveryResult("permanent_failure", "recipient_not_allowed")
        if not _valid_message(message):
            return DeliveryResult("permanent_failure", "invalid_message")
        submission_started = False
        try:
            _remaining(deadline, database=True)
            codec = CredentialCodec(config.encryption_key, config.client_id, config.sender)
            repository = CredentialRepository(self._supabase, codec)
            envelope = repository.load()
            if envelope.state is None:
                return DeliveryResult("permanent_failure", "setup_required")
            state = envelope.state
            client = self._client_factory(
                timeout=_remaining(deadline), trust_env=False, follow_redirects=False
            )
            try:
                if not state.has_valid_access_token(time.time()):
                    refreshed = self._refresh(
                        client, config, repository, state, envelope.revision, deadline
                    )
                    if isinstance(refreshed, DeliveryResult):
                        return refreshed
                    state = refreshed
                timeout = _remaining(deadline)
                response = None
                try:
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
                except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
                    if response is None:
                        return DeliveryResult("retryable_failure", "provider_connection_failed")
                except Exception:  # noqa: BLE001 - Preserve acceptance evidence without exposing provider errors.
                    if response is None:
                        return DeliveryResult("unknown", "provider_submission_unknown")
            finally:
                try:
                    client.close()
                except Exception:  # noqa: BLE001, S110 - Never log credential-bearing client exceptions.
                    # Cleanup cannot erase an observed submission result or expose request data.
                    pass
        except _BudgetExhausted:
            return DeliveryResult("retryable_failure", "send_budget_exhausted")
        except CredentialError as exc:
            if exc.code == "credential_store_unavailable":
                return DeliveryResult("retryable_failure", "credential_store_unavailable")
            return DeliveryResult("permanent_failure", "authentication_required")
        except Exception:  # noqa: BLE001 - Keep the transport boundary secret-safe for all provider failures.
            return (
                DeliveryResult("unknown", "provider_submission_unknown")
                if submission_started
                else DeliveryResult("retryable_failure", "provider_unavailable")
            )
        request_id = _request_id(response)
        if response.status_code == 202:
            return DeliveryResult("accepted", provider_request_id=request_id)
        if response.status_code == 429:
            return DeliveryResult(
                "retryable_failure", "provider_throttled", request_id, _retry_after(response)
            )
        if 400 <= response.status_code < 500 and response.status_code != 408:
            return DeliveryResult(
                "permanent_failure",
                "authentication_required" if response.status_code == 401 else "provider_rejected",
                request_id,
            )
        return DeliveryResult("unknown", "provider_submission_unknown", request_id)
