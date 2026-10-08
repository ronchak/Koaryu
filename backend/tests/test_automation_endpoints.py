"""Synthetic HTTP coverage. No service credentials, provider calls, or hosted data."""

import asyncio
import base64
import hashlib
import re
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import automations
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.automation import MissedClassProcessRequest, MissedClassProcessResponse
from app.services.automation_email import DEFAULT_MISSED_CLASS_BODY, DEFAULT_MISSED_CLASS_SUBJECT
from tests.fakes.supabase import TableBackedSupabase

DRAFT = {
    "inactivity_days": 14,
    "subject_template": DEFAULT_MISSED_CLASS_SUBJECT,
    "body_template": DEFAULT_MISSED_CLASS_BODY,
    "reply_to_email": "reply@example.com",
}
UPDATE = {**DRAFT, "enabled": False, "expected_revision": 0}
BASE = "/api/v1/automations/missed-class"
INTERNAL = "/api/v1/internal/automations/missed-class/process-due"
OPTOUT = "/api/v1/automations/unsubscribe"


class Database(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {
                        "user_id": "actor",
                        "studio_id": "studio",
                        "role": "admin",
                        "archived_at": None,
                    }
                ]
            }
        )
        self.rpc_calls = []
        self.handlers = {"get_missed_class_automation_rule_v1": {"rule": None}}

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))

        def execute():
            handler = self.handlers[name]
            if isinstance(handler, Exception):
                raise handler
            return SimpleNamespace(data=handler(params) if callable(handler) else handler)

        return SimpleNamespace(execute=execute)


@pytest.fixture
def api(monkeypatch):
    database = Database()
    settings = SimpleNamespace(
        EMAIL_PROVIDER="disabled",
        EMAIL_SEND_ENABLED=False,
        EMAIL_FROM_ADDRESS="koaryu@outlook.com",
        EMAIL_REPLY_TO="reply@example.com",
        EMAIL_ALLOWED_RECIPIENTS="koaryu@outlook.com",
        AUTOMATION_WORKER_ENABLED=False,
        AUTOMATION_WORKER_SECRET="synthetic-worker-secret",
    )
    monkeypatch.setattr(automations, "get_settings", lambda: settings)
    subscription = Mock()
    monkeypatch.setattr(automations, "ensure_platform_subscription_access", subscription)
    app = FastAPI()
    app.include_router(automations.router, prefix="/api/v1")
    app.include_router(automations.worker_router, prefix="/api/v1")
    app.dependency_overrides[get_current_user_id] = lambda: "actor"
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield client, database, settings, subscription


def test_missing_rule_get_uses_provider_defaults_and_does_not_write(api):
    client, database, settings, subscription = api
    settings.EMAIL_REPLY_TO = ""
    response = client.get(BASE, headers={"X-Studio-Id": " studio "})
    assert response.status_code == 200
    assert response.json() == {
        "rule": {
            "enabled": False,
            **DRAFT,
            "reply_to_email": "koaryu@outlook.com",
            "revision": 0,
            "updated_at": None,
        },
        "delivery_status": {
            "mode": "disabled",
            "configured": False,
            "can_enable": False,
            "sender": "koaryu@outlook.com",
            "test_recipient": "koaryu@outlook.com",
            "reason": "sending_disabled",
        },
    }
    assert database.rpc_calls == [
        ("get_missed_class_automation_rule_v1", {"p_studio_id": "studio", "p_actor_id": "actor"})
    ]
    subscription.assert_called_once_with(database, "studio")


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("get", BASE, None),
        ("put", BASE, UPDATE),
        ("post", BASE + "/preview", DRAFT),
        ("get", BASE + "/activity", None),
    ],
)
@pytest.mark.parametrize("denial", ["front_desk", "instructor", "archived", "ambiguous", "foreign"])
def test_all_admin_routes_check_membership_before_subscription_or_contacts(
    api, method, path, payload, denial
):
    client, database, _, subscription = api
    membership = database.tables["staff_roles"][0]
    headers = {}
    if denial in {"front_desk", "instructor"}:
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-01"
    elif denial == "ambiguous":
        database.tables["staff_roles"].append({**membership, "studio_id": "other"})
    else:
        headers["X-Studio-Id"] = "other"
    response = client.request(method, path, json=payload, headers=headers)
    assert response.status_code == (409 if denial == "ambiguous" else 403)
    subscription.assert_not_called()
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("get", BASE, None),
        ("put", BASE, UPDATE),
        ("post", BASE + "/preview", DRAFT),
        ("get", BASE + "/activity", None),
    ],
)
def test_subscription_required_blocks_all_routes_before_contacts(api, method, path, payload):
    client, database, _, subscription = api
    subscription.side_effect = HTTPException(402, {"code": "SUBSCRIPTION_REQUIRED"})
    assert client.request(method, path, json=payload).status_code == 402
    assert database.rpc_calls == []


def test_cookie_selector_is_authoritative_and_header_takes_precedence(api):
    client, database, _, _ = api
    client.cookies.set("koaryu-active-studio", "other")
    assert client.get(BASE).status_code == 403
    assert not database.rpc_calls
    assert client.get(BASE, headers={"X-Studio-Id": "studio"}).status_code == 200


def test_disabled_save_allowed_without_setup_but_enable_is_refused(api):
    client, database, _, _ = api
    database.handlers["save_missed_class_automation_rule_v1"] = {
        "rule": {**DRAFT, "enabled": False, "revision": 1, "updated_at": "2026-10-04"}
    }
    response = client.put(BASE, json={**UPDATE, "reply_to_email": " Reply@Example.COM "})
    assert response.status_code == 200
    assert database.rpc_calls[-1][1]["p_reply_to_email"] == "reply@example.com"
    count = len(database.rpc_calls)
    assert client.put(BASE, json={**UPDATE, "enabled": True}).status_code == 409
    assert len(database.rpc_calls) == count


@pytest.mark.parametrize(
    "code,message,status",
    [
        ("P0001", "AUTOMATION_RULE_CONFLICT", 409),
        ("P0001", "AUTOMATION_STUDIO_BUSY", 503),
        ("42501", "secret database details", 403),
        ("22023", "secret database details", 422),
        ("PGRST202", "secret database details", 503),
    ],
)
def test_sql_errors_are_safely_mapped(api, code, message, status):
    client, database, _, _ = api
    database.handlers["save_missed_class_automation_rule_v1"] = APIError(
        {"code": code, "message": message, "details": "private", "hint": "private"}
    )
    response = client.put(BASE, json=UPDATE)
    assert response.status_code == status
    assert message not in response.text
    assert "private" not in response.text


@pytest.mark.parametrize(
    "changes",
    [
        {"subject_template": "{{unknown}}"},
        {"subject_template": "hi\r\nBcc: other@example.com"},
        {"subject_template": "a" * 201},
        {"body_template": "a" * 5001},
        {"body_template": " "},
        {"body_template": "{{ student_first_name }}"},
        {"reply_to_email": "Name <test@example.com>"},
        {"reply_to_email": "a@example.com\n"},
        {"inactivity_days": 0},
        {"inactivity_days": 91},
        {"inactivity_days": True},
        {"expected_revision": -1},
        {"studio_id": "foreign"},
    ],
)
def test_update_rejects_invalid_fields_before_writing(api, changes):
    client, database, _, _ = api
    assert client.put(BASE, json={**UPDATE, **changes}).status_code == 422
    assert database.rpc_calls == []


def preview_row(index=0, **changes):
    return {
        "student_id": str(index),
        "student_name": "Sam Example",
        "student_first_name": "Sam",
        "studio_name": "Example Studio",
        "days_absent": 20,
        "last_attendance_date": "2026-09-14",
        "recipient_name": "Sam",
        "recipient_email": "sam@example.com",
        "recipient_kind": "student",
        "skip_reason": None,
        "unsubscribe_token": "must-not-leak",
        **changes,
    }


def test_preview_renders_actual_defaults_caps_rows_preserves_totals_and_never_sends(
    api, monkeypatch
):
    client, database, _, _ = api
    send = Mock(side_effect=AssertionError("No preview send"))
    monkeypatch.setattr("app.services.automation_service.build_email_transport", send)
    database.handlers["preview_missed_class_automation_v1"] = {
        "reference_date": "2026-10-04",
        "eligible_count": 120,
        "skipped_count": 1,
        "recipients": [preview_row()] + [preview_row(i) for i in range(1, 120)],
        "truncated": True,
    }
    response = client.post(BASE + "/preview", json=DRAFT)
    assert response.status_code == 200
    data = response.json()
    assert data["eligible_count"] == 120 and data["skipped_count"] == 1 and data["truncated"]
    assert len(data["recipients"]) == 100
    assert data["recipients"][0]["rendered_subject"] == "We miss seeing Sam at Example Studio"
    assert "Unsubscribe" not in data["recipients"][0]["rendered_body"]
    assert "must-not-leak" not in response.text and "student_first_name" not in response.text
    assert [name for name, _ in database.rpc_calls] == ["preview_missed_class_automation_v1"]
    send.assert_not_called()


def test_preview_reports_skip_without_rendering_and_rejects_context_overflow(api):
    client, database, _, _ = api
    result = {
        "reference_date": "2026-10-04",
        "eligible_count": 0,
        "skipped_count": 1,
        "recipients": [
            preview_row(skip_reason="guardian_ambiguous", recipient_email=None, recipient_kind=None)
        ],
        "truncated": False,
    }
    database.handlers["preview_missed_class_automation_v1"] = result
    response = client.post(BASE + "/preview", json=DRAFT)
    assert response.status_code == 200
    assert response.json()["recipients"][0]["rendered_body"] is None
    result["recipients"] = [preview_row(student_first_name="x" * 200)]
    assert client.post(BASE + "/preview", json=DRAFT).status_code == 422


def test_activity_contract_sanitizes_internal_fields_and_uses_accepted(api):
    client, database, _, _ = api
    item = {
        "id": "delivery",
        "student_id": "student",
        "student_name": "Sam",
        "recipient_email": "sam@example.com",
        "state": "accepted",
        "created_at": "2026-10-04",
        "attempted_at": "2026-10-04",
        "settled_at": "2026-10-04",
        "attempts": 1,
        "reason": None,
        "claim_token": "secret",
        "unsubscribe_token": "secret",
        "provider_request_id": "secret",
    }
    database.handlers["get_missed_class_automation_activity_v1"] = {
        "items": [item],
        "has_more": True,
    }
    response = client.get(BASE + "/activity?limit=25")
    assert response.status_code == 200 and response.json()["items"][0]["state"] == "accepted"
    assert "secret" not in response.text and "delivered" not in response.text
    assert database.rpc_calls[-1][1]["p_limit"] == 25
    item["reason"] = "private-provider-error"
    response = client.get(BASE + "/activity")
    assert response.status_code == 503 and "private-provider-error" not in response.text
    assert client.get(BASE + "/activity?limit=101").status_code == 422


def test_unsubscribe_get_is_static_nonmutating_with_exact_script_csp(api):
    client, database, _, _ = api
    token = "a" * 64
    response = client.get(OPTOUT + "#" + token)
    assert response.status_code == 200
    assert database.rpc_calls == [] and token not in response.text
    assert response.request.url.path == OPTOUT and not response.request.url.query
    script = re.search(r"<script>(.*?)</script>", response.text, re.IGNORECASE).group(1)
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    assert "'sha256-" + digest + "'" in response.headers["content-security-policy"]
    assert "location.hash.slice(1)" in script and "history.replaceState" in script
    assert 'method="post"' in response.text and 'type="hidden"' in response.text
    assert "Confirm unsubscribe</button>" in response.text
    assert "<title>Unsubscribe from studio automation emails</title>" in response.text
    assert "<h1>Unsubscribe from studio automation emails</h1>" in response.text
    assert (
        "Confirm to stop all current and future automation emails from this one studio "
        "to the recipient email address that received this email. "
        "This includes missed-class reminders."
    ) in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "https://" not in response.text
    assert client.get(OPTOUT + "/" + token).status_code == 404


def test_unsubscribe_post_valid_invalid_missing_and_repeat_are_generic(api):
    client, database, _, _ = api
    database.handlers["suppress_missed_class_automation_v1"] = {"success": True}
    token = "a" * 64
    responses = [
        client.post(OPTOUT, data=data)
        for data in ({"token": token}, {"token": token}, {"token": "invalid"}, {})
    ]
    assert {r.status_code for r in responses} == {200}
    assert len({r.text for r in responses}) == 1
    assert token not in responses[0].text
    assert "<title>Studio automation email preference</title>" in responses[0].text
    assert (
        "If the link was valid, all current and future automation emails from this studio "
        "to the recipient email address are now unsubscribed."
    ) in responses[0].text
    assert [params["p_token"] for _, params in database.rpc_calls] == [token, token, "invalid", ""]
    assert all(r.headers["cache-control"] == "no-store" for r in responses)
    client.post(OPTOUT + "?token=" + token, json={"token": token, "recipient": "other@example.com"})
    assert database.rpc_calls[-1][1] == {"p_token": ""}


def test_worker_secret_precedes_client_and_disabled_is_zero_work(api, monkeypatch):
    client, database, settings, _ = api
    factory = Mock(side_effect=AssertionError("No client"))
    monkeypatch.setattr("app.services.automation_service.create_supabase_client", factory)
    assert client.post(INTERNAL, json={}, headers={"X-Internal-Secret": "wrong"}).status_code == 403
    response = client.post(
        INTERNAL, json={}, headers={"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
    )
    assert response.status_code == 200
    assert response.json() == MissedClassProcessResponse().model_dump()
    assert database.rpc_calls == []
    factory.assert_not_called()


@pytest.mark.parametrize("payload", [{"limit": 0}, {"limit": 11}, {"limit": True}, {"other": 1}])
def test_worker_input_is_bounded_and_forbids_unknown_fields(api, payload):
    client, _, settings, _ = api
    assert (
        client.post(
            INTERNAL, json=payload, headers={"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
        ).status_code
        == 422
    )


def test_worker_runs_off_event_loop_and_passes_deadline(monkeypatch):
    loop_thread = threading.get_ident()
    settings = SimpleNamespace(AUTOMATION_WORKER_SECRET="synthetic-secret")
    monkeypatch.setattr(automations, "get_settings", lambda: settings)
    seen = {}

    def process(actual_settings, **kwargs):
        assert actual_settings is settings
        seen.update(kwargs, thread=threading.get_ident())
        return MissedClassProcessResponse()

    monkeypatch.setattr(automations, "process_due_missed_class_automations", process)
    asyncio.run(
        automations.process_due_missed_class(MissedClassProcessRequest(limit=3), "synthetic-secret")
    )
    assert seen["thread"] != loop_thread and seen["limit"] == 3
    assert isinstance(seen["deadline_monotonic"], float)


def test_registered_openapi_has_exact_public_route_shapes():
    from app.api.v1.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    spec = app.openapi()
    assert set(spec["paths"][BASE]) == {"get", "put"}
    assert "post" in spec["paths"][INTERNAL]
    combined = spec["paths"]["/api/v1/internal/automations/process-due"]["post"]
    assert combined["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/AutomationBatchResponse"
    }
    assert spec["paths"][INTERNAL]["post"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ] == {"$ref": "#/components/schemas/MissedClassProcessResponse"}
    for name in (
        "MissedClassRuleResponse",
        "MissedClassRuleUpdate",
        "MissedClassPreviewRequest",
        "MissedClassPreviewResponse",
        "MissedClassActivityResponse",
        "MissedClassSettingsResponse",
    ):
        assert name in spec["components"]["schemas"]


@pytest.mark.parametrize(
    "payload", [{}, {"rule": "wrong"}, {"rule": {"reply_to_email": "a@example.com"}}]
)
def test_malformed_rule_read_does_not_fabricate_defaults(api, payload):
    client, database, _, _ = api
    database.handlers["get_missed_class_automation_rule_v1"] = payload
    assert client.get(BASE).status_code == 503


@pytest.mark.parametrize(
    "payload", [{}, {"rule": None}, {"rule": {"reply_to_email": "a@example.com"}}]
)
def test_malformed_save_response_does_not_claim_saved_defaults(api, payload):
    client, database, _, _ = api
    database.handlers["save_missed_class_automation_rule_v1"] = payload
    assert client.put(BASE, json=UPDATE).status_code == 503


def test_reply_to_normalizes_before_normalized_length_bound():
    from app.schemas.automation import MissedClassPreviewRequest

    address = "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 61
    assert len(address) == 254
    draft = MissedClassPreviewRequest(**{**DRAFT, "reply_to_email": " " + address + " "})
    assert draft.reply_to_email == address


def test_unsubscribe_invalid_fragment_has_accessible_error_and_disabled_button(api):
    client, database, _, _ = api
    response = client.get(OPTOUT)
    assert 'id="confirm" type="submit" disabled' in response.text
    assert 'id="link-error" role="status" aria-live="polite"' in response.text
    assert "/^[a-f0-9]{64}$/.test(token)" in response.text
    assert (
        "This unsubscribe link is missing or invalid. Please open the link from your email."
        in response.text
    )
    assert database.rpc_calls == []


def test_unsubscribe_database_fault_has_private_generic_page_and_headers(api):
    client, database, _, _ = api
    database.handlers["suppress_missed_class_automation_v1"] = RuntimeError("private DB text")
    token = "a" * 64
    response = client.post(OPTOUT, data={"token": token})
    assert response.status_code == 503
    assert token not in response.text and "private DB text" not in response.text
    assert "<title>Studio automation email preference</title>" in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_worker_default_body_and_unsafe_secret_do_not_create_client(api, monkeypatch):
    client, _, settings, _ = api
    factory = Mock(side_effect=AssertionError("No client"))
    monkeypatch.setattr("app.services.automation_service.create_supabase_client", factory)
    assert (
        client.post(
            INTERNAL, headers={"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
        ).status_code
        == 200
    )
    settings.AUTOMATION_WORKER_SECRET = "bad\nsecret"
    assert client.post(INTERNAL, json={}, headers={"X-Internal-Secret": "bad"}).status_code == 503
    factory.assert_not_called()


COMBINED = "/api/v1/internal/automations/process-due"


def test_combined_auth_precedes_runtime_lookup_and_disabled_is_unavailable(api):
    client, _, settings, _ = api

    class ForbiddenState:
        def __getattr__(self, name):
            raise AssertionError("unauthorized runtime lookup")

    client.app.state = ForbiddenState()
    for secret in (None, "wrong"):
        headers = {} if secret is None else {"X-Internal-Secret": secret}
        assert client.post(COMBINED, json={}, headers=headers).status_code == 403
    response = client.post(
        COMBINED, headers={"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Automation batch is unavailable."}


@pytest.mark.parametrize(
    "payload",
    [
        {"limit": 0},
        {"limit": 11},
        {"limit": True},
        {"limit": "1"},
        {"clock": 1},
        {"first_engine": "workflows"},
    ],
)
def test_combined_input_preserves_strict_request_contract(api, payload):
    client, _, settings, _ = api
    response = client.post(
        COMBINED, json=payload, headers={"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
    )
    assert response.status_code == 422


def test_combined_response_deadline_default_limit_and_safe_failures(api):
    from unittest.mock import AsyncMock

    from test_automation_batch import batch_summary

    from app.core.request_deadline import request_deadline
    from app.schemas.automation_batch import AutomationBatchResponse
    from app.services.automation_coordinator import AutomationBatchUnavailable
    from app.services.automation_scheduler import AutomationBatchBusy

    client, _, settings, _ = api
    settings.AUTOMATION_WORKER_ENABLED = True
    headers = {"X-Internal-Secret": settings.AUTOMATION_WORKER_SECRET}
    assert client.post(COMBINED, headers=headers).status_code == 503
    scheduler = SimpleNamespace(
        run_once=AsyncMock(return_value=AutomationBatchResponse.model_validate(batch_summary()))
    )
    client.app.state.automation_scheduler = scheduler
    token = request_deadline.set(123.0)
    try:
        response = client.post(COMBINED, headers=headers)
    finally:
        request_deadline.reset(token)
    assert response.status_code == 200 and response.json() == batch_summary()
    scheduler.run_once.assert_awaited_once_with(limit=10, deadline_monotonic=123.0)
    for error, status, detail in [
        (AutomationBatchBusy(), 409, "Automation batch is already running."),
        (AutomationBatchUnavailable(), 503, "Automation batch is unavailable."),
    ]:
        scheduler.run_once.side_effect = error
        response = client.post(COMBINED, json={"limit": 1}, headers=headers)
        assert response.status_code == status
        assert response.json() == {"detail": detail}
        if status == 409:
            assert response.headers["retry-after"] == "60"
    settings.AUTOMATION_WORKER_SECRET = "bad\nsecret"
    scheduler.run_once.reset_mock()
    assert client.post(COMBINED, headers={"X-Internal-Secret": "bad"}).status_code == 503
    scheduler.run_once.assert_not_called()
