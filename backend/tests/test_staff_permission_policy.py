import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.v1.endpoints import belts, leads, schedule, students
from app.core.deps import (
    get_belt_configuration_admin_studio_id,
    get_current_user_id,
    get_current_write_staff_role,
    get_current_write_studio_id,
    get_lead_conversion_manager_studio_id,
    get_lead_manager_studio_id,
    get_promotion_manager_studio_id,
    get_roster_schedule_manager_studio_id,
    get_supabase,
)
from app.schemas.lead import LeadCreate, LeadUpdate
from app.services.studio_scope import (
    STAFF_ROLE_MEMBERSHIP_COLUMNS,
    MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL,
    resolve_belt_configuration_admin_staff_role_for_user,
    resolve_billing_admin_staff_role_for_user,
    resolve_billing_manager_staff_role_for_user,
    resolve_billing_routine_write_staff_role_for_user,
    resolve_lead_conversion_manager_staff_role_for_user,
    resolve_lead_manager_staff_role_for_user,
    resolve_promotion_manager_staff_role_for_user,
    resolve_roster_schedule_manager_staff_role_for_user,
    resolve_write_staff_role_for_user,
)
from tests.fakes.supabase import TableBackedSupabase


ALL_STAFF_ROLES = frozenset({"admin", "front_desk", "instructor"})
ROLE_POLICY_CASES = (
    ("routine attendance", resolve_write_staff_role_for_user, ALL_STAFF_ROLES),
    (
        "roster and schedule bulk/delete",
        resolve_roster_schedule_manager_staff_role_for_user,
        frozenset({"admin", "front_desk"}),
    ),
    (
        "belt configuration",
        resolve_belt_configuration_admin_staff_role_for_user,
        frozenset({"admin"}),
    ),
    (
        "promotions",
        resolve_promotion_manager_staff_role_for_user,
        frozenset({"admin", "instructor"}),
    ),
    (
        "lead conversion",
        resolve_lead_conversion_manager_staff_role_for_user,
        frozenset({"admin", "front_desk"}),
    ),
    (
        "lead management",
        resolve_lead_manager_staff_role_for_user,
        frozenset({"admin", "front_desk"}),
    ),
)


def _routes(*values: tuple[str, str]) -> set[tuple[str, str]]:
    return set(values)


# Inventory only the mutation routes changed for this approved policy.
AFFECTED_ROUTE_DEPENDENCIES = {
    get_current_write_studio_id: _routes(
        ("POST", "/students/{student_id}/photo"),
        ("POST", "/schedule/attendance"),
        ("DELETE", "/schedule/attendance"),
        ("POST", "/schedule/attendance/bulk"),
    ),
    get_current_write_staff_role: _routes(
        ("PATCH", "/students/{student_id}"),
    ),
    get_roster_schedule_manager_studio_id: _routes(
        ("POST", "/students"),
        ("DELETE", "/students/{student_id}/photo"),
        ("DELETE", "/students/{student_id}"),
        ("POST", "/students/{student_id}/programs"),
        ("PATCH", "/students/{student_id}/programs/{membership_id}"),
        ("DELETE", "/students/{student_id}/programs/{membership_id}"),
        ("POST", "/students/bulk/tags"),
        ("POST", "/students/bulk/status"),
        ("POST", "/students/import/execute"),
        ("POST", "/schedule/templates"),
        ("PATCH", "/schedule/templates/{template_id}"),
        ("DELETE", "/schedule/templates/{template_id}"),
        ("POST", "/schedule/sessions/materialize"),
        ("POST", "/schedule/sessions"),
        ("DELETE", "/schedule/sessions/{session_id}"),
        ("POST", "/schedule/sessions/generate-week"),
    ),
    get_belt_configuration_admin_studio_id: _routes(
        ("POST", "/belts/ladders"),
        ("PATCH", "/belts/ladders/{ladder_id}"),
        ("POST", "/belts/ladders/{ladder_id}/sync"),
        ("POST", "/belts/ladders/{ladder_id}/ranks"),
        ("PATCH", "/belts/ranks/{rank_id}"),
        ("DELETE", "/belts/ranks/{rank_id}"),
    ),
    get_promotion_manager_studio_id: _routes(
        ("POST", "/belts/demote"),
        ("POST", "/belts/promote"),
    ),
    get_lead_conversion_manager_studio_id: _routes(
        ("POST", "/leads/{lead_id}/convert"),
    ),
    get_lead_manager_studio_id: _routes(
        ("POST", "/leads"),
        ("PATCH", "/leads/{lead_id}"),
        ("POST", "/leads/{lead_id}/activities"),
    ),
}


def _staff_role(
    role: str,
    *,
    studio_id: str = "studio-a",
    user_id: str = "user-1",
    created_at: str = "2026-07-12T12:00:00+00:00",
) -> dict:
    return {
        "id": f"role-{user_id}-{studio_id}",
        "studio_id": studio_id,
        "user_id": user_id,
        "role": role,
        "created_at": created_at,
    }


def _supabase(*roles: dict, extra_tables: dict | None = None) -> TableBackedSupabase:
    tables = {
        "staff_roles": list(roles),
        "audit_logs": [],
        **(extra_tables or {}),
    }
    return TableBackedSupabase(tables)


def _dependency_calls(dependant) -> set[object]:
    calls = {dependant.call}
    for child in dependant.dependencies:
        calls.update(_dependency_calls(child))
    return calls


def _assert_no_mutation(test_case: unittest.TestCase, supabase: TableBackedSupabase) -> None:
    for query in supabase.query_log:
        test_case.assertIsNone(query["insert"])
        test_case.assertIsNone(query["upsert"])
        test_case.assertIsNone(query["update"])
        test_case.assertFalse(query["delete"])


class StaffPermissionPolicyTest(unittest.TestCase):
    def test_billing_role_denial_precedes_platform_subscription_access(self):
        resolvers = (
            resolve_billing_admin_staff_role_for_user,
            resolve_billing_manager_staff_role_for_user,
            resolve_billing_routine_write_staff_role_for_user,
        )

        for resolver in resolvers:
            with self.subTest(resolver=resolver.__name__):
                supabase = _supabase(_staff_role("instructor"))
                with patch(
                    "app.services.studio_scope.ensure_platform_subscription_access",
                    side_effect=AssertionError("denied billing role reached subscription access"),
                ) as subscription_access:
                    with self.assertRaises(HTTPException) as denial:
                        resolver(
                            supabase,
                            "user-1",
                            "studio-a",
                            require_platform_subscription=True,
                        )

                self.assertEqual(denial.exception.status_code, 403)
                subscription_access.assert_not_called()
                self.assertEqual(
                    [query["table"] for query in supabase.query_log],
                    ["staff_roles"],
                )
                _assert_no_mutation(self, supabase)

    def test_generic_lead_mutations_cannot_enter_enrolled_stage(self):
        for schema, payload in (
            (LeadCreate, {"first_name": "Aiko", "last_name": "Tanaka", "stage": "enrolled"}),
            (LeadUpdate, {"stage": "enrolled"}),
        ):
            with self.subTest(schema=schema.__name__):
                with self.assertRaises(ValidationError):
                    schema.model_validate(payload)

        supabase = _supabase(
            _staff_role("front_desk"),
            extra_tables={
                "studio_subscriptions": [
                    {
                        "studio_id": "studio-a",
                        "status": "active",
                        "comped": False,
                        "trial_end": None,
                    }
                ]
            },
        )
        test_app = FastAPI()
        test_app.include_router(leads.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch("app.api.v1.endpoints.leads.LeadService") as service_class:
            create_response = TestClient(test_app).post(
                "/leads",
                headers={"X-Studio-Id": "studio-a"},
                json={"first_name": "Aiko", "last_name": "Tanaka", "stage": "enrolled"},
            )
            update_response = TestClient(test_app).patch(
                "/leads/lead-1",
                headers={"X-Studio-Id": "studio-a"},
                json={"stage": "enrolled"},
            )

        self.assertEqual(create_response.status_code, 422, create_response.text)
        self.assertEqual(update_response.status_code, 422, update_response.text)
        service_class.assert_not_called()
        self.assertEqual(supabase.tables["audit_logs"], [])
        _assert_no_mutation(self, supabase)

    def test_approved_role_matrix_uses_authoritative_staff_roles(self):
        for policy, resolver, allowed_roles in ROLE_POLICY_CASES:
            for role in ALL_STAFF_ROLES:
                with self.subTest(policy=policy, role=role):
                    supabase = _supabase(_staff_role(role))

                    if role in allowed_roles:
                        membership = resolver(supabase, "user-1", "studio-a")
                        self.assertEqual(membership["role"], role)
                        self.assertEqual(membership["studio_id"], "studio-a")
                    else:
                        with self.assertRaises(HTTPException) as context:
                            resolver(supabase, "user-1", "studio-a")
                        self.assertEqual(context.exception.status_code, 403)

                    self.assertEqual(len(supabase.query_log), 1)
                    role_query = supabase.query_log[0]
                    self.assertEqual(role_query["table"], "staff_roles")
                    self.assertEqual(role_query["columns"], STAFF_ROLE_MEMBERSHIP_COLUMNS)
                    self.assertIn(("eq", "user_id", "user-1"), role_query["filters"])
                    _assert_no_mutation(self, supabase)

        with self.assertRaises(HTTPException) as context:
            resolve_write_staff_role_for_user(_supabase(), "user-1", "studio-a")
        self.assertEqual(context.exception.status_code, 403)

    def test_multi_studio_accounts_fail_closed_even_with_a_valid_selector(self):
        roles = (
            _staff_role("admin", studio_id="studio-a", created_at="2026-07-11T12:00:00+00:00"),
            _staff_role("instructor", studio_id="studio-b"),
        )

        for selector in ("studio-b", None, "studio-foreign"):
            with self.subTest(selector=selector):
                with self.assertRaises(HTTPException) as denial:
                    resolve_write_staff_role_for_user(_supabase(*roles), "user-1", selector)
                self.assertEqual(denial.exception.status_code, 409)
                self.assertEqual(denial.exception.detail, MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL)

    def test_single_membership_write_behavior_is_unchanged(self):
        supabase = _supabase(_staff_role("instructor"))

        membership = resolve_write_staff_role_for_user(supabase, "user-1")

        self.assertEqual(membership["studio_id"], "studio-a")
        self.assertEqual(membership["role"], "instructor")

    def test_foreign_and_missing_tenants_have_identical_non_disclosing_denials(self):
        foreign_student = {"id": "student-foreign", "studio_id": "studio-foreign"}
        supabase = _supabase(
            _staff_role("admin"),
            extra_tables={"students": [foreign_student]},
        )
        denials = []

        for selector in ("studio-foreign", "studio-missing"):
            with self.assertRaises(HTTPException) as context:
                resolve_roster_schedule_manager_staff_role_for_user(
                    supabase,
                    "user-1",
                    selector,
                )
            denials.append((context.exception.status_code, context.exception.detail))

        self.assertEqual(denials[0], denials[1])
        self.assertEqual(denials[0][0], 403)
        self.assertEqual(
            denials[0][1],
            "You do not have access to the requested studio.",
        )
        self.assertEqual(supabase.tables["students"], [foreign_student])
        self.assertEqual(supabase.tables["audit_logs"], [])
        self.assertEqual({query["table"] for query in supabase.query_log}, {"staff_roles"})
        _assert_no_mutation(self, supabase)

    def test_role_denial_precedes_endpoint_service_construction_and_audit(self):
        supabase = _supabase(_staff_role("instructor"))
        test_app = FastAPI()
        test_app.include_router(students.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch("app.api.v1.endpoints.students.StudentService") as service_class:
            response = TestClient(test_app).delete(
                "/students/student-1",
                headers={"X-Studio-Id": "studio-a"},
            )

        self.assertEqual(response.status_code, 403, response.text)
        service_class.assert_not_called()
        self.assertEqual(supabase.tables["audit_logs"], [])
        _assert_no_mutation(self, supabase)

    def test_instructor_student_create_and_lifecycle_update_are_denied_before_service(self):
        supabase = _supabase(
            _staff_role("instructor"),
            extra_tables={
                "studio_subscriptions": [{
                    "studio_id": "studio-a",
                    "status": "active",
                    "comped": False,
                    "trial_end": None,
                }],
            },
        )
        test_app = FastAPI()
        test_app.include_router(students.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch("app.api.v1.endpoints.students.StudentService") as service_class:
            create_response = TestClient(test_app).post(
                "/students",
                headers={"X-Studio-Id": "studio-a"},
                json={"legal_first_name": "Aiko", "legal_last_name": "Tanaka"},
            )
            status_response = TestClient(test_app).patch(
                "/students/student-1",
                headers={"X-Studio-Id": "studio-a"},
                json={"status": "inactive"},
            )

        self.assertEqual(create_response.status_code, 403, create_response.text)
        self.assertEqual(status_response.status_code, 403, status_response.text)
        service_class.assert_not_called()
        self.assertEqual(supabase.tables["audit_logs"], [])
        _assert_no_mutation(self, supabase)

    def test_instructor_can_update_ordinary_student_profile_fields(self):
        supabase = _supabase(
            _staff_role("instructor"),
            extra_tables={
                "studio_subscriptions": [{
                    "studio_id": "studio-a",
                    "status": "active",
                    "comped": False,
                    "trial_end": None,
                }],
            },
        )
        test_app = FastAPI()
        test_app.include_router(students.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase
        student_row = {
            "id": "student-1",
            "studio_id": "studio-a",
            "legal_first_name": "Aiko",
            "legal_last_name": "Tanaka",
            "status": "active",
            "tags": [],
            "guardians": [],
            "program_memberships": [],
            "created_at": "2026-07-12T12:00:00Z",
            "updated_at": "2026-07-12T12:00:00Z",
        }

        with patch("app.api.v1.endpoints.students.StudentService") as service_class:
            service_class.return_value.update_student = AsyncMock(return_value=student_row)
            response = TestClient(test_app).patch(
                "/students/student-1",
                headers={"X-Studio-Id": "studio-a"},
                json={"preferred_name": "Ai", "notes": "Prefers morning classes"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        service_class.return_value.update_student.assert_awaited_once()

    def test_affected_mutation_routes_use_the_reviewed_dependencies(self):
        observed = {dependency: set() for dependency in AFFECTED_ROUTE_DEPENDENCIES}

        for router in (students.router, schedule.router, belts.router, leads.router):
            for route in router.routes:
                if not isinstance(route, APIRoute):
                    continue
                tracked = _dependency_calls(route.dependant) & AFFECTED_ROUTE_DEPENDENCIES.keys()
                self.assertLessEqual(len(tracked), 1, route.path)
                for dependency in tracked:
                    observed[dependency].update((method, route.path) for method in route.methods)

        self.assertEqual(observed, AFFECTED_ROUTE_DEPENDENCIES)


if __name__ == "__main__":
    unittest.main()
