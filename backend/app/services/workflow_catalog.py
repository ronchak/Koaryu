"""Immutable workflow metadata and editable preset graphs.

This catalog describes supported choices. Current-fact send gates are enforced
by the workflow runtime, independently of a graph's optional conditions.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


def _copy_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _copy_json(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_copy_json(item) for item in value]
    return value


def _field(
    field_id: str,
    label: str,
    value_type: str,
    *,
    values: tuple[str, ...] | None = None,
    nullable: bool = False,
) -> dict:
    result = {
        "id": field_id,
        "label": label,
        "value_type": value_type,
        "operators": ("eq", "neq") if value_type == "boolean" else ("eq", "neq", "in", "not_in"),
        "nullable": nullable,
    }
    if values is not None:
        result["values"] = values
    return result


def _trigger(event_type: str, label: str, subject_kind: str) -> dict:
    fields = {
        "student": ("student.status", "student.on_hold", "student.is_minor"),
        "promotion": (
            "student.status",
            "student.on_hold",
            "student.is_minor",
            "program.id",
            "promotion.rank_id",
        ),
        "lead": ("lead.stage", "lead.source", "lead.unconverted", "program.id"),
        "trial": ("lead.stage", "lead.source", "lead.unconverted", "trial.status", "program.id"),
        "invoice": ("invoice.overdue", "invoice.open_balance", "invoice.collection_method"),
        "belt_test": (
            "student.status",
            "student.on_hold",
            "student.is_minor",
            "program.id",
            "belt_test.event_scheduled",
            "belt_test.approval_current",
        ),
    }
    variables = {
        "student": ("student_first_name",),
        "promotion": ("student_first_name", "rank_name", "program_name"),
        "lead": ("lead_first_name",),
        "trial": ("lead_first_name", "trial_start", "trial_location"),
        "invoice": ("invoice_number", "invoice_balance", "invoice_due_date"),
        "belt_test": ("student_first_name", "event_name", "event_start", "event_location"),
    }
    if subject_kind in {"lead", "trial"}:
        recipients = ("lead_or_guardian", "assigned_staff")
    elif subject_kind == "invoice":
        recipients = ("invoice_payer",)
    else:
        recipients = ("student_or_guardian",)
    delay_fields = ()
    if event_type in {"trial.scheduled", "trial.upcoming"}:
        delay_fields = ("trial.starts_at",)
    elif event_type in {"belt_test.approved", "belt_test.upcoming"}:
        delay_fields = ("belt_test.starts_at",)
    simulation_entity_type = {
        "trial": "trial_appointment",
        "belt_test": "belt_test_recipient",
    }.get(subject_kind, subject_kind)
    if event_type == "invoice.payment_failed":
        simulation_entity_type = "payment"
    return {
        "id": event_type,
        "label": label,
        "subject_kind": subject_kind,
        "simulation_entity_type": simulation_entity_type,
        "recipient_ids": recipients,
        "field_ids": fields[subject_kind],
        "template_variables": ("studio_name", "recipient_name") + variables[subject_kind],
        "supports_offset": event_type in {"trial.upcoming", "belt_test.upcoming"},
        "supports_program_filter": subject_kind != "invoice",
        "delay_fields": delay_fields,
        "supports_lead_follow_up": subject_kind in {"lead", "trial"},
    }


def _node(node_id: str, node_type: str, **config: Any) -> dict:
    return {"id": node_id, "type": node_type, "config": config}


def _start(event_type: str, *, offset_minutes: int | None = None) -> dict:
    config = {"event_type": event_type, "program_id": None}
    if offset_minutes is not None:
        config["offset_minutes"] = offset_minutes
    return _node("trigger", "trigger", **config)


def _email(node_id: str, recipient: str, subject: str, body: str) -> dict:
    return _node(
        node_id,
        "email",
        recipient=recipient,
        subject_template=subject,
        body_template=body,
        reply_to_email="",
    )


def _condition(field: str) -> dict:
    return _node("condition", "condition", field=field, operator="eq", value=True)


def _wait(minutes: int) -> dict:
    return _node("delay", "delay", mode="duration", minutes=minutes)


def _follow_up(note: str) -> dict:
    return _node("follow_up", "lead_follow_up", due_in_days=0, note=note)


def _graph(*nodes: dict) -> dict:
    """Build a path whose optional condition sends its no branch to the end."""
    nodes = [*nodes, _node("end", "end")]
    edges = []
    for source, target in zip(nodes, nodes[1:]):
        port = "yes" if source["type"] == "condition" else "next"
        edges.append(
            {
                "id": f"{source['id']}_{port}",
                "source": source["id"],
                "target": target["id"],
                "port": port,
            }
        )
        if source["type"] == "condition":
            edges.append(
                {"id": f"{source['id']}_no", "source": source["id"], "target": "end", "port": "no"}
            )
    return {"schema_version": 1, "nodes": nodes, "edges": edges}


def _preset(preset_id: str, name: str, description: str, *nodes: dict) -> dict:
    return {"id": preset_id, "name": name, "description": description, "graph": _graph(*nodes)}


def _presets() -> tuple[dict, ...]:
    return (
        _preset(
            "welcome",
            "Welcome a new student",
            "Send a welcome message when a student first enrolls.",
            _start("student.enrolled"),
            _email(
                "welcome",
                "student_or_guardian",
                "Welcome to {{studio_name}}",
                "Hello {{recipient_name}},\n\nWelcome to {{studio_name}}! "
                "We look forward to seeing {{student_first_name}} in class. "
                "Reply if you have questions before the first visit.\n\n{{studio_name}}",
            ),
        ),
        _preset(
            "promotion_congratulations",
            "Celebrate a promotion",
            "Congratulate a student after a rank promotion.",
            _start("student.promoted"),
            _email(
                "congratulations",
                "student_or_guardian",
                "Congratulations on {{rank_name}}!",
                "Hello {{recipient_name}},\n\nCongratulations to {{student_first_name}} "
                "on earning {{rank_name}} in {{program_name}}. "
                "We are proud of the work that went into this achievement.\n\n{{studio_name}}",
            ),
        ),
        _preset(
            "new_lead_follow_up",
            "Follow up with a new lead",
            "Welcome a lead, then set a staff follow-up after two days if they remain unconverted.",
            _start("lead.created"),
            _email(
                "welcome",
                "lead_or_guardian",
                "Thanks for your interest in {{studio_name}}",
                "Hello {{recipient_name}},\n\nThank you for asking about classes for "
                "{{lead_first_name}} at {{studio_name}}. "
                "Reply with any questions or to discuss a first visit.\n\n{{studio_name}}",
            ),
            _wait(2880),
            _condition("lead.unconverted"),
            _follow_up("Follow up on the initial inquiry and offer help arranging a first visit."),
        ),
        _preset(
            "trial_reminder",
            "Remind a lead about a trial",
            "Send a reminder one day before a scheduled trial.",
            _start("trial.upcoming", offset_minutes=-1440),
            _email(
                "reminder",
                "lead_or_guardian",
                "Your trial at {{studio_name}}",
                "Hello {{recipient_name}},\n\nThis is a reminder of {{lead_first_name}}'s "
                "trial at {{trial_start}}. Location: {{trial_location}}. "
                "Reply if you have questions or need to change your plans.\n\n{{studio_name}}",
            ),
        ),
        _preset(
            "trial_completion_follow_up",
            "Follow up after a trial",
            "Wait one day after a completed trial, then contact an unconverted lead and set a follow-up.",
            _start("trial.completed"),
            _wait(1440),
            _condition("lead.unconverted"),
            _email(
                "follow_up_email",
                "lead_or_guardian",
                "How was your trial at {{studio_name}}?",
                "Hello {{recipient_name}},\n\nThank you for bringing {{lead_first_name}} "
                "to a trial at {{studio_name}}. We would love to hear how it went. "
                "Reply if you would like to discuss classes or enrollment.\n\n{{studio_name}}",
            ),
            _follow_up("Check in after the completed trial and answer questions about enrollment."),
        ),
        _preset(
            "trial_no_show",
            "Offer another trial time",
            "Contact an unconverted lead after a missed trial and set a staff follow-up.",
            _start("trial.no_show"),
            _condition("lead.unconverted"),
            _email(
                "rebook",
                "lead_or_guardian",
                "Another time for a trial at {{studio_name}}?",
                "Hello {{recipient_name}},\n\nWe missed {{lead_first_name}} at the trial. "
                "If another time would work better, reply and we can help arrange a new visit."
                "\n\n{{studio_name}}",
            ),
            _follow_up("Offer help finding another trial time if the lead is still interested."),
        ),
        _preset(
            "overdue_recovery",
            "Follow up on an overdue invoice",
            "Send an overdue notice and a second message after three days if the invoice remains overdue.",
            _start("invoice.overdue"),
            _email(
                "notice",
                "invoice_payer",
                "Invoice {{invoice_number}} is overdue",
                "Hello {{recipient_name}},\n\nInvoice {{invoice_number}} from {{studio_name}} "
                "has an outstanding balance of {{invoice_balance}} and was due {{invoice_due_date}}. "
                "Reply if you have questions or need help with payment.\n\n{{studio_name}}",
            ),
            _wait(4320),
            _condition("invoice.overdue"),
            _email(
                "second_notice",
                "invoice_payer",
                "Following up on invoice {{invoice_number}}",
                "Hello {{recipient_name}},\n\nInvoice {{invoice_number}} still has an outstanding "
                "balance of {{invoice_balance}}. Please contact us if you need help or have "
                "questions about this invoice.\n\n{{studio_name}}",
            ),
        ),
        _preset(
            "failed_payment_notice",
            "Notify a payer about a failed payment",
            "Notify the invoice payer when a new payment first fails and a balance remains open.",
            _start("invoice.payment_failed"),
            _condition("invoice.open_balance"),
            _email(
                "notice",
                "invoice_payer",
                "Payment for invoice {{invoice_number}} was unsuccessful",
                "Hello {{recipient_name}},\n\nA payment for invoice {{invoice_number}} was "
                "unsuccessful. The current outstanding balance is {{invoice_balance}}. "
                "Please contact {{studio_name}} for help with payment.\n\n{{studio_name}}",
            ),
        ),
        _preset(
            "belt_test_invitation",
            "Invite a student to a belt test",
            "Send an invitation after staff approval, then a reminder one day before the test.",
            _start("belt_test.approved"),
            _email(
                "invitation",
                "student_or_guardian",
                "Invitation to {{event_name}}",
                "Hello {{recipient_name}},\n\n{{student_first_name}} is invited to {{event_name}} "
                "at {{event_start}}. Location: {{event_location}}. "
                "Reply with any questions about attending.\n\n{{studio_name}}",
            ),
            _node(
                "delay", "delay", mode="until", field="belt_test.starts_at", offset_minutes=-1440
            ),
            _email(
                "reminder",
                "student_or_guardian",
                "Reminder for {{event_name}}",
                "Hello {{recipient_name}},\n\nThis is a reminder that {{student_first_name}} "
                "is invited to {{event_name}} at {{event_start}}. Location: {{event_location}}. "
                "Reply if you have any questions.\n\n{{studio_name}}",
            ),
        ),
    )


def _catalog() -> dict:
    triggers = (
        ("student.enrolled", "Student first enrolls", "student"),
        ("student.promoted", "Student earns a rank promotion", "promotion"),
        ("lead.created", "Lead is created", "lead"),
        ("lead.stage_changed", "Lead stage changes", "lead"),
        ("trial.scheduled", "Trial is scheduled", "trial"),
        ("trial.completed", "Trial is completed", "trial"),
        ("trial.no_show", "Trial is marked as missed", "trial"),
        ("trial.upcoming", "Trial is approaching", "trial"),
        ("invoice.overdue", "Invoice becomes overdue", "invoice"),
        ("invoice.payment_failed", "When a new payment first fails", "invoice"),
        ("belt_test.approved", "Student is approved for a belt test", "belt_test"),
        ("belt_test.upcoming", "Approved belt test is approaching", "belt_test"),
    )
    fields = (
        _field(
            "student.status",
            "Student status",
            "enum",
            values=("active", "trialing", "inactive", "paused", "canceled"),
        ),
        _field("student.on_hold", "Student is on hold", "boolean"),
        _field("student.is_minor", "Student is a minor", "boolean"),
        _field(
            "lead.stage",
            "Lead stage",
            "enum",
            values=(
                "inquiry",
                "trial_scheduled",
                "trial_completed",
                "offer_sent",
                "enrolled",
                "closed_lost",
            ),
        ),
        _field(
            "lead.source",
            "Lead source",
            "enum",
            values=("walk_in", "referral", "social", "search", "website", "other"),
        ),
        _field("lead.unconverted", "Lead is unconverted", "boolean"),
        _field(
            "trial.status",
            "Trial status",
            "enum",
            values=("scheduled", "completed", "no_show", "canceled"),
        ),
        _field("invoice.overdue", "Invoice is overdue", "boolean"),
        _field("invoice.open_balance", "Invoice has an open balance", "boolean"),
        _field(
            "invoice.collection_method",
            "Invoice collection method",
            "enum",
            values=("send_invoice", "charge_automatically"),
            nullable=True,
        ),
        _field("program.id", "Program", "uuid", nullable=True),
        _field("promotion.rank_id", "Promoted rank", "uuid"),
        _field("belt_test.event_scheduled", "Belt test is scheduled", "boolean"),
        _field("belt_test.approval_current", "Belt test approval is current", "boolean"),
    )
    variables = (
        ("studio_name", "Studio name", None),
        ("recipient_name", "Recipient name", "there"),
        ("student_first_name", "Student first name", None),
        ("rank_name", "Promoted rank name", None),
        ("program_name", "Promotion program name", "your program"),
        ("lead_first_name", "Lead first name", None),
        ("trial_start", "Trial date and time", None),
        ("trial_location", "Trial location", "Please contact the studio for the location"),
        ("invoice_number", "Invoice number", "not numbered"),
        ("invoice_balance", "Current invoice balance", None),
        ("invoice_due_date", "Invoice due date", "No due date listed"),
        ("event_name", "Belt test name", None),
        ("event_start", "Belt test date and time", None),
        ("event_location", "Belt test location", "Please contact the studio for the location"),
    )
    return {
        "triggers": {event: _trigger(event, label, kind) for event, label, kind in triggers},
        "fields": {field["id"]: field for field in fields},
        "recipients": {
            recipient: {"id": recipient, "label": label}
            for recipient, label in (
                ("student_or_guardian", "Student or guardian"),
                ("lead_or_guardian", "Lead or guardian"),
                ("invoice_payer", "Invoice payer"),
                ("assigned_staff", "Assigned staff member"),
            )
        },
        "variables": {
            name: {"id": name, "label": label, "value_type": "string", "fallback": fallback}
            for name, label, fallback in variables
        },
        "delay_fields": {
            anchor: {"id": anchor, "label": label, "value_type": "datetime", "trigger_ids": events}
            for anchor, label, events in (
                ("trial.starts_at", "Trial start", ("trial.scheduled", "trial.upcoming")),
                (
                    "belt_test.starts_at",
                    "Belt test start",
                    ("belt_test.approved", "belt_test.upcoming"),
                ),
            )
        },
        "presets": _presets(),
    }


CATALOG: Mapping[str, Any] = _freeze(_catalog())


def get_workflow_catalog() -> dict:
    """Return a JSON-compatible copy callers may edit without changing the registry."""
    return _copy_json(CATALOG)


def build_preset(preset_id: str) -> dict:
    """Materialize an editable graph from a known preset."""
    for preset in CATALOG["presets"]:
        if preset["id"] == preset_id:
            return _copy_json(preset["graph"])
    raise ValueError("unknown_workflow_preset")
