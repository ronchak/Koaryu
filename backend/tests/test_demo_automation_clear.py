import asyncio
import traceback
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError
from pydantic import ValidationError

from app.api.v1.endpoints import demo
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.demo import AutomationClearEffects, DemoResetResponse, StudioDataClearResponse
from app.services.demo_data_access import DemoDataAccess
from app.services.demo_reset_response_builder import DemoResetResponseBuilder
from app.services.demo_service import DemoService
from tests.fakes.supabase import RpcBackedSupabase
from tests.test_settings_mutation_authorization import _active_subscription

EFFECTS = {
    "workflows_paused": 1,
    "workflow_runs_cancelled": 2,
    "workflow_cancellation_intents_added": 3,
    "attendance_deliveries_cancelled": 4,
    "belt_test_events_deleted": 5,
    "belt_test_recipients_deleted": 6,
    "sending_attempts_preserved": 7,
    "unknown_attempts_preserved": 8,
    "attendance_rule_paused": True,
}
DETAIL = "Studio data clear result could not be confirmed."


@pytest.mark.parametrize("field", EFFECTS)
def test_effects_require_each_field_without_null_or_coercion(field):
    missing = dict(EFFECTS)
    del missing[field]
    invalid = (
        [None, "1", 1, [], {}]
        if field == "attendance_rule_paused"
        else [None, True, False, "1", -1, 1.5]
    )
    for payload in [missing, *[dict(EFFECTS, **{field: value}) for value in invalid]]:
        with pytest.raises(ValidationError):
            AutomationClearEffects.model_validate(payload)


def test_effects_are_closed_and_responses_require_them_preserving_defaults():
    with pytest.raises(ValidationError):
        AutomationClearEffects.model_validate(dict(EFFECTS, extra=0))
    zero = {key: False if key == "attendance_rule_paused" else 0 for key in EFFECTS}
    for payload in (zero, EFFECTS):
        effects = AutomationClearEffects.model_validate(payload)
        assert effects.model_dump() == payload
        for response_type in (DemoResetResponse, StudioDataClearResponse):
            response = response_type(studio_name="Studio", automation=effects)
            assert response.automation is effects
            assert set(response.counts.model_dump().values()) == {0}
    for response_type in (DemoResetResponse, StudioDataClearResponse):
        with pytest.raises(ValidationError):
            response_type(studio_name="Studio")


class ClearReplySupabase(RpcBackedSupabase):
    """Script one SDK result; this does not emulate database clear semantics."""

    def __init__(self, reply=None, error=None):
        super().__init__({})
        self.reply = reply
        self.error = error
        self.executions = 0

    def _rpc_clear_studio_operational_data_v2(self, params):
        self.executions += 1
        if self.error is not None:
            raise self.error
        return self.reply


@pytest.mark.parametrize("include_platform_rows", [False, True])
def test_v2_has_exact_arguments_and_typed_effects(include_platform_rows):
    client = ClearReplySupabase({"payload": EFFECTS})
    effects = DemoDataAccess(client).clear_studio_surface(
        "studio", include_platform_rows=include_platform_rows
    )
    assert effects.model_dump() == EFFECTS
    assert client.rpc_calls == [
        (
            "clear_studio_operational_data_v2",
            {"p_studio_id": "studio", "p_include_platform_rows": include_platform_rows},
        )
    ]
    assert client.executions == 1
    assert client.query_log == []


@pytest.mark.parametrize(
    "reply",
    [
        None,
        [],
        [{"payload": EFFECTS}],
        EFFECTS,
        "private-provider-text",
        0,
        {},
        {"payload": None},
        {"payload": []},
        {"payload": EFFECTS, "extra": 0},
        {"payload": dict(EFFECTS, workflows_paused=False)},
    ],
)
def test_uncertain_envelopes_are_fixed_503_without_fallback(reply):
    client = ClearReplySupabase(reply)
    with pytest.raises(HTTPException) as caught:
        DemoDataAccess(client).clear_demo_surface("studio")
    assert caught.value.status_code == 503
    assert caught.value.detail == DETAIL
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__
    assert client.executions == 1
    assert len(client.rpc_calls) == 1
    assert client.query_log == []


@pytest.mark.parametrize(
    "error",
    [
        APIError(
            {
                "code": "PGRST202",
                "message": "private missing RPC",
                "details": "private",
                "hint": "private",
            }
        ),
        APIError({"code": "22023", "message": "private argument error"}),
        APIError({"code": ["private"], "message": {"private": "message"}}),
        APIError({"code": {"private": "code"}, "message": ["private"]}),
        TimeoutError("private committed response lost"),
        RuntimeError("private provider failure"),
    ],
)
def test_provider_errors_and_lost_replies_do_not_retry_reset_or_expose_causes(error):
    client = ClearReplySupabase(error=error)
    service = DemoService(client)
    service._update_studio_for_demo = Mock()
    service._seed_demo_surface = Mock()
    with pytest.raises(HTTPException) as caught:
        asyncio.run(service.reset_demo_studio("studio", "actor"))
    assert caught.value.status_code == 503
    assert caught.value.detail == DETAIL
    assert "private" not in "".join(traceback.format_exception(caught.value))
    assert caught.value.__cause__ is None
    assert client.executions == 1
    assert len(client.rpc_calls) == 1
    service._update_studio_for_demo.assert_not_called()
    service._seed_demo_surface.assert_not_called()
    audit = client.tables["audit_logs"][0]["metadata"]
    assert audit["phase"] == "clear_existing_data"
    assert audit["error_type"] == "HTTPException"
    assert audit["cleanup_succeeded"] is False
    assert "private" not in str(audit)


def test_reset_keeps_first_effects_through_update_seed_audit_and_builder():
    service = DemoService(ClearReplySupabase({"payload": EFFECTS}))
    events = []
    service._update_studio_for_demo = lambda studio: events.append("update")
    service._seed_demo_surface = lambda studio, actor: events.append("seed")
    service._write_audit_log = lambda studio, actor: events.append("audit")
    built = DemoResetResponse(studio_name="Seeded", automation=EFFECTS)
    with patch("app.services.demo_service.DemoResetResponseBuilder") as builder:
        builder.return_value.build = AsyncMock(return_value=built)
        response = asyncio.run(service.reset_demo_studio("studio", "actor"))
        studio, effects = builder.return_value.build.call_args.args
    assert studio == "studio"
    assert effects.model_dump() == EFFECTS
    assert response is built
    assert events == ["update", "seed", "audit"]
    assert service.supabase.executions == 1


def test_seed_cleanup_effects_are_discarded_and_never_build_success():
    service = DemoService(object())
    first = AutomationClearEffects(**EFFECTS)
    cleanup = AutomationClearEffects(**dict(EFFECTS, workflows_paused=0))
    service._clear_demo_surface = Mock(side_effect=[first, cleanup])
    service._update_studio_for_demo = Mock()
    service._seed_programs = Mock(side_effect=RuntimeError("seed failed"))
    service._write_reset_failure_audit = Mock()
    service._build_reset_response = AsyncMock()
    with pytest.raises(RuntimeError, match="seed failed"):
        asyncio.run(service.reset_demo_studio("studio", "actor"))
    assert service._clear_demo_surface.call_count == 2
    service._build_reset_response.assert_not_called()
    assert service._write_reset_failure_audit.call_args.kwargs["cleanup_succeeded"] is True


def test_builder_keeps_seeded_counts_and_original_clear_effects():
    from app.schemas.lead import LeadResponse

    lead = LeadResponse(
        id="lead",
        studio_id="studio",
        first_name="New",
        last_name="Lead",
        stage="inquiry",
        is_minor=False,
        source="website",
        created_at="2026-10-01T00:00:00Z",
        updated_at="2026-10-01T00:00:00Z",
    )
    effects = AutomationClearEffects(**EFFECTS)
    with (
        patch("app.services.demo_reset_response_builder.StudentService") as students,
        patch("app.services.demo_reset_response_builder.ProgramService") as programs,
        patch("app.services.demo_reset_response_builder.LeadService") as leads,
        patch("app.services.demo_reset_response_builder.BeltService") as belts,
        patch("app.services.demo_reset_response_builder.ScheduleService") as schedule,
    ):
        students.return_value.list_students = AsyncMock(return_value=SimpleNamespace(items=[]))
        programs.return_value.list_programs = AsyncMock(return_value=[])
        leads.return_value.list_leads = AsyncMock(return_value=[lead])
        belts.return_value.list_ladders = AsyncMock(return_value=[])
        schedule.return_value.list_templates = AsyncMock(return_value=[])
        schedule.return_value.list_sessions = AsyncMock(return_value=[])
        result = asyncio.run(
            DemoResetResponseBuilder(object(), lambda days: "2026-10-01").build("studio", effects)
        )
    assert result.automation is effects
    assert result.counts.model_dump() == {
        "students": 0,
        "leads": 1,
        "belt_ranks": 0,
        "class_sessions": 0,
        "attendance_records": 0,
    }


@pytest.mark.parametrize(
    "method,path,action",
    [("DELETE", "/demo/data", "clear-studio-data"), ("POST", "/demo/reset", "demo-reset")],
)
@pytest.mark.parametrize(
    "denial,status",
    [
        ("disabled", 403),
        ("header", 400),
        ("selector", 400),
        ("role", 403),
        ("allowlist", 403),
        ("subscription", 402),
    ],
)
def test_http_authorization_denials_never_clear(method, path, action, denial, status):
    client = ClearReplySupabase({"payload": EFFECTS})
    client.tables = {
        "staff_roles": [
            {
                "id": "role",
                "studio_id": "settings-studio",
                "user_id": "actor",
                "role": "instructor" if denial == "role" else "admin",
            }
        ],
        "studio_subscriptions": [
            dict(
                _active_subscription(), status="canceled" if denial == "subscription" else "active"
            )
        ],
    }
    app = FastAPI()
    app.include_router(demo.router)
    app.dependency_overrides[get_current_user_id] = lambda: "actor"
    app.dependency_overrides[get_requested_studio_id] = lambda: (
        None if denial == "selector" else "settings-studio"
    )
    app.dependency_overrides[get_supabase] = lambda: client
    settings = SimpleNamespace(
        DEMO_RESET_ENABLED=denial != "disabled",
        DEMO_RESET_STUDIO_IDS="other" if denial == "allowlist" else "settings-studio",
    )
    with patch("app.api.v1.endpoints.demo.get_settings", return_value=settings):
        response = TestClient(app).request(
            method,
            path,
            headers={"X-Koaryu-Destructive-Action": "wrong" if denial == "header" else action},
        )
    assert response.status_code == status, response.text
    assert client.rpc_calls == []
    assert not any(
        query["delete"] or query["insert"] or query["update"] for query in client.query_log
    )


@pytest.mark.parametrize(
    "reply", [{"payload": EFFECTS}, {"payload": dict(EFFECTS, workflows_paused=None)}]
)
def test_authorized_http_clear_serializes_effects_or_safe_uncertainty(reply):
    client = ClearReplySupabase(reply)
    client.tables = {
        "staff_roles": [
            {"id": "role", "studio_id": "settings-studio", "user_id": "actor", "role": "admin"}
        ],
        "studio_subscriptions": [_active_subscription()],
        "studios": [{"id": "settings-studio", "name": "Original"}],
        "students": [{"id": "student", "studio_id": "settings-studio"}],
    }
    app = FastAPI()
    app.include_router(demo.router)
    app.dependency_overrides[get_current_user_id] = lambda: "actor"
    app.dependency_overrides[get_requested_studio_id] = lambda: "settings-studio"
    app.dependency_overrides[get_supabase] = lambda: client
    with patch(
        "app.api.v1.endpoints.demo.get_settings",
        return_value=SimpleNamespace(
            DEMO_RESET_ENABLED=True, DEMO_RESET_STUDIO_IDS="settings-studio"
        ),
    ):
        response = TestClient(app).delete(
            "/demo/data", headers={"X-Koaryu-Destructive-Action": "clear-studio-data"}
        )
    if reply["payload"]["workflows_paused"] is None:
        assert response.status_code == 503
        assert response.json() == {"detail": DETAIL}
    else:
        assert response.status_code == 200
        assert response.json()["automation"] == EFFECTS
        assert response.json()["counts"]["students"] == 1
        assert response.json()["studio_name"] == "Original"
    assert client.executions == 1


def test_response_builder_failure_after_clear_never_replays_clear():
    client = ClearReplySupabase({"payload": EFFECTS})
    service = DemoService(client)
    service._update_studio_for_demo = Mock()
    service._seed_demo_surface = Mock()
    service._write_audit_log = Mock()
    service._build_reset_response = AsyncMock(side_effect=RuntimeError("read failure"))
    with pytest.raises(RuntimeError, match="read failure"):
        asyncio.run(service.reset_demo_studio("studio", "actor"))
    assert client.executions == 1


@pytest.mark.parametrize(
    "outcome", ["success", "missing", "malformed_error", "lost_reply", "bad_envelope"]
)
def test_installed_postgrest_transport_boundary(outcome):
    import json

    import httpx
    from postgrest import SyncPostgrestClient
    from postgrest.utils import SyncClient

    requests = []

    def transport(request):
        requests.append(request)
        if outcome == "lost_reply":
            raise httpx.ReadError("private committed reply lost", request=request)
        if outcome == "missing":
            return httpx.Response(404, json={"code": "PGRST202", "message": "private missing RPC"})
        if outcome == "malformed_error":
            return httpx.Response(
                400, json={"code": ["private"], "message": {"private": "message"}}
            )
        payload = {"payload": EFFECTS}
        return httpx.Response(200, json=[payload] if outcome == "bad_envelope" else payload)

    class OfflinePostgrest(SyncPostgrestClient):
        def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
            return SyncClient(
                base_url=base_url,
                headers=headers,
                timeout=timeout,
                transport=httpx.MockTransport(transport),
                trust_env=False,
            )

    with OfflinePostgrest("https://synthetic.invalid/rest/v1") as client:
        data_access = DemoDataAccess(client)
        if outcome == "success":
            assert data_access.clear_demo_surface("studio").model_dump() == EFFECTS
        else:
            with pytest.raises(HTTPException) as caught:
                data_access.clear_demo_surface("studio")
            assert caught.value.status_code == 503
            assert caught.value.detail == DETAIL
            assert "private" not in "".join(traceback.format_exception(caught.value))
    assert len(requests) == 1
    assert requests[0].method == "POST"
    assert requests[0].url.path == "/rest/v1/rpc/clear_studio_operational_data_v2"
    assert json.loads(requests[0].content) == {
        "p_studio_id": "studio",
        "p_include_platform_rows": False,
    }
