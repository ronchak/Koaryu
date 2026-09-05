import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.schemas.program import ProgramResponse
from app.schemas.student import StudentResponse

from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService


class DashboardBootstrapServiceTest(unittest.TestCase):
    def test_bootstrap_schema_inherits_optional_dashboard_enrichments(self):
        schema = DashboardBootstrapResponse.model_json_schema()

        self.assertEqual(
            schema["properties"]["summary"]["anyOf"][0]["$ref"],
            "#/$defs/DashboardSummaryResponse",
        )
        summary_schema = schema["$defs"]["DashboardSummaryResponse"]
        self.assertIn("today_schedule", summary_schema["properties"])
        self.assertIn("emergency_contacts", summary_schema["properties"])
        self.assertNotIn("today_schedule", summary_schema["required"])
        self.assertNotIn("emergency_contacts", summary_schema["required"])
        billing_schema = schema["$defs"]["DashboardSummaryBillingCounts"]
        self.assertIn("amounts", billing_schema["properties"])
        self.assertNotIn("amounts", billing_schema.get("required", []))
        amounts_schema = schema["$defs"]["DashboardSummaryBillingAmounts"]
        self.assertEqual(
            set(amounts_schema["properties"]),
            {
                "available",
                "payment_attention_amount_cents",
                "due_this_week_amount_cents",
            },
        )
        today_schema = schema["$defs"]["DashboardSummaryTodaySchedule"]
        self.assertEqual(
            set(today_schema["properties"]),
            {"available", "expected_counts_available", "rows", "overflow_count"},
        )
        self.assertNotIn("overflow_count", today_schema.get("required", []))
        today_row_schema = schema["$defs"]["DashboardSummaryTodaySession"]
        self.assertEqual(
            set(today_row_schema["properties"]),
            {
                "id",
                "start_time",
                "end_time",
                "name",
                "capacity",
                "attendance_count",
                "expected_count",
            },
        )
        self.assertNotIn("expected_count", today_row_schema.get("required", []))

    def test_server_timing_value_uses_safe_labels_and_durations(self):
        value = DashboardBootstrapService.server_timing_value({
            "studio": 12.345,
            "students": 4.0,
            "total": 20.123,
        })

        self.assertEqual(
            value,
            "koaryu_studio;dur=12.3, koaryu_students;dur=4.0, koaryu_total;dur=20.1",
        )

    def test_bootstrap_does_not_build_dashboard_summary_inline(self):
        supabase = SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10.0))
        service = DashboardBootstrapService(supabase=supabase)
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
            staff_profiles_available=True,
            studio_id="studio-1",
            role="admin",
        )

        def fake_timed_fetch(label, _method_name, studio_id, postgrest_client_timeout):
            self.assertEqual(postgrest_client_timeout, 10.0)
            self.assertEqual(studio_id, "studio-1")
            if label == "studio":
                return (
                    SimpleNamespace(data={
                        "id": "studio-1",
                        "name": "River City",
                        "slug": "river-city",
                        "timezone": "UTC",
                        "logo_url": None,
                    }),
                    (label, 1.0),
                )
            if label == "students":
                return SimpleNamespace(data=[], count=250), (label, 1.0)
            if label in {"leads", "belts"}:
                return SimpleNamespace(data=[]), (label, 1.0)
            if label == "programs":
                return [], (label, 1.0)
            raise AssertionError(f"Unexpected bootstrap fetch label: {label}")

        with patch(
            "app.services.dashboard_bootstrap_service.AuthService.get_user_profile",
            new=AsyncMock(return_value=auth),
        ), patch(
            "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"
        ) as ensure_access, patch.object(
            DashboardBootstrapService,
            "_timed_fetch_with_isolated_client",
            side_effect=fake_timed_fetch,
        ):
            payload, timings = asyncio.run(
                service.get_dashboard_bootstrap("user-1")
            )

        ensure_access.assert_called_once_with(supabase, "studio-1")
        self.assertIsNone(payload.summary)
        self.assertEqual(payload.students_total, 250)
        self.assertTrue(payload.students_may_be_partial)
        self.assertNotIn("summary", timings)
        self.assertIn("total", timings)


if __name__ == "__main__":
    unittest.main()

# Projection failures must be opt-in so deployed older frontends never mistake
# missing data for a successful empty collection during a rolling release.
def partial_bootstrap_case(*, failed=None, failure=None, enrichment_failure=False, allow_partial=True):
    supabase = SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10.0))
    service = DashboardBootstrapService(supabase)
    profile = AuthResponse(
        user=UserProfile(id="partial-user", email="partial@example.test", legal_first_name="Partial", legal_last_name="User"),
        staff_profiles_available=True, membership_status="active", studio_id="partial-studio", role="admin",
    )
    student = StudentResponse(id="student-1", studio_id="partial-studio", legal_first_name="Healthy", legal_last_name="Student", status="active", created_at="2026-09-05", updated_at="2026-09-05")
    program = ProgramResponse(id="program-1", studio_id="partial-studio", name="Healthy program", created_at="2026-09-05", updated_at="2026-09-05")

    def fetch(label, _method, studio_id, timeout):
        assert studio_id == "partial-studio" and timeout == 10.0
        if label == failed:
            raise failure if failure is not None else TimeoutError("private provider detail")
        if label == "studio":
            data = SimpleNamespace(data={"id": studio_id, "name": "Healthy studio", "slug": "healthy", "timezone": "UTC"})
        elif label == "students":
            data = SimpleNamespace(data=[student.model_dump()], count=1)
        elif label == "programs":
            data = [program]
        else:
            data = SimpleNamespace(data=[])
        return data, (label, 1.0)

    with patch("app.services.dashboard_bootstrap_service.AuthService.get_user_profile", new=AsyncMock(return_value=profile)), patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"), patch.object(DashboardBootstrapService, "_timed_fetch_with_isolated_client", side_effect=fetch), patch("app.services.dashboard_bootstrap_service.StudentService.rows_to_responses", side_effect=TimeoutError("private membership enrichment detail") if enrichment_failure else None, return_value=[student]):
        return asyncio.run(service.get_dashboard_bootstrap("partial-user", allow_partial=allow_partial))


@pytest.mark.parametrize("failed", ["studio", "students", "leads", "belts", "programs"])
def test_opted_bootstrap_retains_healthy_projections_and_marks_failed_data_unavailable(failed):
    payload, timings = partial_bootstrap_case(failed=failed)
    assert payload.auth.membership_status == "active"
    assert payload.auth.user.legal_first_name == "Partial"
    assert payload.dataset_errors.model_dump(exclude_none=True).keys() == {failed}
    assert "private" not in payload.model_dump_json()
    assert failed in timings
    if failed == "students":
        assert payload.students == []
        assert payload.students_total is None
        assert payload.students_may_be_partial
    else:
        assert payload.students[0].id == "student-1"
        assert payload.students_total == 1
    if failed != "programs":
        assert payload.programs[0].id == "program-1"
    if failed == "studio":
        assert payload.studio is None and payload.studio_name is None


def test_student_enrichment_failure_does_not_discard_healthy_programs_or_fabricate_roster_count():
    payload, _ = partial_bootstrap_case(enrichment_failure=True)
    assert payload.dataset_errors.students
    assert payload.students_total is None
    assert payload.students == []
    assert payload.programs[0].id == "program-1"
    assert payload.dataset_errors.leads is None
    assert payload.leads == []  # Genuine successful empty result.


@pytest.mark.parametrize("allow_partial", [False, True])
@pytest.mark.parametrize("status_code", [401, 402, 403])
def test_projection_access_failures_remain_fatal(allow_partial, status_code):
    with pytest.raises(HTTPException) as result:
        partial_bootstrap_case(failed="leads", failure=HTTPException(status_code=status_code), allow_partial=allow_partial)
    assert result.value.status_code == status_code


def test_legacy_bootstrap_still_rejects_partial_data():
    with pytest.raises(TimeoutError):
        partial_bootstrap_case(failed="leads", allow_partial=False)


def test_partial_projection_opt_in_is_off_by_default_in_endpoint_and_service():
    import inspect
    from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap
    assert inspect.signature(get_dashboard_bootstrap).parameters["allow_partial"].default is False
    assert inspect.signature(DashboardBootstrapService.get_dashboard_bootstrap).parameters["allow_partial"].default is False


@pytest.mark.parametrize("allow_partial", [False, True])
def test_bootstrap_endpoint_forwards_partial_opt_in_without_changing_private_headers(allow_partial):
    from fastapi import Response
    from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap
    payload, timings = partial_bootstrap_case()
    client = object()
    provider = object()
    response = Response()

    async def run_operation(actual_provider, operation, *, lane):
        assert actual_provider is provider and lane == "interactive"
        return await operation(client)

    with patch("app.api.v1.endpoints.dashboard.run_supabase_operation", side_effect=run_operation), patch.object(DashboardBootstrapService, "get_dashboard_bootstrap", new=AsyncMock(return_value=(payload, timings))) as bootstrap:
        result = asyncio.run(get_dashboard_bootstrap(response, allow_partial=allow_partial, user_id="partial-user", requested_studio_id="partial-studio", supabase=provider))
    bootstrap.assert_awaited_once_with("partial-user", "partial-studio", provider_owned=True, allow_partial=allow_partial)
    assert result is payload
    assert "private" in response.headers["cache-control"]
    assert "server-timing" in response.headers
