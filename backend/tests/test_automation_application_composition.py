"""Source wiring checks only. No SQL/readiness/provider success is claimed."""

import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest
from postgrest.exceptions import APIError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location(
    "application_composition", ROOT / "scripts/verify-automation-application-composition.py"
)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
IDS = {
    "actor": "10000000-0000-4000-8000-000000000001",
    "studio": "20000000-0000-4000-8000-000000000001",
}


@pytest.fixture
def bridge():
    statements = []

    def sql(statement):
        statements.append(statement)
        if "application_composition_proof.rpc(" in statement and statement.startswith("SET ROLE"):
            return json.dumps({"ok": False, "code": "42501", "message": "workflow_admin_required"})
        return "[]"

    return proof.SqlBridge(sql, IDS), statements


@pytest.mark.parametrize(
    "template",
    [
        "postgres",
        "template1",
        "koaryu_v56_base",
        "koaryu_v57;DROP DATABASE postgres",
        "koaryu_v57_" + "x" * 64,
    ],
)
def test_rejects_unowned_template_before_any_database_call(template):
    with pytest.raises(RuntimeError, match="explicit owned"), proof.owned_clone(None, template):
        pytest.fail("Invalid template admitted")


def test_current_nonfinal_declarations_refuse_without_database_access():
    from app.services.generated_release_readiness import EXPECTED_RELEASE_MANIFEST_VERSION

    if EXPECTED_RELEASE_MANIFEST_VERSION == "release-db-attestation-v57":
        pytest.skip(
            "Final declarations have landed; actual database execution remains separately gated"
        )
    with (
        pytest.raises(RuntimeError, match="Final generated V57"),
        proof.owned_clone(None, "koaryu_final_v57_template"),
    ):
        pytest.fail("Nonfinal release admitted")


@pytest.mark.parametrize(
    "method,path,params",
    [
        ("POST", "/rest/v1/leads", {}),
        ("GET", "/rest/v1/leads", {"select": "*", "studio_id": "eq." + IDS["studio"]}),
        ("GET", "/rest/v1/staff_roles", {"select": "*"}),
        ("GET", "/auth/v1/admin/users/foreign", {}),
        ("GET", "/rest/v1/unknown", {}),
    ],
)
def test_adapter_refuses_unapproved_reads_and_all_table_writes(bridge, method, path, params):
    adapter, statements = bridge
    before = len(statements)
    with pytest.raises(RuntimeError):
        adapter(httpx.Request(method, "https://composition.example.invalid" + path, params=params))
    assert len(statements) == before


def test_sdk_parses_actual_sql_error_shape_without_generic_rpc_dispatch(bridge):
    adapter, statements = bridge
    from app.db.supabase import close_supabase_client

    client = adapter.client()
    try:
        with pytest.raises(APIError) as error:
            client.rpc(
                "get_automation_workflow_v1",
                {
                    "p_studio_id": IDS["studio"],
                    "p_actor_id": IDS["actor"],
                    "p_workflow_id": IDS["studio"],
                },
            ).execute()
        assert error.value.code == "42501"
        assert error.value.message == "workflow_admin_required"
        before = len(statements)
        with pytest.raises(RuntimeError, match="contract"):
            client.rpc("arbitrary_function", {}).execute()
        with pytest.raises(RuntimeError, match="contract"):
            client.rpc("get_automation_workflow_v1", {"p_studio_id": IDS["studio"]}).execute()
        assert len(statements) == before
        assert client.postgrest.session.timeout.read == 5.0
        assert client.postgrest.session.follow_redirects is False
    finally:
        close_supabase_client(client)


def test_typed_recipient_array_is_distinct_from_jsonb_nested_lists():
    assert (
        proof.rpc_value("p_allowed_recipients", ["o'hara@example.invalid"])
        == "ARRAY['o''hara@example.invalid']::TEXT[]"
    )
    assert proof.rpc_value("p_allowed_recipients", []) == "ARRAY[]::TEXT[]"
    assert proof.rpc_value("p_graph", {"nodes": []}) == "'{\"nodes\":[]}'"
    assert proof.rpc_value("p_request", [1, 2]) == "'[1,2]'"
    assert proof.quote(False) == "'false'"
    with pytest.raises(RuntimeError):
        proof.quote("bad\x00text")


def test_sdk_lost_reply_is_after_sql_returns_and_is_one_shot(bridge):
    adapter, statements = bridge
    # Transport-only opaque success, never readiness or application authority.
    adapter.sql = lambda statement: (
        statements.append(statement)
        or json.dumps({"ok": True, "data": {"opaque": "transport-only"}})
    )
    adapter.lose_reply = "get_automation_email_credential_v1"
    request = httpx.Request(
        "POST",
        "https://composition.example.invalid/rest/v1/rpc/get_automation_email_credential_v1",
        json={"p_provider_key": "microsoft_graph:primary"},
    )
    before = len(statements)
    with pytest.raises(httpx.ReadTimeout):
        adapter(request)
    assert len(statements) == before + 1
    assert adapter.lose_reply is None


def test_graph_and_mail_configuration_use_real_validators():
    from app.schemas.workflow import WorkflowGraph
    from app.services.automation_email import delivery_configuration
    from app.services.workflow_catalog import CATALOG
    from app.services.workflow_graph import validate_workflow_graph

    value = WorkflowGraph.model_validate(proof.graph())
    assert validate_workflow_graph(value, catalog=CATALOG).valid
    config = delivery_configuration(proof.settings_for(IDS))
    assert config.allowed_recipients == frozenset()


def test_receipt_rpc_matches_real_management_owner():
    assert "get_automation_operation_v1" in proof.rpc_contracts()
    assert "get_automation_command_operation_v1" not in proof.rpc_contracts()


def test_fixed_membership_read_accepts_only_exact_actor_filter(bridge):
    from app.services.studio_scope import STAFF_ROLE_MEMBERSHIP_COLUMNS

    adapter, statements = bridge
    request = httpx.Request(
        "GET",
        "https://composition.example.invalid/rest/v1/staff_roles",
        params={
            "select": STAFF_ROLE_MEMBERSHIP_COLUMNS,
            "user_id": "eq." + IDS["actor"],
            "order": "created_at.desc",
        },
    )
    assert adapter(request).json() == []
    assert "SET ROLE service_role" in statements[-1]
    assert "WHERE user_id='" + IDS["actor"] + "'" in statements[-1]
    before = len(statements)
    bad = httpx.Request("GET", str(request.url) + "&user_id=eq.foreign")
    with pytest.raises(RuntimeError, match="Repeated filters"):
        adapter(bad)
    assert len(statements) == before


def test_positive_sdk_reads_use_actual_membership_and_single_row_owners():
    from datetime import datetime

    from app.db.supabase import close_supabase_client
    from app.services.demo_data_access import DemoDataAccess
    from app.services.platform_billing_service import PlatformBillingService
    from app.services.studio_scope import list_staff_roles_for_user

    # Synthetic callback rows test SDK serialization/parsing only, not SQL authority.
    instant = "2026-10-07T12:00:00+00:00"
    membership = {
        "studio_id": IDS["studio"],
        "role": "admin",
        "created_at": instant,
        "archived_at": None,
    }
    subscription = {"studio_id": IDS["studio"], "status": "active", "comped": False}
    auth_user = {
        "id": IDS["actor"],
        "email": "actor@example.invalid",
        "email_confirmed_at": instant,
        "aud": "authenticated",
        "role": "authenticated",
        "created_at": instant,
        "app_metadata": {},
        "user_metadata": {},
    }
    reads = []

    def sql(statement):
        if statement.startswith("CREATE SCHEMA"):
            return ""
        reads.append(statement)
        if "FROM public.staff_roles WHERE" in statement:
            return json.dumps([membership])
        if "FROM public.studio_subscriptions WHERE" in statement:
            return json.dumps([subscription])
        if "FROM public.studios WHERE" in statement:
            return json.dumps([{"name": "Synthetic composition studio"}])
        if "FROM auth.users WHERE" in statement:
            return json.dumps(auth_user)
        pytest.fail("Unexpected SQL request in read-only SDK test")

    adapter = proof.SqlBridge(sql, IDS)
    client = adapter.client()
    try:
        assert list_staff_roles_for_user(client, IDS["actor"]) == [membership]
        assert (
            PlatformBillingService(client)._select_subscription_result(IDS["studio"]).data
            == subscription
        )
        assert DemoDataAccess(client).studio_name(IDS["studio"]) == "Synthetic composition studio"
        user = client.auth.admin.get_user_by_id(IDS["actor"]).user
        assert user.id == IDS["actor"]
        assert user.email == auth_user["email"]
        assert user.email_confirmed_at == datetime.fromisoformat(instant)
        assert len(reads) == 4
        assert all("WHERE" in statement for statement in reads)
    finally:
        close_supabase_client(client)


@pytest.mark.parametrize(
    "event", ["trial.scheduled", "belt_test.approved", "invoice.payment_failed"]
)
def test_representative_graphs_use_real_catalog_validation(event):
    from app.schemas.workflow import WorkflowGraph
    from app.services.workflow_catalog import CATALOG
    from app.services.workflow_graph import validate_workflow_graph

    value = WorkflowGraph.model_validate(proof.graph(event))
    assert validate_workflow_graph(value, catalog=CATALOG).valid


def test_representative_command_window_and_recipient_jsonb():
    from app.schemas.belt_test import BeltTestEventCreate
    from app.schemas.belt_test_recipient import BeltTestRecipientApprove
    from app.schemas.trial_appointment import TrialAppointmentCreate

    window = proof.future_window()
    trial = TrialAppointmentCreate.model_validate(
        {
            "operation_id": IDS["actor"],
            **window,
            "location": "Trial room",
            "program_id": IDS["studio"],
        }
    )
    event = BeltTestEventCreate.model_validate(
        {
            "operation_id": IDS["actor"],
            **window,
            "name": "Composition belt test",
            "ladder_id": IDS["studio"],
            "status": "scheduled",
            "location": "Belt room",
        }
    )
    recipients = [{"student_id": IDS["actor"], "student_program_membership_id": None}]
    BeltTestRecipientApprove.model_validate(
        {
            "operation_id": IDS["actor"],
            "expected_event_revision": 1,
            "recipients": recipients,
        }
    )
    assert event.starts_at == trial.starts_at
    assert proof.display_instant(window["starts_at"]).endswith("+00:00 [UTC]")
    assert proof.rpc_value("p_recipients", recipients) == proof.quote(recipients)
    assert "TEXT[]" not in proof.rpc_value("p_recipients", recipients)


@pytest.mark.parametrize(
    "name",
    [
        "mutate_lead_trial_appointment_v1",
        "get_lead_trial_appointment_v1",
        "mutate_belt_test_event_v1",
        "get_belt_test_event_v1",
        "approve_belt_test_recipients_v1",
        "get_belt_test_recipient_v1",
    ],
)
def test_representative_bridge_exact_arguments_and_refusals(bridge, name):
    adapter, statements = bridge
    params = {key: IDS["actor"] for key in adapter.contracts[name]}
    for key in ("p_expected_revision", "p_expected_event_revision"):
        if key in params:
            params[key] = 1
    if "p_request" in params:
        params["p_request"] = {"action": "create"}
    if "p_recipients" in params:
        params["p_recipients"] = [
            {"student_id": IDS["actor"], "student_program_membership_id": None}
        ]
    url = "https://composition.example.invalid/rest/v1/rpc/" + name
    # Only SQL error transport is returned. This establishes no domain success.
    assert adapter(httpx.Request("POST", url, json=params)).status_code == 400
    assert "SELECT public." + name + "(" in statements[-1]
    if "p_recipients" in params:
        assert "p_recipients=>" in statements[-1] and "::TEXT[]" not in statements[-1]
    before = len(statements)
    for bad in ({**params, "extra": True}, {k: v for k, v in params.items() if k != "p_actor_id"}):
        with pytest.raises(RuntimeError, match="contract"):
            adapter(httpx.Request("POST", url, json=bad))
    assert len(statements) == before


def test_served_forwarding_preserves_owner_body_errors_and_current_response():
    calls = []

    def transport(request):
        calls.append(request)
        return httpx.Response(
            503, content=b'{"detail":"unavailable"}', headers={"X-Request-Id": "opaque"}
        )

    with httpx.Client(
        base_url="http://testserver", transport=httpx.MockTransport(transport)
    ) as client:
        client.headers.clear()
        headers = {
            "Authorization": "Bearer composition-synthetic-token",
            "X-Studio-Id": IDS["studio"],
            "Cookie": "koaryu-active-studio=" + IDS["studio"],
            "Content-Type": "application/json",
        }
        body = b'{"operation_id":"opaque"}'
        reply = proof.forward_served_request(
            client, "POST", "/api/v1/automations/workflows", headers, body
        )
        assert reply.status_code == 503 and reply.content == b'{"detail":"unavailable"}'
        assert reply.headers["X-Request-Id"] == "opaque"
        assert calls[0].content == body
        assert calls[0].headers["X-Studio-Id"] == IDS["studio"]
        assert calls[0].headers["Cookie"] == headers["Cookie"]
        proof.forward_served_request(client, "GET", "/api/v1/automations/catalog", {}, b"")
        assert "Authorization" not in calls[-1].headers and "X-Studio-Id" not in calls[-1].headers
        client.headers["Authorization"] = "must-not-be-injected"
        with pytest.raises(RuntimeError, match="inject owner"):
            proof.forward_served_request(client, "GET", "/api/v1/automations/catalog", {}, b"")


@pytest.mark.parametrize(
    "method,target,body",
    [
        ("GET", "http://example.invalid/api/v1/automations/catalog", b""),
        ("GET", "//example.invalid/api/v1/automations/catalog", b""),
        ("GET", "/api/v1/automations/catalog#fragment", b""),
        ("GET", "/api/v1/students", b""),
        ("DELETE", "/api/v1/automations/workflows", b""),
        ("POST", "/api/v1/automations/workflows", b"x" * (proof.MAX_REQUEST_BYTES + 1)),
    ],
)
def test_served_refusals_do_not_forward(method, target, body):
    def unexpected(_request):
        pytest.fail("Refused request reached application")

    with (
        httpx.Client(transport=httpx.MockTransport(unexpected)) as client,
        pytest.raises(RuntimeError),
    ):
        proof.forward_served_request(client, method, target, {}, body)


def test_served_redirect_is_not_followed():
    calls = []

    def redirect(request):
        calls.append(request)
        return httpx.Response(307, headers={"Location": "https://example.invalid"})

    with (
        httpx.Client(
            base_url="http://testserver", transport=httpx.MockTransport(redirect)
        ) as client,
        pytest.raises(RuntimeError, match="redirect refused"),
    ):
        proof.forward_served_request(client, "GET", "/api/v1/automations/catalog", {}, b"")
    assert len(calls) == 1
