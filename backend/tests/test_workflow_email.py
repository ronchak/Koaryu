"""Pure rendering checks use synthetic facts and never contact a provider."""

from collections import Counter
from collections.abc import Mapping
from dataclasses import FrozenInstanceError
from datetime import UTC, date, datetime, timedelta, timezone, tzinfo
from html import escape
from itertools import product
from types import MappingProxyType

import pytest

from app.services.automation_email import assemble_plain_text_email, render_missed_class_email
from app.services.workflow_catalog import CATALOG, build_preset
from app.services.workflow_email import (
    _INPUT_KINDS,
    WorkflowEmailRenderError,
    WorkflowEventTimeValue,
    WorkflowMoneyValue,
    render_workflow_email,
)
from app.services.workflow_graph import validate_workflow_graph

INSTANT = datetime(2026, 11, 1, 8, 30, tzinfo=UTC)
EVENT_TIME = WorkflowEventTimeValue(INSTANT, "America/Los_Angeles")
URL = 'https://api.example.com/unsubscribe?label="synthetic"&next=1#' + "a" * 32
FACTS = {
    "studio_name": "Studio & school",
    "recipient_name": "Synthetic recipient",
    "student_first_name": "Synthetic student",
    "rank_name": "Committed rank",
    "program_name": "Current program",
    "lead_first_name": "Synthetic lead",
    "trial_start": EVENT_TIME,
    "trial_location": "Trial room",
    "invoice_number": "SYNTHETIC-123",
    "invoice_balance": WorkflowMoneyValue(12345, "USD", "stripe_minor_units"),
    "invoice_due_date": date(2026, 10, 5),
    "event_name": "Synthetic belt test",
    "event_start": EVENT_TIME,
    "event_location": "Event room",
}
EXPECTED = {
    **FACTS,
    "trial_start": "2026-11-01 01:30:00-07:00 [America/Los_Angeles]",
    "invoice_balance": "USD 123.45",
    "invoice_due_date": "2026-10-05",
    "event_start": "2026-11-01 01:30:00-07:00 [America/Los_Angeles]",
}
TEXT_NAMES = tuple(name for name, kind in _INPUT_KINDS.items() if kind == "text")


def event_for(name):
    return next(
        event
        for event, metadata in CATALOG["triggers"].items()
        if name in metadata["template_variables"]
    )


def render(name, value, **kwargs):
    return render_workflow_email(
        event_for(name),
        "Subject",
        "{{" + name + "}}",
        {name: value},
        unsubscribe_url=None,
        **kwargs,
    )


def assert_reason(reason, call, *args, **kwargs):
    with pytest.raises(WorkflowEmailRenderError) as caught:
        call(*args, **kwargs)
    assert caught.value.reason == reason
    assert str(caught.value) == reason
    assert repr(caught.value) == f"WorkflowEmailRenderError('{reason}')"
    assert caught.value.__cause__ is None


def graph(event, subject, body):
    metadata = CATALOG["triggers"][event]
    config = {"event_type": event}
    if metadata["supports_offset"]:
        config["offset_minutes"] = -60
    return {
        "schema_version": 1,
        "nodes": [
            {"id": "start", "type": "trigger", "config": config},
            {
                "id": "email",
                "type": "email",
                "config": {
                    "recipient": metadata["recipient_ids"][0],
                    "subject_template": subject,
                    "body_template": body,
                    "reply_to_email": "",
                },
            },
            {"id": "end", "type": "end", "config": {}},
        ],
        "edges": [
            {"id": "first", "source": "start", "target": "email", "port": "next"},
            {"id": "last", "source": "email", "target": "end", "port": "next"},
        ],
    }


def test_dispatch_covers_exactly_fourteen_catalog_variables():
    assert set(_INPUT_KINDS) == set(CATALOG["variables"]) == set(FACTS)
    assert len(_INPUT_KINDS) == 14
    assert {name for name, kind in _INPUT_KINDS.items() if kind == "event_time"} == {
        "trial_start",
        "event_start",
    }
    assert {name for name, kind in _INPUT_KINDS.items() if kind == "money"} == {"invoice_balance"}
    assert {name for name, kind in _INPUT_KINDS.items() if kind == "date"} == {"invoice_due_date"}
    assert len(TEXT_NAMES) == 10


@pytest.mark.parametrize("name", FACTS)
def test_all_typed_values(name):
    content = render(name, FACTS[name])
    assert content.subject == "Subject"
    assert content.text_body == EXPECTED[name]
    assert (
        content.html_body
        == '<div style="white-space: pre-wrap">' + escape(EXPECTED[name]) + "</div>"
    )


@pytest.mark.parametrize("name", FACTS)
def test_omitted_referenced_fact_is_unavailable_even_with_fallback(name):
    assert_reason(
        "facts_unavailable",
        render_workflow_email,
        event_for(name),
        "Subject",
        "{{" + name + "}}",
        {},
        unsubscribe_url=None,
    )


@pytest.mark.parametrize("name", FACTS)
def test_explicit_null_uses_only_catalog_fallback(name):
    fallback = CATALOG["variables"][name]["fallback"]
    if fallback is None:
        assert_reason("facts_unavailable", render, name, None)
    else:
        assert render(name, None).text_body == fallback


@pytest.mark.parametrize("name,blank", product(TEXT_NAMES, ("", " ", "\u00a0")))
def test_blank_text_uses_only_catalog_fallback(name, blank):
    fallback = CATALOG["variables"][name]["fallback"]
    if fallback is None:
        assert_reason("invalid_email_context", render, name, blank)
    else:
        assert render(name, blank).text_body == fallback


@pytest.mark.parametrize("name,bad", product(FACTS, (True, 2, 1.5, {}, [], (), object())))
def test_wrong_types_never_coerce(name, bad):
    assert_reason("facts_unavailable", render, name, bad)


class StringSubclass(str):
    pass


class DateSubclass(date):
    pass


class DatetimeSubclass(datetime):
    pass


class TimeSubclass(WorkflowEventTimeValue):
    pass


class MoneySubclass(WorkflowMoneyValue):
    pass


class NoStringCoercion:
    def __str__(self):
        raise AssertionError("Fact was coerced to string")


@pytest.mark.parametrize(
    "name,value",
    [
        ("studio_name", StringSubclass("Studio")),
        ("recipient_name", NoStringCoercion()),
        ("invoice_due_date", DateSubclass(2026, 10, 5)),
        ("invoice_due_date", INSTANT),
        ("invoice_due_date", "2026-10-05"),
        ("invoice_due_date", ""),
        ("trial_start", TimeSubclass(INSTANT, "UTC")),
        (
            "trial_start",
            WorkflowEventTimeValue(DatetimeSubclass(2026, 1, 1, tzinfo=UTC), "UTC"),
        ),
        ("trial_start", WorkflowEventTimeValue(INSTANT, StringSubclass("UTC"))),
        ("invoice_balance", MoneySubclass(1, "USD", "usd_cents")),
        (
            "invoice_balance",
            {"amount_minor_units": 100, "currency": "USD", "unit_convention": "usd_cents"},
        ),
    ],
)
def test_exact_typed_contract_rejects_subclasses_and_raw_facts(name, value):
    assert_reason("facts_unavailable", render, name, value)


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        (),
        "context",
        {"unknown": 1},
        {1: "value"},
        {StringSubclass("studio_name"): "Studio"},
    ],
)
def test_closed_context_container_and_keys(bad):
    assert_reason(
        "facts_unavailable",
        render_workflow_email,
        "lead.created",
        "Subject",
        "Body",
        bad,
        unsubscribe_url=None,
    )


def test_known_unreferenced_values_need_not_be_present_or_valid():
    for context in ({}, {name: NoStringCoercion() for name in FACTS}):
        content = render_workflow_email(
            "lead.created", "Subject", "Body", context, unsubscribe_url=None
        )
        assert content.text_body == "Body"


def test_resolve_union_once_without_reading_unused_values():
    class CountingFacts(Mapping):
        def __init__(self):
            self.reads = Counter()

        def __iter__(self):
            return iter(("studio_name", "invoice_balance"))

        def __len__(self):
            return 2

        def __getitem__(self, key):
            assert key == "studio_name"
            self.reads[key] += 1
            return "Studio"

    facts = CountingFacts()
    content = render_workflow_email(
        "lead.created",
        "{{studio_name}} {{studio_name}}",
        "{{studio_name}}",
        facts,
        unsubscribe_url=None,
    )
    assert content.subject == "Studio Studio"
    assert facts.reads == {"studio_name": 1}


@pytest.mark.parametrize("broken_iteration", [False, True])
def test_unreadable_mappings_use_fixed_unavailable_error(broken_iteration):
    class UnreadableFacts(Mapping):
        def __iter__(self):
            if broken_iteration:
                raise RuntimeError("synthetic private mapping diagnostic")
            return iter(("studio_name",))

        def __len__(self):
            return 1

        def __getitem__(self, key):
            raise RuntimeError("synthetic private fact diagnostic")

    assert_reason(
        "facts_unavailable",
        render_workflow_email,
        "lead.created",
        "Subject",
        "{{studio_name}}",
        UnreadableFacts(),
        unsubscribe_url=None,
    )


@pytest.mark.parametrize("event,name", product(CATALOG["triggers"], FACTS))
def test_all_twelve_trigger_allowlists_match_graph_validator(event, name):
    assert len(CATALOG["triggers"]) == 12
    template = "{{" + name + "}}"
    allowed = name in CATALOG["triggers"][event]["template_variables"]
    assert (
        validate_workflow_graph(graph(event, "Subject", template), catalog=CATALOG).valid == allowed
    )
    if allowed:
        assert (
            render_workflow_email(event, "Subject", template, FACTS, unsubscribe_url=None).text_body
            == EXPECTED[name]
        )
    else:
        assert_reason(
            "invalid_email_template",
            render_workflow_email,
            event,
            "Subject",
            template,
            FACTS,
            unsubscribe_url=None,
        )


@pytest.mark.parametrize("preset", CATALOG["presets"], ids=lambda p: p["id"])
def test_all_nine_presets_render_deterministically_without_mutating_facts(preset):
    assert len(CATALOG["presets"]) == 9
    candidate = build_preset(preset["id"])
    assert validate_workflow_graph(candidate, catalog=CATALOG).valid
    event = next(
        node["config"]["event_type"] for node in candidate["nodes"] if node["type"] == "trigger"
    )
    for node in candidate["nodes"]:
        if node["type"] != "email":
            continue
        config = node["config"]
        args = (event, config["subject_template"], config["body_template"], MappingProxyType(FACTS))
        assert render_workflow_email(*args, unsubscribe_url=URL) == render_workflow_email(
            *args, unsubscribe_url=URL
        )


@pytest.mark.parametrize("field", ["subject", "body"])
@pytest.mark.parametrize(
    "template,allowed",
    [
        ("Plain text", True),
        ("A <b> & 'quoted'", True),
        ("{{studio_name}}", True),
        ("https://example.com/path?q=1", True),
        ("", False),
        (" ", False),
        ("{{unknown}}", False),
        ("{{invoice_number}}", False),
        ("{{ studio_name }}", False),
        ("{studio_name}", False),
        ("{{studio_name}", False),
        ("{{{studio_name}}}", False),
        ("{{STUDIO_NAME}}", False),
        ("{{studio.name}}", False),
        ("{{studio_name|upper}}", False),
        ("{{studio_name()}}", False),
        (r"\{{studio_name}}", True),
        ("A\rB", False),
        ("A\x00B", False),
        ("A\x85B", False),
    ],
)
def test_static_grammar_matches_graph_validator(field, template, allowed):
    subject, body = (template, "Body") if field == "subject" else ("Subject", template)
    assert (
        validate_workflow_graph(graph("lead.created", subject, body), catalog=CATALOG).valid
        == allowed
    )
    if allowed:
        render_workflow_email("lead.created", subject, body, FACTS, unsubscribe_url=None)
    else:
        assert_reason(
            "invalid_email_template",
            render_workflow_email,
            "lead.created",
            subject,
            body,
            {},
            unsubscribe_url=None,
        )


@pytest.mark.parametrize("code", [*range(32), *range(127, 160)])
def test_every_control_is_rejected_in_substitutions_and_subjects(code):
    control = chr(code)
    assert_reason("invalid_email_context", render, "recipient_name", control)
    assert_reason(
        "invalid_email_template",
        render_workflow_email,
        "lead.created",
        "A" + control + "B",
        "Body",
        {},
        unsubscribe_url=None,
    )
    body = "A" + control + "B"
    allowed = control in "\t\n"
    assert (
        validate_workflow_graph(graph("lead.created", "Subject", body), catalog=CATALOG).valid
        == allowed
    )
    if allowed:
        assert (
            render_workflow_email(
                "lead.created", "Subject", body, {}, unsubscribe_url=None
            ).text_body
            == body
        )
    else:
        assert_reason(
            "invalid_email_template",
            render_workflow_email,
            "lead.created",
            "Subject",
            body,
            {},
            unsubscribe_url=None,
        )


@pytest.mark.parametrize("name", TEXT_NAMES)
@pytest.mark.parametrize("value", [" " * 5001, "\t", "\n", chr(0xD800), chr(0xDFFF)])
def test_safety_precedes_blank_fallback(name, value):
    assert_reason("invalid_email_context", render, name, value)


@pytest.mark.parametrize("text", [chr(0xD800), chr(0xDFFF), chr(0xD800) + chr(0xDC00)])
@pytest.mark.parametrize("field", ["subject", "body"])
def test_invalid_unicode_templates_are_graph_only_errors(field, text):
    subject, body = (text, "Body") if field == "subject" else ("Subject", text)
    assert_reason(
        "invalid_email_template",
        render_workflow_email,
        "lead.created",
        subject,
        body,
        {},
        unsubscribe_url=None,
    )
    # Extraction must retain the old renderer's Unicode behavior.
    assert render_missed_class_email(subject, body, {}).subject == subject


def test_unicode_spaces_html_braces_and_backslashes_are_preserved_verbatim():
    value = "  Zoë 🥋 <script> & \"quote\" 'apostrophe' {{recipient_name}} \\1 \\g<1>  "
    content = render_workflow_email(
        "lead.created",
        "{{studio_name}}",
        "Hi\t{{studio_name}}\n{{recipient_name}}",
        {"studio_name": value, "recipient_name": "Recipient"},
        unsubscribe_url=None,
    )
    assert content.subject == value
    assert content.text_body == "Hi\t" + value + "\nRecipient"
    assert (
        content.html_body
        == '<div style="white-space: pre-wrap">' + escape(content.text_body) + "</div>"
    )


@pytest.mark.parametrize("event", ["future.trigger", "", None, [], StringSubclass("lead.created")])
def test_unknown_or_untyped_event_precedes_context_errors(event):
    assert_reason(
        "invalid_email_template",
        render_workflow_email,
        event,
        "Subject",
        "Body",
        None,
        unsubscribe_url="unsafe",
    )


@pytest.mark.parametrize("value", [None, 1, True, {}, StringSubclass("Text")])
@pytest.mark.parametrize("field", ["subject", "body"])
def test_templates_require_exact_strings(value, field):
    subject, body = (value, "Body") if field == "subject" else ("Subject", value)
    assert_reason(
        "invalid_email_template",
        render_workflow_email,
        "lead.created",
        subject,
        body,
        {},
        unsubscribe_url=None,
    )


def test_static_and_expanded_boundaries_and_footer_outside_body_bound():
    assert (
        len(
            render_workflow_email(
                "lead.created", "é" * 200, "🥋" * 5000, {}, unsubscribe_url=None
            ).text_body
        )
        == 5000
    )
    for subject, body in (("a" * 201, "Body"), ("Subject", "a" * 5001)):
        assert_reason(
            "invalid_email_template",
            render_workflow_email,
            "lead.created",
            subject,
            body,
            {},
            unsubscribe_url=None,
        )
    assert render("studio_name", "x" * 5000).text_body == "x" * 5000
    assert_reason("invalid_email_context", render, "studio_name", "x" * 5001)
    subject = "{{studio_name}}"
    for length in (200, 201):
        args = ("lead.created", subject, "Body", {"studio_name": "x" * length})
        if length == 200:
            assert len(render_workflow_email(*args, unsubscribe_url=None).subject) == 200
        else:
            assert_reason(
                "invalid_email_context", render_workflow_email, *args, unsubscribe_url="unsafe"
            )
    content = render_workflow_email(
        "lead.created", "Subject", subject * 4, {"studio_name": '"' * 5000}, unsubscribe_url=URL
    )
    assert len(content.text_body) > 20000
    assert len(content.html_body) < 150000
    assert content.text_body.startswith('"' * 20000 + "\n\nUnsubscribe")
    assert_reason(
        "invalid_email_context",
        render_workflow_email,
        "lead.created",
        "Subject",
        subject * 4 + "x",
        {"studio_name": "x" * 5000},
        unsubscribe_url="unsafe",
    )


@pytest.mark.parametrize(
    "value,expected",
    [
        (WorkflowMoneyValue(0, "USD", "usd_cents"), "USD 0.00"),
        (WorkflowMoneyValue(-123, "USD", "usd_cents"), "USD -1.23"),
        (WorkflowMoneyValue(123, "ISK", "stripe_minor_units"), "ISK 1.23"),
        (WorkflowMoneyValue(123, "JPY", "stripe_minor_units"), "JPY 123"),
        (WorkflowMoneyValue(123, "KWD", "stripe_minor_units"), "KWD 0.123"),
        (WorkflowMoneyValue(-(2**63), "usd", "stripe_minor_units"), "USD -92233720368547758.08"),
        (WorkflowMoneyValue(2**63 - 1, "USD", "stripe_minor_units"), "USD 92233720368547758.07"),
    ],
)
def test_money_preserves_formatter_units_sign_and_precision(value, expected):
    assert render("invoice_balance", value).text_body == expected


@pytest.mark.parametrize(
    "value,reason",
    [
        (WorkflowMoneyValue(1, "ZZZ", "stripe_minor_units"), "unsupported_currency"),
        (WorkflowMoneyValue(True, "ZZZ", "stripe_minor_units"), "facts_unavailable"),
        (WorkflowMoneyValue(2**63, "USD", "stripe_minor_units"), "facts_unavailable"),
        (WorkflowMoneyValue(-(2**63) - 1, "USD", "stripe_minor_units"), "facts_unavailable"),
        (WorkflowMoneyValue(1.2, "USD", "stripe_minor_units"), "facts_unavailable"),
        (WorkflowMoneyValue(1, "US", "stripe_minor_units"), "facts_unavailable"),
        (WorkflowMoneyValue(1, "eur", "usd_cents"), "facts_unavailable"),
        (WorkflowMoneyValue(1, "USD", "unknown"), "facts_unavailable"),
    ],
)
def test_money_fixed_errors(value, reason):
    assert_reason(reason, render, "invoice_balance", value)


@pytest.mark.parametrize("reverse", [False, True])
def test_fact_error_precedence_is_independent_of_token_and_mapping_order(reverse):
    entries = [
        ("studio_name", "bad\ntext"),
        ("invoice_balance", WorkflowMoneyValue(1, "ZZZ", "stripe_minor_units")),
        ("invoice_due_date", "malformed date"),
    ]
    if reverse:
        entries.reverse()
    context = dict(entries)
    body = " ".join("{{" + name + "}}" for name in context)
    args = ("invoice.overdue", "Subject", body, context)
    assert_reason("facts_unavailable", render_workflow_email, *args, unsubscribe_url="unsafe")
    del context["invoice_due_date"]
    assert_reason("facts_unavailable", render_workflow_email, *args, unsubscribe_url="unsafe")
    context["invoice_due_date"] = None
    assert_reason("unsupported_currency", render_workflow_email, *args, unsubscribe_url="unsafe")
    context["invoice_balance"] = WorkflowMoneyValue(1, "USD", "usd_cents")
    assert_reason("invalid_email_context", render_workflow_email, *args, unsubscribe_url="unsafe")
    context["studio_name"] = "Studio"
    assert_reason("invalid_email_url", render_workflow_email, *args, unsubscribe_url="unsafe")


@pytest.mark.parametrize(
    "instant,zone,expected",
    [
        (INSTANT, "America/Los_Angeles", "2026-11-01 01:30:00-07:00 [America/Los_Angeles]"),
        (
            INSTANT + timedelta(hours=1),
            "America/Los_Angeles",
            "2026-11-01 01:30:00-08:00 [America/Los_Angeles]",
        ),
        (
            datetime(2026, 3, 8, 10, 30, tzinfo=UTC),
            "America/Los_Angeles",
            "2026-03-08 03:30:00-07:00 [America/Los_Angeles]",
        ),
        (
            datetime(2026, 1, 1, 3, 4, 5, 123456, tzinfo=timezone(timedelta(hours=5, minutes=30))),
            "UTC",
            "2025-12-31 21:34:05.123456+00:00 [UTC]",
        ),
        (
            datetime(1900, 1, 1, tzinfo=UTC),
            "Europe/Paris",
            "1900-01-01 00:09:21+00:09:21 [Europe/Paris]",
        ),
    ],
)
@pytest.mark.parametrize("name", ["trial_start", "event_start"])
def test_event_times_display_actual_offset_without_rounding(name, instant, zone, expected):
    assert render(name, WorkflowEventTimeValue(instant, zone)).text_body == expected


class BrokenTimezone(tzinfo):
    def utcoffset(self, dt):
        raise RuntimeError("synthetic private timezone diagnostic")


@pytest.mark.parametrize(
    "instant,zone",
    [
        (INSTANT.replace(tzinfo=None), "UTC"),
        ("2026-01-01T00:00:00Z", "UTC"),
        (None, "UTC"),
        (INSTANT, None),
        (INSTANT, ""),
        (INSTANT, "Europe/Unknown"),
        (INSTANT, "+05:30"),
        (INSTANT, "../UTC"),
        (INSTANT, "localtime"),
        (INSTANT, "right/UTC"),
        (INSTANT, "UTC\n"),
        (datetime.min.replace(tzinfo=timezone(timedelta(hours=1))), "UTC"),
        (datetime.max.replace(tzinfo=UTC), "Pacific/Kiritimati"),
        (datetime(2026, 1, 1, tzinfo=BrokenTimezone()), "UTC"),
    ],
)
def test_unavailable_time_facts_do_not_expose_validation_details(instant, zone):
    assert_reason("facts_unavailable", render, "trial_start", WorkflowEventTimeValue(instant, zone))


@pytest.mark.parametrize(
    "value,expected",
    [(date.min, "0001-01-01"), (date.max, "9999-12-31"), (date(2024, 2, 29), "2024-02-29")],
)
def test_date_only_values_preserve_calendar_date(value, expected):
    assert render("invoice_due_date", value).text_body == expected


def test_footer_bytes_and_literal_assembly_braces():
    body = 'Body\t<plain> & "quoted"\n{{literal}}'
    content = assemble_plain_text_email("Subject", body, URL)
    assert content.text_body == body + "\n\nUnsubscribe from these reminders: " + URL
    assert (
        content.html_body
        == '<div style="white-space: pre-wrap">'
        + escape(body)
        + '</div><p><a href="'
        + escape(URL, quote=True)
        + '">Unsubscribe from these reminders</a></p>'
    )
    plain = assemble_plain_text_email("Subject", body)
    assert plain.text_body == body
    assert plain.html_body == '<div style="white-space: pre-wrap">' + escape(body) + "</div>"
    assert render_workflow_email(
        "lead.created", "Subject", "Body", {}, unsubscribe_url=URL
    ) == assemble_plain_text_email("Subject", "Body", URL)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "http://example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://user:pass@example.com",
        "https://example.com:443x",
        "https://[broken",
        "https://example.com/\n",
        "https://example.com/#short",
        "https://example.com/" + "x" * 2048,
        True,
        {},
    ],
)
def test_footer_reuses_unchanged_safe_url_policy(url):
    assert_reason(
        "invalid_email_url",
        render_workflow_email,
        "lead.created",
        "Subject",
        "Body",
        {},
        unsubscribe_url=url,
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/path\ud800",
        StringSubclass("https://example.com/path"),
        NoStringCoercion(),
    ],
)
def test_graph_url_requires_exact_utf8_string_after_expanded_text_validation(url):
    assert_reason(
        "invalid_email_url",
        render_workflow_email,
        "lead.created",
        "Subject",
        "Body",
        {},
        unsubscribe_url=url,
    )
    assert_reason(
        "invalid_email_context",
        render_workflow_email,
        "lead.created",
        "{{studio_name}}",
        "Body",
        {"studio_name": "x" * 201},
        unsubscribe_url=url,
    )
    if isinstance(url, str):
        assert render_missed_class_email("Subject", "Body", {}, url).text_body.endswith(url)


@pytest.mark.parametrize(
    "subject,body",
    [
        (None, "Body"),
        ("Subject", None),
        ("", "Body"),
        ("Subject", " "),
        ("Subject\n", "Body"),
        ("Subject", "Body\r"),
        ("Subject", "Body\x85"),
        ("x" * 201, "Body"),
        ("Subject", "x" * 20001),
    ],
)
def test_assembly_validates_text_before_url(subject, body):
    with pytest.raises(ValueError, match="^invalid_email_context$"):
        assemble_plain_text_email(subject, body, "unsafe")


def test_required_footer_keyword_and_private_frozen_values():
    with pytest.raises(TypeError):
        render_workflow_email("lead.created", "Subject", "Body", {})
    assert repr(EVENT_TIME) == "WorkflowEventTimeValue()"
    assert repr(FACTS["invoice_balance"]) == "WorkflowMoneyValue()"
    assert repr(render("recipient_name", "Synthetic recipient")) == "EmailContent()"
    with pytest.raises(FrozenInstanceError):
        EVENT_TIME.timezone = "UTC"
    with pytest.raises(FrozenInstanceError):
        FACTS["invoice_balance"].currency = "JPY"
    for reason in (
        "facts_unavailable",
        "unsupported_currency",
        "invalid_email_template",
        "invalid_email_context",
        "invalid_email_url",
    ):
        error = WorkflowEmailRenderError(reason)
        with pytest.raises(AttributeError):
            error.reason = "invalid_email_url"
        assert str(error) == reason
    with pytest.raises(ValueError, match="^invalid_workflow_email_render_reason$"):
        WorkflowEmailRenderError("synthetic private fact")
