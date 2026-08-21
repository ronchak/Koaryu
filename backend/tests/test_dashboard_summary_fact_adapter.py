import asyncio
from datetime import date
from unittest.mock import patch

from fastapi import HTTPException, Response

from app.api.v1.endpoints.dashboard import get_dashboard_summary
from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_summary_cache import DashboardSummaryCacheKey
from app.services.dashboard_summary_service import (
    DASHBOARD_SUMMARY_FORMULA_VERSION,
    DashboardSummaryFactMismatch,
    DashboardSummaryService,
)
from tests.fakes.supabase import RpcBackedSupabase


def key(*, visibility="billing_visible", studio_id="studio-1"):
    return DashboardSummaryCacheKey(
        studio_id=studio_id,
        visibility=visibility,
        timezone="America/Los_Angeles",
        local_date=date(2026, 5, 20),
        formula_version=DASHBOARD_SUMMARY_FORMULA_VERSION,
    )


def facts_for(cache_key):
    visible = cache_key.visibility == "billing_visible"
    return {
        "formula_version": cache_key.formula_version,
        "studio": {
            "id": cache_key.studio_id,
            "name": "River City",
            "timezone": cache_key.timezone,
        },
        "today": cache_key.local_date.isoformat(),
        "timezone": cache_key.timezone,
        "students": {"total_students": 3, "active_students": 2, "trialing_students": 1, "on_hold_students": 0},
        "leads": {"active_leads": 1, "enrolled_leads": 0, "due_today_leads": 1},
        "schedule": {"today_sessions": 1},
        "belts": {"belt_count": 2, "tip_count": 1},
        "inactivity": {"watch_14": 0, "watch_30": 0, "watch_90": 0},
        "new_students": {"new_14": 1, "new_30": 2, "new_90": 3, "new_year_to_date": 3},
        "operational": {
            "attendance_with_capacity": 1,
            "total_capacity": 10,
            "sessions_tracked": 1,
            "sessions_with_capacity": 1,
            "utilization_rate": 0.1,
            "average_attendance": 1.0,
        },
        "churn": {"inactive_students": 0, "canceled_students": 0, "churn_marked_students": 0, "churn_rate": None},
        "test_readiness": {"ready_to_test": None, "needs_approval": None, "available": False},
        "billing": {
            "can_view_billing": visible,
            "payment_attention_count": 1 if visible else None,
            "has_plans": True if visible else None,
            "payments_ready": True if visible else None,
            **({"amounts": {"available": False}} if visible else {}),
        },
        "setup": {
            "has_programs": True,
            "has_students": True,
            "has_belt_system": True,
            "has_weekly_classes": True,
            "has_tuition_plans": True if visible else None,
        },
        "recent_students": [],
        "actions": [],
    }


def auth(user_id, role="admin", studio_id="studio-1"):
    return AuthResponse(
        user=UserProfile(id=user_id, email=f"{user_id}@example.com"),
        staff_profiles_available=True,
        membership_status="active",
        studio_id=studio_id,
        role=role,
    )


def test_accepted_rpc_maps_without_protected_table_fanout_and_uses_exact_params():
    rpc_client = RpcBackedSupabase()
    requested_key = key()
    rpc_client._rpc_dashboard_summary_facts = lambda params: facts_for(requested_key)

    facts = DashboardSummaryService(rpc_client).fetch_dashboard_facts_sync(requested_key)

    assert rpc_client.rpc_calls == [
        (
            "dashboard_summary_facts",
            {
                "p_studio_id": "studio-1",
                "p_visibility": "billing_visible",
                "p_timezone_name": "America/Los_Angeles",
                "p_local_date": "2026-05-20",
                "p_formula_version": "dashboard-summary-v1",
            },
        )
    ]
    assert rpc_client.query_log == []
    assert facts["students"]["total_students"] == 3
    assert "auth" not in facts
    assert "generated_at" not in facts


def test_hidden_billing_shape_is_validated_and_identity_fields_fail_closed():
    requested_key = key(visibility="billing_hidden")
    valid = facts_for(requested_key)
    assert DashboardSummaryService._validate_dashboard_facts(valid, requested_key)["billing"]["can_view_billing"] is False

    exposed = {**valid, "billing": {**valid["billing"], "payment_attention_count": 1}}
    try:
        DashboardSummaryService._validate_dashboard_facts(exposed, requested_key)
    except DashboardSummaryFactMismatch:
        pass
    else:
        raise AssertionError("hidden billing data was accepted")

    leaked = {**valid, "auth": {"user": {"id": "someone-else"}}}
    try:
        DashboardSummaryService._validate_dashboard_facts(leaked, requested_key)
    except DashboardSummaryFactMismatch:
        pass
    else:
        raise AssertionError("identity data was accepted into the fact cache")


def test_same_facts_assemble_fresh_auth_and_response_metadata_for_each_user():
    facts = facts_for(key())
    validated = DashboardSummaryService._validate_dashboard_facts(facts, key())

    first = DashboardSummaryService.assemble_fact_response(auth("user-1"), validated)
    second = DashboardSummaryService.assemble_fact_response(auth("user-2"), validated)

    assert first.auth.user.id == "user-1"
    assert second.auth.user.id == "user-2"
    assert first.generated_at
    assert second.generated_at
    assert first.studio.id == second.studio.id == "studio-1"


def test_cache_path_makes_one_rpc_for_concurrent_identical_misses_and_zero_on_hit():
    from app.services.dashboard_summary_cache import DashboardSummaryFactCache
    from app.services.dashboard_summary_service import DashboardSummaryRequestContext

    rpc_client = RpcBackedSupabase()
    requested_key = key()
    rpc_calls = 0

    def rpc_handler(_params):
        nonlocal rpc_calls
        rpc_calls += 1
        return facts_for(requested_key)

    rpc_client._rpc_dashboard_summary_facts = rpc_handler
    context = DashboardSummaryRequestContext(auth=auth("user-1"), key=requested_key)
    cache = DashboardSummaryFactCache()

    async def exercise():
        responses = await asyncio.gather(*[
            DashboardSummaryService.get_dashboard_summary_from_fact_context(
                rpc_client,
                context,
                cache=cache,
            )
            for _ in range(5)
        ])
        await DashboardSummaryService.get_dashboard_summary_from_fact_context(
            rpc_client,
            context,
            cache=cache,
        )
        return responses

    responses = asyncio.run(exercise())
    assert rpc_calls == 1
    assert len(responses) == 5
    assert all(response[0].students.total_students == 3 for response in responses)


def test_summary_endpoint_keeps_auth_outside_cache_and_uses_one_rpc_then_zero_on_hit():
    rpc_client = RpcBackedSupabase({
        "studios": [{"id": "endpoint-studio", "name": "River City", "timezone": "UTC"}],
    })
    requested_key = DashboardSummaryCacheKey(
        studio_id="endpoint-studio",
        visibility="billing_visible",
        timezone="UTC",
        local_date=date(2026, 5, 20),
        formula_version=DASHBOARD_SUMMARY_FORMULA_VERSION,
    )
    rpc_client._rpc_dashboard_summary_facts = lambda _params: facts_for(requested_key)
    first_auth = auth("endpoint-user-1", studio_id="endpoint-studio")
    second_auth = auth("endpoint-user-2", studio_id="endpoint-studio")
    responses = []

    with patch(
        "app.services.dashboard_summary_service.AuthService._get_user_profile_sync",
        side_effect=[first_auth, second_auth],
    ), patch(
        "app.services.dashboard_summary_service.ensure_platform_subscription_access"
    ), patch.object(
        DashboardSummaryService,
        "_studio_today",
        return_value=(date(2026, 5, 20), "UTC"),
    ):
        for user_id in ("endpoint-user-1", "endpoint-user-2"):
            response = Response()
            responses.append(asyncio.run(get_dashboard_summary(response, user_id, None, rpc_client)))
            assert response.headers["Cache-Control"] == "no-store, private"
            assert response.headers["Vary"] == "Authorization, X-Studio-Id, Cookie"
            assert "koaryu_summary_context" in response.headers["Server-Timing"]

    assert rpc_client.rpc_calls == [("dashboard_summary_facts", {
        "p_studio_id": "endpoint-studio",
        "p_visibility": "billing_visible",
        "p_timezone_name": "UTC",
        "p_local_date": "2026-05-20",
        "p_formula_version": "dashboard-summary-v1",
    })]
    assert [response.auth.user.id for response in responses] == [
        "endpoint-user-1",
        "endpoint-user-2",
    ]
    assert all(response.generated_at for response in responses)
    assert [query["table"] for query in rpc_client.query_log] == ["studios", "studios"]


def test_no_studio_and_subscription_denial_never_reach_dashboard_rpc():
    no_studio_auth = AuthResponse(
        user=UserProfile(id="onboarding-user", email="onboarding@example.com"),
        staff_profiles_available=False,
        membership_status="none",
    )
    no_studio_client = RpcBackedSupabase()
    no_studio_client._rpc_dashboard_summary_facts = lambda _params: (_ for _ in ()).throw(
        AssertionError("no-studio request reached dashboard RPC")
    )

    with patch(
        "app.services.dashboard_summary_service.AuthService._get_user_profile_sync",
        return_value=no_studio_auth,
    ), patch(
        "app.services.dashboard_summary_service.ensure_platform_subscription_access"
    ) as ensure_access:
        response = Response()
        payload = asyncio.run(get_dashboard_summary(response, "onboarding-user", None, no_studio_client))

    ensure_access.assert_not_called()
    assert payload.studio is None
    assert no_studio_client.rpc_calls == []

    denied_client = RpcBackedSupabase()
    with patch(
        "app.services.dashboard_summary_service.AuthService._get_user_profile_sync",
        return_value=auth("denied-user", studio_id="denied-studio"),
    ), patch(
        "app.services.dashboard_summary_service.ensure_platform_subscription_access",
        side_effect=HTTPException(status_code=402, detail="subscription required"),
    ):
        try:
            asyncio.run(get_dashboard_summary(Response(), "denied-user", None, denied_client))
        except HTTPException as exc:
            assert exc.status_code == 402
        else:
            raise AssertionError("subscription denial was not preserved")
    assert denied_client.rpc_calls == []
