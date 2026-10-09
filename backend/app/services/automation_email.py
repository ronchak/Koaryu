"""Provider-neutral automation messages, rendering, and delivery readiness."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from html import escape
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit
from uuid import UUID

DEFAULT_MISSED_CLASS_SUBJECT = "We miss seeing {{student_first_name}} at {{studio_name}}"
DEFAULT_MISSED_CLASS_BODY = (
    "Hello,\n\nWe have missed seeing {{student_first_name}} at {{studio_name}}. "
    "Reply if we can help with getting back to class or updating our records.\n\n{{studio_name}}"
)
APPROVED_TEST_RECIPIENT = "koaryu@outlook.com"
_TOKEN = re.compile(r"\{\{(student_first_name|studio_name|days_absent)\}\}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_BODY_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_SYNTHETIC_SUBJECT_PREFIX = "[Test] "
_SYNTHETIC_BODY_PREFIX = "Synthetic automation test. Sample data only.\n\n"


@dataclass(frozen=True)
class EmailContent:
    subject: str = field(repr=False)
    text_body: str = field(repr=False)
    html_body: str = field(repr=False)


@dataclass(frozen=True)
class EmailMessage:
    to_address: str = field(repr=False)
    subject: str = field(repr=False)
    text_body: str = field(repr=False)
    html_body: str = field(repr=False)
    reply_to: str = field(repr=False)
    attempt_id: str


@dataclass(frozen=True)
class SyntheticTestEmailMessage(EmailMessage):
    """Fixed synthetic content profile. This type grants no delivery authority."""


@dataclass(frozen=True)
class DeliveryResult:
    outcome: Literal["accepted", "retryable_failure", "permanent_failure", "unknown"]
    error_code: str | None = None
    provider_request_id: str | None = None
    retry_after_seconds: int | None = None
    submission_evidence: Literal["not_submitted", "rejected", "accepted", "unknown"] | None = None
    failure_scope: Literal["sender_auth", "sender_transient", "message", "unclassified"] | None = (
        None
    )
    credential_revision: int | None = None

    def __post_init__(self) -> None:
        if self.submission_evidence is not None and (
            not isinstance(self.submission_evidence, str)
            or self.submission_evidence not in {"not_submitted", "rejected", "accepted", "unknown"}
        ):
            raise ValueError("invalid_submission_evidence")
        if self.failure_scope is not None and (
            not isinstance(self.failure_scope, str)
            or self.failure_scope
            not in {"sender_auth", "sender_transient", "message", "unclassified"}
        ):
            raise ValueError("invalid_failure_scope")
        if self.credential_revision is not None and (
            type(self.credential_revision) is not int or self.credential_revision <= 0
        ):
            raise ValueError("invalid_credential_revision")
        # Reject contradictions without rewriting the legacy outcome or error fields.
        if (
            (self.outcome == "unknown" and self.submission_evidence not in {None, "unknown"})
            or (self.submission_evidence == "unknown" and self.outcome != "unknown")
            or (self.outcome == "unknown" and self.failure_scope not in {None, "unclassified"})
            or (self.submission_evidence == "accepted" and self.outcome != "accepted")
            or (
                self.outcome == "accepted"
                and (
                    self.submission_evidence not in {None, "accepted"}
                    or self.failure_scope is not None
                )
            )
            or (self.failure_scope == "sender_auth" and self.outcome != "permanent_failure")
        ):
            raise ValueError("inconsistent_delivery_evidence")


class EmailTransport(Protocol):
    def send(self, message: EmailMessage, *, deadline: float | None = None) -> DeliveryResult: ...


def normalize_email_address(value: str) -> str:
    """One plain mailbox only, normalized identically for allowlist comparisons."""
    if not isinstance(value, str) or not value.isascii() or _CONTROL.search(value):
        raise ValueError("invalid_email_address")
    value = value.strip(" ")
    if len(value) > 254 or value.count("@") != 1:
        raise ValueError("invalid_email_address")
    local, domain = value.split("@")
    labels = domain.split(".")
    if (
        not 1 <= len(local) <= 64
        or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+", local)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
        or len(labels) < 2
        or any(
            not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in labels
        )
    ):
        raise ValueError("invalid_email_address")
    return value.casefold()


def _safe_https_url(value: str, *, allow_fragment: bool = False) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 2048
        or any(char.isspace() for char in value)
        or _CONTROL.search(value)
        or "\\" in value
    ):
        raise ValueError("invalid_email_url")
    try:
        parts = urlsplit(value)
        host = parts.hostname
        if (
            parts.scheme != "https"
            or not host
            or parts.username is not None
            or parts.password is not None
            or (
                parts.fragment
                and (
                    not allow_fragment or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", parts.fragment)
                )
            )
            or parts.port not in (None, 443)
            or host == "localhost"
            or host.endswith(".localhost")
        ):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if "." not in host or not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
                raise ValueError
        else:
            if not address.is_global:
                raise ValueError
    except (TypeError, ValueError):
        raise ValueError("invalid_email_url") from None
    return value


def validate_public_api_url(value: str) -> str:
    value = _safe_https_url(value)
    parts = urlsplit(value)
    if parts.query or parts.path != "/api/v1":
        raise ValueError("invalid_email_url")
    return value


def validate_missed_class_templates(subject_template: str, body_template: str) -> None:
    for template, limit in ((subject_template, 200), (body_template, 5000)):
        if not isinstance(template, str) or not template.strip() or len(template) > limit:
            raise ValueError("invalid_email_template")
        # Removing recognized tokens leaves every malformed or unknown brace behind.
        residue = _TOKEN.sub("", template)
        if "{" in residue or "}" in residue or _BODY_CONTROL.search(template):
            raise ValueError("invalid_email_template")
    if _CONTROL.search(subject_template) or "\r" in body_template:
        raise ValueError("invalid_email_template")


def render_missed_class_email(
    subject_template: str,
    body_template: str,
    context: Mapping[str, Any],
    unsubscribe_url: str | None = None,
) -> EmailContent:
    validate_missed_class_templates(subject_template, body_template)
    values: dict[str, str] = {}
    for name in {match.group(1) for match in _TOKEN.finditer(subject_template + body_template)}:
        value = context.get(name)
        if value is None or isinstance(value, (dict, list, tuple, set)):
            raise ValueError("invalid_email_context")
        value = str(value)
        if not value.strip() or _CONTROL.search(value) or len(value) > 5000:
            raise ValueError("invalid_email_context")
        values[name] = value
    # re.sub visits template tokens once. Substituted names are never interpreted as templates.
    subject = _TOKEN.sub(lambda match: values[match.group(1)], subject_template)
    body = _TOKEN.sub(lambda match: values[match.group(1)], body_template)
    return assemble_plain_text_email(subject, body, unsubscribe_url)


def _validate_plain_text_email(subject: str, body: str) -> None:
    if (
        not isinstance(subject, str)
        or not subject.strip()
        or len(subject) > 200
        or _CONTROL.search(subject)
        or not isinstance(body, str)
        or not body.strip()
        or len(body) > 20000
        or _BODY_CONTROL.search(body)
        or "\r" in body
    ):
        raise ValueError("invalid_email_context")


def _plain_text_html(body: str) -> str:
    return '<div style="white-space: pre-wrap">' + escape(body) + "</div>"


def assemble_plain_text_email(
    subject: str, body: str, unsubscribe_url: str | None = None
) -> EmailContent:
    """Validate rendered text, escape it, and append the existing optional footer."""
    _validate_plain_text_email(subject, body)
    html = _plain_text_html(body)
    if unsubscribe_url is not None:
        url = _safe_https_url(unsubscribe_url, allow_fragment=True)
        body += "\n\nUnsubscribe from this studio's automation emails: " + url
        html += (
            '<p><a href="'
            + escape(url, quote=True)
            + "\">Unsubscribe from this studio's automation emails</a></p>"
        )
    return EmailContent(subject=subject, text_body=body, html_body=html)


def _assemble_synthetic_test_content(subject: str, body: str) -> EmailContent:
    """Validate the closed labeled profile used by assembly and transport."""
    if (
        not isinstance(subject, str)
        or not subject.startswith(_SYNTHETIC_SUBJECT_PREFIX)
        or len(subject) > 207
        or not isinstance(body, str)
        or not body.startswith(_SYNTHETIC_BODY_PREFIX)
        or len(body) > 20046
    ):
        raise ValueError("invalid_email_context")
    _validate_plain_text_email(
        subject[len(_SYNTHETIC_SUBJECT_PREFIX) :], body[len(_SYNTHETIC_BODY_PREFIX) :]
    )
    try:
        if len(subject.encode("utf-8")) > 807 or len(body.encode("utf-8")) > 80046:
            raise ValueError("invalid_email_context")
    except UnicodeEncodeError:
        raise ValueError("invalid_email_context") from None
    html = _plain_text_html(body)
    if len(html) > 120317 or len(html.encode("utf-8")) > 120317:
        raise ValueError("invalid_email_context")
    return EmailContent(subject=subject, text_body=body, html_body=html)


def assemble_synthetic_test_email(subject: str, body: str) -> EmailContent:
    """Label already-rendered ordinary text once, without an unsubscribe footer."""
    _validate_plain_text_email(subject, body)
    return _assemble_synthetic_test_content(
        _SYNTHETIC_SUBJECT_PREFIX + subject, _SYNTHETIC_BODY_PREFIX + body
    )


@dataclass(frozen=True)
class DeliveryConfiguration:
    sender: str
    sender_name: str
    reply_to: str
    public_api_url: str
    allowed_recipients: frozenset[str]
    client_id: str
    client_secret: str = field(repr=False)
    tenant: str
    encryption_key: str = field(repr=False)


def delivery_configuration(settings: Any) -> DeliveryConfiguration:
    """Validate again at the transport edge, including callers outside Settings."""
    sender = normalize_email_address(getattr(settings, "EMAIL_FROM_ADDRESS", ""))
    reply_to = normalize_email_address(getattr(settings, "EMAIL_REPLY_TO", "") or sender)
    name = getattr(settings, "EMAIL_FROM_NAME", "Koaryu")
    if not isinstance(name, str) or not name.strip() or len(name) > 200 or _CONTROL.search(name):
        raise ValueError("invalid_email_configuration")
    raw_allowed = getattr(settings, "EMAIL_ALLOWED_RECIPIENTS", APPROVED_TEST_RECIPIENT)
    if not isinstance(raw_allowed, str):
        raise ValueError("invalid_email_configuration")  # noqa: TRY004 - Public validation contract.
    allowed = frozenset(
        normalize_email_address(address) for address in raw_allowed.split(",") if address.strip()
    )
    if raw_allowed and not allowed:
        raise ValueError("invalid_email_configuration")
    if allowed and allowed != {APPROVED_TEST_RECIPIENT}:
        raise ValueError("invalid_email_configuration")
    client_id = getattr(settings, "EMAIL_GRAPH_CLIENT_ID", "")
    tenant = getattr(settings, "EMAIL_GRAPH_TENANT", "consumers")
    try:
        if str(UUID(client_id)) != client_id.lower():
            raise ValueError
        if (
            tenant not in {"common", "organizations", "consumers"}
            and str(UUID(tenant)) != tenant.lower()
        ):
            raise ValueError
    except (AttributeError, TypeError, ValueError):
        raise ValueError("invalid_email_configuration") from None
    secret = getattr(settings, "EMAIL_GRAPH_CLIENT_SECRET", "")
    key = getattr(settings, "EMAIL_TOKEN_ENCRYPTION_KEY", "")
    if (
        not isinstance(secret, str)
        or not secret.strip()
        or len(secret) > 4096
        or _CONTROL.search(secret)
        or not isinstance(key, str)
        or not key
    ):
        raise ValueError("invalid_email_configuration")
    return DeliveryConfiguration(
        sender=sender,
        sender_name=name.strip(),
        reply_to=reply_to,
        public_api_url=validate_public_api_url(getattr(settings, "AUTOMATION_PUBLIC_API_URL", "")),
        allowed_recipients=allowed,
        client_id=client_id,
        client_secret=secret,
        tenant=tenant,
        encryption_key=key,
    )


def sender_identity_binding(config: DeliveryConfiguration) -> str:
    """Bind a validated sender identity without including secrets or recipients."""
    # Credentials imports normalize_email_address from this module.
    from app.services.automation_email_credentials import PROVIDER_KEY

    tenant = config.tenant
    if tenant not in {"common", "organizations", "consumers"}:
        tenant = str(UUID(tenant))
    identity = (
        PROVIDER_KEY,
        str(UUID(config.client_id)),
        normalize_email_address(config.sender),
        tenant,
    )
    return hashlib.sha256(
        json.dumps(identity, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


class DisabledEmailTransport:
    def send(self, message: EmailMessage, *, deadline: float | None = None) -> DeliveryResult:
        return DeliveryResult(
            "permanent_failure",
            "sending_disabled",
            submission_evidence="not_submitted",
            failure_scope="sender_transient",
        )


def build_email_transport(settings: Any, supabase_client: Any) -> EmailTransport:
    if (
        getattr(settings, "EMAIL_SEND_ENABLED", False) is not True
        or getattr(settings, "EMAIL_PROVIDER", "disabled") != "microsoft_graph"
    ):
        return DisabledEmailTransport()
    from app.services.microsoft_graph_email import MicrosoftGraphEmailTransport

    return MicrosoftGraphEmailTransport(settings, supabase_client)


def email_delivery_status(settings: Any, supabase_client: Any) -> dict[str, Any]:
    """Read only. Credential expiry permits refresh during delivery, never here."""
    provider = getattr(settings, "EMAIL_PROVIDER", "disabled")
    enabled = getattr(settings, "EMAIL_SEND_ENABLED", False) is True
    sender = ""
    try:
        sender = normalize_email_address(getattr(settings, "EMAIL_FROM_ADDRESS", ""))
    except ValueError:
        pass
    raw_allowed = getattr(settings, "EMAIL_ALLOWED_RECIPIENTS", APPROVED_TEST_RECIPIENT)
    status: dict[str, Any] = {
        "mode": "disabled"
        if not enabled or provider == "disabled"
        else "live"
        if raw_allowed == ""
        else "test",
        "configured": False,
        "can_enable": False,
        "sender": sender,
        "test_recipient": APPROVED_TEST_RECIPIENT if raw_allowed else None,
        "reason": "setup_required",
    }
    if provider != "microsoft_graph":
        status["reason"] = "sending_disabled" if provider == "disabled" else "setup_required"
        return status
    from app.services.automation_email_credentials import (
        CredentialCodec,
        CredentialError,
        CredentialRepository,
    )

    try:
        config = delivery_configuration(settings)
        codec = CredentialCodec(config.encryption_key, config.client_id, config.sender)
        envelope = CredentialRepository(supabase_client, codec).load()
        if envelope.state is None:
            return status
    except ValueError:
        return status
    except CredentialError as exc:
        status["reason"] = (
            "unavailable" if exc.code == "credential_store_unavailable" else "setup_required"
        )
        return status
    status.update(
        configured=True, can_enable=enabled, reason=None if enabled else "sending_disabled"
    )
    return status
