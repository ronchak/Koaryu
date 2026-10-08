"""Pure graph email formatting from caller-owned, typed current facts."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from types import MappingProxyType
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import TypeAdapter

from app.schemas.trial_appointment import IANATimezone, UTCInstant
from app.services.automation_email import EmailContent, assemble_plain_text_email
from app.services.workflow_catalog import CATALOG
from app.services.workflow_money import WorkflowMoneyFormatError, format_workflow_money

_TOKEN = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_BODY_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_UTC_INSTANT = TypeAdapter(UTCInstant)
_IANA_TIMEZONE = TypeAdapter(IANATimezone)
_INPUT_KINDS = MappingProxyType(
    {
        "studio_name": "text",
        "recipient_name": "text",
        "student_first_name": "text",
        "rank_name": "text",
        "program_name": "text",
        "lead_first_name": "text",
        "trial_start": "event_time",
        "trial_location": "text",
        "invoice_number": "text",
        "invoice_balance": "money",
        "invoice_due_date": "date",
        "event_name": "text",
        "event_start": "event_time",
        "event_location": "text",
    }
)
_Reason = Literal[
    "facts_unavailable",
    "unsupported_currency",
    "invalid_email_template",
    "invalid_email_context",
    "invalid_email_url",
]


@dataclass(frozen=True)
class WorkflowEventTimeValue:
    instant: datetime = field(repr=False)
    timezone: str = field(repr=False)


@dataclass(frozen=True)
class WorkflowMoneyValue:
    amount_minor_units: int = field(repr=False)
    currency: str = field(repr=False)
    unit_convention: Literal["stripe_minor_units", "usd_cents"] = field(repr=False)


class WorkflowEmailRenderError(ValueError):
    """A fixed reason without templates, facts, or unsubscribe URLs."""

    def __init__(self, reason: _Reason):
        if type(reason) is not str or reason not in (
            "facts_unavailable",
            "unsupported_currency",
            "invalid_email_template",
            "invalid_email_context",
            "invalid_email_url",
        ):
            raise ValueError("invalid_workflow_email_render_reason")
        self._reason = reason
        super().__init__(reason)

    @property
    def reason(self) -> _Reason:
        return self._reason


def _valid_unicode(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _template_variables(event_type: str, subject: str, body: str) -> set[str]:
    if type(event_type) is not str or event_type not in CATALOG["triggers"]:
        raise WorkflowEmailRenderError("invalid_email_template")
    names: set[str] = set()
    for template, limit, controls in ((subject, 200, _CONTROL), (body, 5000, _BODY_CONTROL)):
        if (
            type(template) is not str
            or not template.strip()
            or len(template) > limit
            or controls.search(template)
            or not _valid_unicode(template)
        ):
            raise WorkflowEmailRenderError("invalid_email_template")
        residue = _TOKEN.sub("", template)
        if "{" in residue or "}" in residue:
            raise WorkflowEmailRenderError("invalid_email_template")
        names.update(match.group(1) for match in _TOKEN.finditer(template))
    allowed = CATALOG["triggers"][event_type]["template_variables"]
    if any(name not in CATALOG["variables"] or name not in allowed for name in names):
        raise WorkflowEmailRenderError("invalid_email_template")
    return names


def _event_time(value: object) -> str:
    if (
        type(value) is not WorkflowEventTimeValue
        or type(value.instant) is not datetime
        or type(value.timezone) is not str
    ):
        raise WorkflowEmailRenderError("facts_unavailable")
    try:
        instant = _UTC_INSTANT.validate_python(value.instant, strict=True)
        zone = _IANA_TIMEZONE.validate_python(value.timezone, strict=True)
        local = instant.astimezone(ZoneInfo(zone))
        return local.isoformat(sep=" ", timespec="auto") + " [" + zone + "]"
    except Exception:  # noqa: BLE001 - Convert arbitrary tzinfo failures to the fixed contract.
        # Even a datetime's custom tzinfo may fail. Never expose its diagnostic.
        raise WorkflowEmailRenderError("facts_unavailable") from None


def _resolve(name: str, value: object) -> str:
    kind = _INPUT_KINDS[name]
    fallback = CATALOG["variables"][name]["fallback"]
    if kind == "text":
        if value is None and fallback is not None:
            return fallback
        if type(value) is not str:
            raise WorkflowEmailRenderError("facts_unavailable")
        if len(value) > 5000 or _CONTROL.search(value) or not _valid_unicode(value):
            raise WorkflowEmailRenderError("invalid_email_context")
        if not value.strip():
            if fallback is not None:
                return fallback
            raise WorkflowEmailRenderError("invalid_email_context")
        return value
    if kind == "date":
        if value is None:
            return fallback
        if type(value) is not date:
            raise WorkflowEmailRenderError("facts_unavailable")
        return value.isoformat()
    if kind == "event_time":
        return _event_time(value)
    if type(value) is not WorkflowMoneyValue:
        raise WorkflowEmailRenderError("facts_unavailable")
    try:
        return format_workflow_money(
            value.amount_minor_units, value.currency, unit_convention=value.unit_convention
        )
    except WorkflowMoneyFormatError as exc:
        raise WorkflowEmailRenderError(exc.reason) from None


def render_workflow_email(
    event_type: str,
    subject_template: str,
    body_template: str,
    context: Mapping[str, object],
    *,
    unsubscribe_url: str | None,
) -> EmailContent:
    """Render without selecting recipients, authorizing sends, or issuing tokens.

    Callers must supply a server-bound footer URL for customer delivery. Explicit
    None supports non-sending previews and deliberately synthetic admin test mail.
    """
    names = _template_variables(event_type, subject_template, body_template)
    if not isinstance(context, Mapping):
        raise WorkflowEmailRenderError("facts_unavailable")
    try:
        keys = tuple(context)
    except Exception:  # noqa: BLE001 - Mapping implementations must not leak input diagnostics.
        raise WorkflowEmailRenderError("facts_unavailable") from None
    if any(type(key) is not str or key not in CATALOG["variables"] for key in keys):
        raise WorkflowEmailRenderError("facts_unavailable")

    values: dict[str, str] = {}
    failures: set[str] = set()
    for name in sorted(names):
        if name not in keys:
            failures.add("facts_unavailable")
            continue
        try:
            value = context[name]
        except Exception:  # noqa: BLE001 - Missing or unreadable facts have one fixed reason.
            failures.add("facts_unavailable")
            continue
        try:
            values[name] = _resolve(name, value)
        except WorkflowEmailRenderError as exc:
            failures.add(exc.reason)
    for reason in ("facts_unavailable", "unsupported_currency", "invalid_email_context"):
        if reason in failures:
            raise WorkflowEmailRenderError(reason)

    subject = _TOKEN.sub(lambda match: values[match.group(1)], subject_template)
    body = _TOKEN.sub(lambda match: values[match.group(1)], body_template)
    invalid_url = unsubscribe_url is not None and (
        type(unsubscribe_url) is not str or not _valid_unicode(unsubscribe_url)
    )
    try:
        # Expanded text still wins over graph-only URL shape/encoding errors.
        content = assemble_plain_text_email(subject, body, None if invalid_url else unsubscribe_url)
    except ValueError as exc:
        reason = "invalid_email_url" if str(exc) == "invalid_email_url" else "invalid_email_context"
        raise WorkflowEmailRenderError(reason) from None
    if invalid_url:
        raise WorkflowEmailRenderError("invalid_email_url")
    return content
