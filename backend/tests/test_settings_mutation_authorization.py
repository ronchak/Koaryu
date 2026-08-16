import asyncio
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, call, patch

from fastapi import HTTPException

from app.api.v1.endpoints import demo, programs, staff, studios
from app.schemas.program import ProgramCreate, ProgramUpdate
from app.schemas.staff import (
    StaffDeletionRequestCreate,
    StaffInviteCreate,
    StaffLegalNameUpdate,
    StaffRoleUpdate,
)
from app.schemas.studio import StudioUpdate
from app.services.studio_scope import resolve_admin_staff_role_for_user
from tests.fakes.supabase import TableBackedSupabase


STUDIO_ID = "settings-studio"
ADMIN_USER_ID = "settings-admin"
LEGAL_NAME_ROUTE = "PATCH /staff/{target_user_id}/legal-name"
NON_ADMIN_ROLES = ("front_desk", "instructor")
ADMIN_GUARDED_SETTINGS_MUTATION_ROUTE_COUNT = 13
SETTINGS_MUTATION_ROUTE_COUNT = 14
EXPECTED_NON_ADMIN_SUBCASES = 28
SETTINGS_MUTATION_ROUTE_INVENTORY = (
    "PATCH /studios/current",
    "POST /programs",
    "PATCH /programs/{program_id}",
    "POST /programs/{program_id}/archive",
    "POST /programs/{program_id}/restore",
    "POST /staff/invitations",
    LEGAL_NAME_ROUTE,
    "PATCH /staff/{staff_role_id}",
    "POST /staff/{staff_role_id}/archive",
    "POST /staff/{staff_role_id}/unarchive",
    "POST /staff/{staff_role_id}/deletion-request",
    "DELETE /staff/{staff_role_id}",
    "POST /demo/reset",
    "DELETE /demo/data",
)


def _active_subscription() -> dict:
    return {
        "studio_id": STUDIO_ID,
        "status": "active",
        "comped": False,
        "trial_end": None,
        "current_period_start": 1_700_000_000,
        "current_period_end": 1_800_000_000,
        "stripe_subscription_id": "subscription-active",
        "stripe_customer_id": "customer-active",
    }


def _supabase_for_role(role: str, *, user_id: str | None = None) -> TableBackedSupabase:
    user_id = user_id or f"user-{role}"
    return TableBackedSupabase(
        {
            "staff_roles": [
                {
                    "id": f"role-{role}",
                    "studio_id": STUDIO_ID,
                    "user_id": user_id,
                    "role": role,
                    "created_at": "2026-08-01T00:00:00+00:00",
                },
            ],
            "studio_subscriptions": [_active_subscription()],
        }
    )


def _supabase_for_cross_user_legal_name(role: str) -> TableBackedSupabase:
    actor_id = f"user-{role}"
    target_id = "target-user"
    return TableBackedSupabase(
        {
            "staff_roles": [
                {
                    "id": f"role-{role}",
                    "studio_id": STUDIO_ID,
                    "user_id": actor_id,
                    "role": role,
                    "created_at": "2026-08-01T00:00:00+00:00",
                },
                {
                    "id": "target-role",
                    "studio_id": STUDIO_ID,
                    "user_id": target_id,
                    "role": "instructor",
                    "created_at": "2026-08-02T00:00:00+00:00",
                },
            ],
            "studio_subscriptions": [_active_subscription()],
            "staff_profiles": [{
                "user_id": target_id,
                "legal_first_name": "Existing",
                "legal_last_name": "Name",
            }],
            "audit_logs": [{
                "id": "existing-audit",
                "studio_id": STUDIO_ID,
                "actor_id": "existing-actor",
                "action": "existing.action",
            }],
        }
    )


def _settings_mutation_cases():
    return (
        (
            "PATCH /studios/current",
            "app.api.v1.endpoints.studios.StudioService",
            lambda user_id, supabase: asyncio.run(
                studios.update_current_studio(
                    StudioUpdate(name="Renamed studio"),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /programs",
            "app.api.v1.endpoints.programs.ProgramService",
            lambda user_id, supabase: asyncio.run(
                programs.create_program(
                    ProgramCreate(name="Kids karate"),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "PATCH /programs/{program_id}",
            "app.api.v1.endpoints.programs.ProgramService",
            lambda user_id, supabase: asyncio.run(
                programs.update_program(
                    "program-1",
                    ProgramUpdate(name="Adults karate"),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /programs/{program_id}/archive",
            "app.api.v1.endpoints.programs.ProgramService",
            lambda user_id, supabase: asyncio.run(
                programs.archive_program(
                    "program-1",
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /programs/{program_id}/restore",
            "app.api.v1.endpoints.programs.ProgramService",
            lambda user_id, supabase: asyncio.run(
                programs.restore_program(
                    "program-1",
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /staff/invitations",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.invite_staff(
                    StaffInviteCreate(
                        email="new@example.com",
                        role="instructor",
                        full_name="New Instructor",
                        legal_first_name="New",
                        legal_last_name="Instructor",
                    ),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "PATCH /staff/{staff_role_id}",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.update_staff_role(
                    "staff-role-1",
                    StaffRoleUpdate(role="instructor"),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /staff/{staff_role_id}/archive",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.archive_staff(
                    "staff-role-1",
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /staff/{staff_role_id}/unarchive",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.unarchive_staff(
                    "staff-role-1",
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /staff/{staff_role_id}/deletion-request",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.schedule_staff_deletion(
                    "staff-role-1",
                    StaffDeletionRequestCreate(
                        confirmation_name="Display target-1",
                        reason="offboarding",
                    ),
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "DELETE /staff/{staff_role_id}",
            "app.api.v1.endpoints.staff.StaffService",
            lambda user_id, supabase: asyncio.run(
                staff.remove_staff(
                    "staff-role-1",
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    supabase=supabase,
                )
            ),
        ),
        (
            "POST /demo/reset",
            "app.api.v1.endpoints.demo.DemoService",
            lambda user_id, supabase: asyncio.run(
                demo.reset_demo_studio(
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    destructive_action=demo.DEMO_RESET_DESTRUCTIVE_ACTION,
                    supabase=supabase,
                )
            ),
        ),
        (
            "DELETE /demo/data",
            "app.api.v1.endpoints.demo.DemoService",
            lambda user_id, supabase: asyncio.run(
                demo.clear_studio_data(
                    user_id=user_id,
                    requested_studio_id=STUDIO_ID,
                    destructive_action=demo.CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION,
                    supabase=supabase,
                )
            ),
        ),
    )


class SettingsMutationAuthorizationTest(unittest.TestCase):
    def assert_no_mutation(self, supabase: TableBackedSupabase) -> None:
        for query in supabase.query_log:
            self.assertIsNone(query["insert"])
            self.assertIsNone(query["upsert"])
            self.assertIsNone(query["update"])
            self.assertFalse(query["delete"])

    def test_every_settings_mutation_rejects_non_admin_roles_before_service(self):
        cases = _settings_mutation_cases()
        self.assertEqual(len(cases), ADMIN_GUARDED_SETTINGS_MUTATION_ROUTE_COUNT)
        self.assertEqual(len(SETTINGS_MUTATION_ROUTE_INVENTORY), SETTINGS_MUTATION_ROUTE_COUNT)
        case_routes = [route for route, _service_path, _invoke in cases]
        case_routes.insert(6, LEGAL_NAME_ROUTE)
        self.assertEqual(
            tuple(case_routes),
            SETTINGS_MUTATION_ROUTE_INVENTORY,
        )
        self.assertEqual(
            len(NON_ADMIN_ROLES) * len(cases) + len(NON_ADMIN_ROLES),
            EXPECTED_NON_ADMIN_SUBCASES,
        )

        for role in NON_ADMIN_ROLES:
            for route, service_path, invoke in cases:
                with self.subTest(role=role, route=route):
                    supabase = _supabase_for_role(role)
                    with ExitStack() as stack:
                        service_class = stack.enter_context(patch(service_path))
                        if route.startswith(("POST /demo", "DELETE /demo")):
                            stack.enter_context(
                                patch(
                                    "app.api.v1.endpoints.demo.get_settings",
                                    return_value=SimpleNamespace(
                                        DEMO_RESET_ENABLED=True,
                                        DEMO_RESET_STUDIO_IDS=STUDIO_ID,
                                    ),
                                )
                            )

                        with self.assertRaises(HTTPException) as context:
                            invoke(f"user-{role}", supabase)

                    self.assertEqual(context.exception.status_code, 403)
                    service_class.assert_not_called()
                    self.assert_no_mutation(supabase)

    def test_non_admin_cross_user_legal_name_is_denied_by_real_service_boundary(self):
        for role in NON_ADMIN_ROLES:
            with self.subTest(role=role):
                supabase = _supabase_for_cross_user_legal_name(role)
                profiles_before = [dict(row) for row in supabase.tables["staff_profiles"]]
                audits_before = [dict(row) for row in supabase.tables["audit_logs"]]

                with self.assertRaises(HTTPException) as context:
                    asyncio.run(
                        staff.update_staff_legal_name(
                            "target-user",
                            StaffLegalNameUpdate(
                                legal_first_name="Updated",
                                legal_last_name="Name",
                            ),
                            user_id=f"user-{role}",
                            requested_studio_id=STUDIO_ID,
                            supabase=supabase,
                        )
                    )

                self.assertEqual(context.exception.status_code, 403)
                self.assertEqual(supabase.tables["staff_profiles"], profiles_before)
                self.assertEqual(supabase.tables["audit_logs"], audits_before)
                self.assert_no_mutation(supabase)

    def test_admin_program_mutations_delegate_resolved_scope_and_actor(self):
        service = SimpleNamespace(
            create_program=AsyncMock(return_value="created"),
            update_program=AsyncMock(return_value="updated"),
            archive_program=AsyncMock(return_value="archived"),
            restore_program=AsyncMock(return_value="restored"),
        )
        supabase = _supabase_for_role("admin", user_id=ADMIN_USER_ID)
        resolved_studio_id = STUDIO_ID

        with (
            patch(
                "app.api.v1.endpoints.programs.resolve_admin_staff_role_for_user",
                wraps=resolve_admin_staff_role_for_user,
            ) as resolve_admin,
            patch(
                "app.api.v1.endpoints.programs.ProgramService",
                return_value=service,
            ) as service_class,
        ):
            results = [
                asyncio.run(
                    programs.create_program(
                        ProgramCreate(name="Kids karate"),
                        user_id=ADMIN_USER_ID,
                        requested_studio_id=STUDIO_ID,
                        supabase=supabase,
                    )
                ),
                asyncio.run(
                    programs.update_program(
                        "program-1",
                        ProgramUpdate(name="Adults karate"),
                        user_id=ADMIN_USER_ID,
                        requested_studio_id=STUDIO_ID,
                        supabase=supabase,
                    )
                ),
                asyncio.run(
                    programs.archive_program(
                        "program-1",
                        user_id=ADMIN_USER_ID,
                        requested_studio_id=STUDIO_ID,
                        supabase=supabase,
                    )
                ),
                asyncio.run(
                    programs.restore_program(
                        "program-1",
                        user_id=ADMIN_USER_ID,
                        requested_studio_id=STUDIO_ID,
                        supabase=supabase,
                    )
                ),
            ]

        self.assertEqual(results, ["created", "updated", "archived", "restored"])
        self.assertEqual(resolve_admin.call_count, 4)
        self.assertTrue(
            all(
                invocation.args == (supabase, ADMIN_USER_ID, STUDIO_ID)
                and invocation.kwargs == {"require_platform_subscription": True}
                for invocation in resolve_admin.call_args_list
            )
        )
        self.assertEqual(service_class.call_args_list, [call(supabase)] * 4)
        service.create_program.assert_awaited_once_with(
            ProgramCreate(name="Kids karate"),
            resolved_studio_id,
            ADMIN_USER_ID,
        )
        service.update_program.assert_awaited_once_with(
            "program-1",
            ProgramUpdate(name="Adults karate"),
            resolved_studio_id,
            ADMIN_USER_ID,
        )
        service.archive_program.assert_awaited_once_with(
            "program-1",
            resolved_studio_id,
            ADMIN_USER_ID,
        )
        service.restore_program.assert_awaited_once_with(
            "program-1",
            resolved_studio_id,
            ADMIN_USER_ID,
        )


if __name__ == "__main__":
    unittest.main()
