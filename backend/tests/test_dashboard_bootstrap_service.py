import asyncio
import threading
import unittest
from collections import Counter
from contextlib import ExitStack, contextmanager
from datetime import date
from importlib.metadata import version
from types import SimpleNamespace
from typing import get_args
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import HTTPException
from postgrest import SyncPostgrestClient
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient

from app.schemas.program import ProgramResponse
from app.schemas.student import StudentResponse

from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from tests.fakes.supabase import TableBackedSupabase


METHOD_LABELS = {
    "_fetch_studio_summary": "studio",
    "_fetch_students": "students",
    "_fetch_leads": "leads",
    "_fetch_belt_ladders": "belts",
    "_fetch_programs": "programs",
}


@contextmanager
def patch_fetches(fetch):
    with ExitStack() as stack:
        for method in METHOD_LABELS:
            stack.enter_context(
                patch.object(
                    DashboardBootstrapService,
                    method,
                    new=lambda service, studio_id, method=method: fetch(service, method, studio_id),
                )
            )
        yield


class DashboardBootstrapServiceTest(unittest.TestCase):
    def test_bootstrap_reuses_studio_timezone_for_current_student_projection(self):
        supabase = TableBackedSupabase({"student_program_memberships": []})
        supabase.options = SimpleNamespace(postgrest_client_timeout=10.0)
        service = DashboardBootstrapService(supabase)
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
            staff_profiles_available=True,
            studio_id="studio-1",
            role="admin",
        )
        student = {
            "id": "student-1",
            "studio_id": "studio-1",
            "legal_first_name": "Birthday",
            "legal_last_name": "Student",
            "date_of_birth": "2008-09-20",
            "is_minor": True,
            "status": "active",
            "tags": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }

        def fetch(service, method_name, studio_id):
            label = METHOD_LABELS[method_name]
            if label == "studio":
                result = SimpleNamespace(
                    data={
                        "id": "studio-1",
                        "name": "West Coast",
                        "slug": "west-coast",
                        "timezone": "America/Los_Angeles",
                    }
                )
            elif label == "students":
                result = SimpleNamespace(data=[student], count=1)
            elif label == "programs":
                result = []
            else:
                result = SimpleNamespace(data=[])
            return result

        with (
            patch(
                "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
                return_value=auth,
            ),
            patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
            patch_fetches(fetch),
            patch(
                "app.services.dashboard_bootstrap_service.studio_today",
                return_value=(date(2026, 9, 20), "America/Los_Angeles"),
            ),
        ):
            payload, timings = asyncio.run(
                service.get_dashboard_bootstrap("user-1", view="students")
            )

        self.assertFalse(payload.students[0].is_minor)
        self.assertFalse(any(entry["table"] == "studios" for entry in supabase.log))
        self.assertGreaterEqual(timings["students"], 0.0)

    def test_server_timing_value_uses_safe_labels_and_durations(self):
        value = DashboardBootstrapService.server_timing_value(
            {
                "studio": 12.345,
                "students": 4.0,
                "total": 20.123,
            }
        )

        self.assertEqual(
            value,
            "koaryu_studio;dur=12.3, koaryu_students;dur=4.0, koaryu_total;dur=20.1",
        )

    def test_bootstrap_has_no_summary_field_or_stage(self):
        supabase = SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10.0))
        service = DashboardBootstrapService(supabase=supabase)
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
            staff_profiles_available=True,
            studio_id="studio-1",
            role="admin",
        )

        def fake_fetch(service, method_name, studio_id):
            label = METHOD_LABELS[method_name]
            self.assertEqual(studio_id, "studio-1")
            if label == "studio":
                return SimpleNamespace(
                    data={
                        "id": "studio-1",
                        "name": "River City",
                        "slug": "river-city",
                        "timezone": "UTC",
                        "logo_url": None,
                    }
                )
            if label == "students":
                return SimpleNamespace(data=[], count=250)
            if label in {"leads", "belts"}:
                return SimpleNamespace(data=[])
            if label == "programs":
                return []
            raise AssertionError(f"Unexpected bootstrap fetch label: {label}")

        with (
            patch(
                "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
                return_value=auth,
            ),
            patch(
                "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"
            ) as ensure_access,
            patch_fetches(fake_fetch),
        ):
            payload, timings = asyncio.run(
                service.get_dashboard_bootstrap("user-1", view="students")
            )

        ensure_access.assert_called_once_with(supabase, "studio-1")
        self.assertNotIn("summary", DashboardBootstrapResponse.model_fields)
        self.assertEqual(payload.students_total, 250)
        self.assertTrue(payload.students_may_be_partial)
        self.assertNotIn("summary", timings)
        self.assertIn("total", timings)


if __name__ == "__main__":
    unittest.main()


# Projection failures must be opt-in so deployed older frontends never mistake
# missing data for a successful empty collection during a rolling release.
def partial_bootstrap_case(
    *,
    view,
    failed=None,
    failure=None,
    enrichment_failure=False,
    allow_partial=True,
    student_dob=None,
    fetch_labels=None,
):
    supabase = SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10.0))
    service = DashboardBootstrapService(supabase)
    profile = AuthResponse(
        user=UserProfile(
            id="partial-user",
            email="partial@example.test",
            legal_first_name="Partial",
            legal_last_name="User",
        ),
        staff_profiles_available=True,
        membership_status="active",
        studio_id="partial-studio",
        role="admin",
    )
    student = StudentResponse(
        id="student-1",
        studio_id="partial-studio",
        legal_first_name="Healthy",
        legal_last_name="Student",
        date_of_birth=student_dob,
        status="active",
        created_at="2026-09-05",
        updated_at="2026-09-05",
    )
    program = ProgramResponse(
        id="program-1",
        studio_id="partial-studio",
        name="Healthy program",
        created_at="2026-09-05",
        updated_at="2026-09-05",
    )

    def fetch(service, method_name, studio_id):
        label = METHOD_LABELS[method_name]
        if fetch_labels is not None:
            fetch_labels.append(label)
        assert studio_id == "partial-studio"
        if label == failed:
            raise failure if failure is not None else TimeoutError("private provider detail")
        if label == "studio":
            data = SimpleNamespace(
                data={
                    "id": studio_id,
                    "name": "Healthy studio",
                    "slug": "healthy",
                    "timezone": "UTC",
                }
            )
        elif label == "students":
            data = SimpleNamespace(data=[student.model_dump()], count=1)
        elif label == "programs":
            data = [program]
        else:
            data = SimpleNamespace(data=[])
        return data

    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=profile,
        ),
        patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
        patch_fetches(fetch),
        patch(
            "app.services.dashboard_bootstrap_service.StudentService.rows_to_responses",
            side_effect=(
                enrichment_failure
                if isinstance(enrichment_failure, Exception)
                else (
                    TimeoutError("private membership enrichment detail")
                    if enrichment_failure
                    else None
                )
            ),
            return_value=[student],
        ),
    ):
        return asyncio.run(
            service.get_dashboard_bootstrap("partial-user", allow_partial=allow_partial, view=view)
        )


# No view loads all five datasets; each label fails inside a view that loads it.
FAILED_LABEL_VIEWS = {
    "studio": "students",
    "students": "students",
    "programs": "students",
    "leads": "leads",
    "belts": "training",
}


@pytest.mark.parametrize("failed", ["studio", "students", "leads", "belts", "programs"])
def test_opted_bootstrap_retains_healthy_projections_and_marks_failed_data_unavailable(failed):
    view = FAILED_LABEL_VIEWS[failed]
    payload, timings = partial_bootstrap_case(failed=failed, view=view)
    assert payload.auth.membership_status == "active"
    assert payload.auth.user.legal_first_name == "Partial"
    assert payload.dataset_errors.model_dump(exclude_none=True).keys() == {failed}
    assert "private" not in payload.model_dump_json()
    assert failed in timings
    if failed == "students":
        assert payload.students == []
        assert payload.students_total is None
        assert payload.students_may_be_partial
    elif view == "students":
        assert payload.students[0].id == "student-1"
        assert payload.students_total == 1
    if failed != "programs":
        assert payload.programs[0].id == "program-1"
    if failed == "studio":
        assert payload.studio is None and payload.studio_name is None
        dated_payload, _ = partial_bootstrap_case(
            failed="studio", student_dob="2008-09-20", view="students"
        )
        assert dated_payload.dataset_errors.model_dump(exclude_none=True).keys() == {
            "studio",
            "students",
        }
        assert dated_payload.students == []
        assert dated_payload.students_total is None


def test_student_enrichment_failure_does_not_discard_healthy_programs_or_fabricate_roster_count():
    payload, _ = partial_bootstrap_case(enrichment_failure=True, view="students")
    assert payload.dataset_errors.model_dump(exclude_none=True).keys() == {"students"}
    assert payload.students_total is None
    assert payload.students == []
    assert payload.programs[0].id == "program-1"
    assert payload.studio.id == "partial-studio"


@pytest.mark.parametrize("allow_partial", [False, True])
@pytest.mark.parametrize("status_code", [401, 402, 403])
def test_projection_access_failures_remain_fatal(allow_partial, status_code):
    with pytest.raises(HTTPException) as result:
        partial_bootstrap_case(
            failed="leads",
            failure=HTTPException(status_code=status_code),
            allow_partial=allow_partial,
            view="leads",
        )
    assert result.value.status_code == status_code
    with pytest.raises(HTTPException) as mapped_result:
        partial_bootstrap_case(
            enrichment_failure=HTTPException(status_code=status_code),
            allow_partial=allow_partial,
            view="students",
        )
    assert mapped_result.value.status_code == status_code


def test_legacy_bootstrap_still_rejects_partial_data():
    with pytest.raises(TimeoutError):
        partial_bootstrap_case(failed="leads", allow_partial=False, view="leads")


@pytest.mark.parametrize("allow_partial", [False, True])
@pytest.mark.parametrize("code", ["42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"])
def test_projection_provider_access_failures_remain_fatal(allow_partial, code):
    from postgrest.exceptions import APIError

    failure = APIError(
        {"code": code, "message": "private access failure", "details": "", "hint": ""}
    )
    with pytest.raises(APIError) as error:
        partial_bootstrap_case(
            failed="leads", failure=failure, allow_partial=allow_partial, view="leads"
        )
    assert error.value is failure


@pytest.mark.parametrize("allow_partial", [False, True])
def test_missing_studio_remains_fatal(allow_partial):
    labels = []
    with (
        patch("app.services.dashboard_bootstrap_service.logger.warning") as warning,
        patch("app.services.dashboard_bootstrap_service.DashboardBootstrapResponse") as response,
        pytest.raises(HTTPException) as error,
    ):
        partial_bootstrap_case(
            failed="studio",
            failure=HTTPException(404),
            allow_partial=allow_partial,
            view="students",
            fetch_labels=labels,
        )
    assert error.value.status_code == 404
    assert "students" not in labels
    warning.assert_not_called()
    response.assert_not_called()  # No partial response or dataset_errors is recorded.


def test_partial_projection_opt_in_is_off_by_default_in_endpoint_and_service():
    import inspect
    from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap

    endpoint = inspect.signature(get_dashboard_bootstrap).parameters
    service = inspect.signature(DashboardBootstrapService.get_dashboard_bootstrap).parameters
    assert endpoint["allow_partial"].default is False
    assert service["allow_partial"].default is False
    assert endpoint["view"].default == service["view"].default == "home"
    assert "dashboard" not in get_args(endpoint["view"].annotation)
    assert list(service) == [
        "self",
        "user_id",
        "requested_studio_id",
        "allow_partial",
        "view",
    ]


@pytest.mark.parametrize("allow_partial", [False, True])
def test_bootstrap_endpoint_forwards_partial_opt_in_without_changing_private_headers(
    allow_partial,
):
    from fastapi import Response
    from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap

    payload, timings = partial_bootstrap_case(view="home")
    client = object()
    provider = object()
    response = Response()

    async def run_operation(actual_provider, operation, *, lane):
        assert actual_provider is provider and lane == "interactive"
        return operation(client)

    with (
        patch("app.api.v1.endpoints.dashboard.run_supabase_operation", side_effect=run_operation),
        patch.object(
            DashboardBootstrapService,
            "get_dashboard_bootstrap_from_context",
            new=AsyncMock(return_value=(payload, timings)),
        ) as bootstrap,
        patch.object(DashboardBootstrapService, "resolve_context_sync") as resolve,
    ):
        result = asyncio.run(
            get_dashboard_bootstrap(
                response,
                allow_partial=allow_partial,
                user_id="partial-user",
                requested_studio_id="partial-studio",
                supabase=provider,
            )
        )
    resolve.assert_called_once_with("partial-user", "partial-studio", view="home")
    bootstrap.assert_awaited_once()
    assert bootstrap.call_args.args == (provider, resolve.return_value)
    assert bootstrap.call_args.kwargs["allow_partial"] is allow_partial
    assert bootstrap.call_args.kwargs["total_started"] > 0
    assert result is payload
    assert "private" in response.headers["cache-control"]
    assert "server-timing" in response.headers


def test_workspace_does_not_load_feature_projections_and_keeps_subscription_enforcement():
    from unittest.mock import Mock

    profile = AuthResponse(
        user=UserProfile(id="fixture-user", email="fixture@example.test"),
        staff_profiles_available=True,
        membership_status="active",
        studio_id="fixture-studio",
        role="admin",
    )
    client = Mock()
    service = DashboardBootstrapService(client)
    studio = {
        "id": "fixture-studio",
        "name": "Fixture",
        "slug": "fixture",
        "timezone": "America/Los_Angeles",
    }
    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=profile,
        ),
        patch(
            "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"
        ) as access,
        patch.object(service, "_fetch_studio_summary", return_value=SimpleNamespace(data=studio)),
        patch.object(service, "_fetch_students") as students,
        patch.object(service, "_fetch_leads") as leads,
        patch.object(service, "_fetch_belt_ladders") as belts,
    ):
        result = service.get_workspace_sync("fixture-user", "fixture-studio")
        assert result.auth == profile
        assert result.studio.timezone == "America/Los_Angeles"
        access.assert_called_once_with(client, "fixture-studio")
        students.assert_not_called()
        leads.assert_not_called()
        belts.assert_not_called()
        access.side_effect = HTTPException(status_code=402, detail="Subscription required")
        with pytest.raises(HTTPException) as error:
            service.get_workspace_sync("fixture-user", "fixture-studio")
        assert error.value.status_code == 402


@pytest.mark.parametrize(
    "view,expected",
    [
        ("home", ["programs", "studio"]),
        ("students", ["programs", "students", "studio"]),
        ("billing", ["studio"]),
        ("schedule", ["programs", "studio"]),
        ("settings", ["programs", "studio"]),
        ("leads", ["leads", "programs", "studio"]),
        ("reports", ["leads", "programs", "studio"]),
        ("training", ["belts", "programs", "studio"]),
    ],
)
def test_bootstrap_omits_unrelated_route_queries(view, expected):
    profile = AuthResponse(
        user=UserProfile(id="fixture-user", email="fixture@example.test"),
        staff_profiles_available=True,
        membership_status="active",
        studio_id="fixture-studio",
        role="admin",
    )
    service = DashboardBootstrapService(
        SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10))
    )
    labels = []

    def fetch(service, method_name, studio_id):
        label = METHOD_LABELS[method_name]
        labels.append(label)
        if label == "studio":
            value = SimpleNamespace(
                data={
                    "id": "fixture-studio",
                    "name": "Fixture",
                    "slug": "fixture",
                    "timezone": "UTC",
                }
            )
        elif label in {"students", "leads", "belts"} and label in expected:
            value = SimpleNamespace(data=[], count=0)
        elif label == "programs":
            value = []
        else:
            raise AssertionError(f"Unrelated projection: {label}")
        return value

    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=profile,
        ),
        patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
        patch_fetches(fetch),
        patch(
            "app.services.dashboard_bootstrap_service.StudentService.rows_to_responses"
        ) as enrich_students,
    ):
        result, timings = asyncio.run(service.get_dashboard_bootstrap("fixture-user", view=view))
    assert sorted(labels) == expected
    assert set(timings) == {*expected, "total"}
    assert result.students == []
    if view == "home":
        enrich_students.assert_not_called()
        assert result.leads == []
        assert result.belt_ladders == []
        assert result.primary_belt_ladder is None


class SyntheticPostgrestClient(SyncPostgrestClient):
    """Keep the pinned SDK's real builders, replacing only HTTP transport."""

    def __init__(self, handler):
        self.handler = handler
        super().__init__("https://synthetic.invalid/rest/v1")

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )


def training_ladder(ladder_id, created_at, rank_orders):
    return {
        "id": ladder_id,
        "studio_id": "studio-1",
        "name": ladder_id,
        "program_id": "program-1",
        "sub_rank_term": None,
        "created_at": created_at,
        "updated_at": created_at,
        "belt_ranks": [
            {
                "id": f"{ladder_id}-{order}",
                "ladder_id": ladder_id,
                "studio_id": "studio-1",
                "name": f"Rank {order}",
                "color_hex": "#FFFFFF",
                "display_order": order,
                "min_classes": 0,
                "min_months": 0,
                "requires_approval": False,
                "created_at": created_at,
            }
            for order in rank_orders
        ],
    }


class TrainingProvider:
    """Answer training bootstrap reads in server order and record each request."""

    def __init__(self, *, programs=None, ladders=None, failures=None):
        self.programs = (
            programs
            if programs is not None
            else [
                {
                    "id": "program-1",
                    "studio_id": "studio-1",
                    "name": "Kids",
                    "is_system": None,
                    "archived_at": None,
                    "created_at": "2026-01-01T00:00:00Z",
                }
            ]
        )
        self.ladders = (
            ladders
            if ladders is not None
            else [
                training_ladder("ladder-early", "2026-01-01T00:00:00Z", [2, 0, 1]),
                training_ladder("ladder-late", "2026-02-01T00:00:00Z", [0]),
            ]
        )
        self.failures = failures or {}
        self.requests = []

    def __call__(self, request):
        table = request.url.path.rsplit("/", 1)[-1]
        self.requests.append((request.method, table, request.url.params, threading.get_ident()))
        if table in self.failures:
            status_code, code = self.failures[table]
            return httpx.Response(
                status_code,
                json={
                    "code": code,
                    "message": "private provider detail",
                    "details": "",
                    "hint": "",
                },
            )
        if table == "studios":
            return httpx.Response(
                200,
                json={"id": "studio-1", "name": "Fixture", "slug": "fixture", "timezone": "UTC"},
            )
        return httpx.Response(200, json=self.programs if table == "programs" else self.ladders)


def training_profile():
    return AuthResponse(
        user=UserProfile(id="user-1", email="fixture@example.test"),
        staff_profiles_available=True,
        membership_status="active",
        studio_id="studio-1",
        role="admin",
    )


def training_bootstrap(provider, *, allow_partial=True):
    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=training_profile(),
        ),
        patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
        SyntheticPostgrestClient(provider) as client,
    ):
        payload, _timings = asyncio.run(
            DashboardBootstrapService(client).get_dashboard_bootstrap(
                "user-1", "studio-1", allow_partial=allow_partial, view="training"
            )
        )
    return payload


TRAINING_BELT_QUERY = [
    ("select", "*, belt_ranks(*), programs!inner()"),
    ("studio_id", "eq.studio-1"),
    ("programs.studio_id", "eq.studio-1"),
    ("programs.archived_at", "is.null"),
    ("programs.is_system", "not.is.true"),
    ("order", "created_at,id"),
]


def test_training_belts_use_one_scoped_join_beside_independent_programs_read():
    assert version("postgrest") == "0.17.2"
    provider = TrainingProvider()
    payload = training_bootstrap(provider)

    # Belts no longer preread programs: two program/belt reads instead of three.
    assert Counter((method, table) for method, table, *_ in provider.requests) == {
        ("GET", "studios"): 1,
        ("GET", "programs"): 1,
        ("GET", "belt_ladders"): 1,
    }
    belt_query = next(
        params for _, table, params, _ in provider.requests if table == "belt_ladders"
    )
    # Both studio scopes, archived and NOT (is_system IS TRUE), so NULL stays visible.
    assert sorted(belt_query.multi_items()) == sorted(TRAINING_BELT_QUERY)
    assert not payload.dataset_errors.model_dump(exclude_none=True)
    assert [program.id for program in payload.programs] == ["program-1"]
    assert [ladder.id for ladder in payload.belt_ladders] == ["ladder-early", "ladder-late"]
    assert payload.primary_belt_ladder.id == "ladder-early"
    assert [rank.display_order for rank in payload.primary_belt_ladder.ranks] == [0, 1, 2]


@pytest.mark.parametrize("failed,label", [("programs", "programs"), ("belt_ladders", "belts")])
def test_training_programs_and_belts_fail_independently(failed, label):
    payload = training_bootstrap(TrainingProvider(failures={failed: (500, "XX000")}))
    assert payload.dataset_errors.model_dump(exclude_none=True).keys() == {label}
    assert "private" not in payload.model_dump_json()
    if label == "programs":
        assert payload.programs == []
        assert payload.primary_belt_ladder.id == "ladder-early"
    else:
        assert payload.belt_ladders == [] and payload.primary_belt_ladder is None
        assert payload.programs[0].id == "program-1"
    with pytest.raises(APIError) as error:
        training_bootstrap(TrainingProvider(failures={failed: (500, "XX000")}), allow_partial=False)
    assert error.value.code == "XX000"


@pytest.mark.parametrize("allow_partial", [False, True])
@pytest.mark.parametrize("code", ["42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"])
def test_training_belt_join_access_failures_remain_fatal(allow_partial, code):
    with pytest.raises(APIError) as error:
        training_bootstrap(
            TrainingProvider(failures={"belt_ladders": (403, code)}), allow_partial=allow_partial
        )
    assert error.value.code == code


def test_training_without_visible_programs_is_empty_and_failed_join_is_unavailable():
    provider = TrainingProvider(programs=[], ladders=[])
    payload = training_bootstrap(provider)
    assert [table for _, table, *_ in provider.requests].count("belt_ladders") == 1
    assert payload.belt_ladders == [] and payload.primary_belt_ladder is None
    assert not payload.dataset_errors.model_dump(exclude_none=True)

    # Accepted fail-closed edge: the old preread skipped the ladder request for an
    # empty studio, so this failure used to be an empty success.
    failed = TrainingProvider(programs=[], ladders=[], failures={"belt_ladders": (400, "PGRST200")})
    payload = training_bootstrap(failed)
    assert payload.dataset_errors.model_dump(exclude_none=True).keys() == {"belts"}
    assert payload.belt_ladders == [] and payload.programs == []
    with pytest.raises(APIError):
        training_bootstrap(failed, allow_partial=False)
