import asyncio
import unittest

from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import ValidationError

from app.api.v1.endpoints import staff
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.staff import StaffLegalNameUpdate
from app.services.staff_service import (
    STAFF_PROFILE_ALREADY_EXISTS_DETAIL,
    STAFF_PROFILE_NOT_FOUND_DETAIL,
    StaffService,
)
from tests.fakes.supabase import TableBackedSupabase


def _conflict_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


def _staff_role(user_id: str, role: str, studio_id: str = "studio-a") -> dict:
    return {
        "id": f"role-{user_id}-{studio_id}",
        "studio_id": studio_id,
        "user_id": user_id,
        "role": role,
        "created_at": "2026-08-15T00:00:00+00:00",
    }


def _supabase(*roles: dict, profiles: list[dict] | None = None) -> TableBackedSupabase:
    supabase = TableBackedSupabase({
        "staff_roles": list(roles),
        "staff_profiles": list(profiles or []),
        "audit_logs": [],
    })
    supabase.unique_constraints["staff_profiles"] = [("user_id",)]
    supabase.unique_conflict_error_factory = lambda _table, _columns: _conflict_error()
    return supabase


def _set_name(
    supabase: TableBackedSupabase,
    *,
    target_user_id: str,
    actor_id: str,
    actor_role: str,
    first_name: str = "Aiko",
    last_name: str = "Tanaka",
):
    return asyncio.run(
        StaffService(supabase).update_staff_legal_name(
            target_user_id,
            StaffLegalNameUpdate(
                legal_first_name=first_name,
                legal_last_name=last_name,
            ),
            "studio-a",
            actor_id,
            actor_role,
        )
    )


class StaffLegalNameSchemaTest(unittest.TestCase):
    def test_names_are_trimmed_and_internal_whitespace_is_collapsed(self):
        data = StaffLegalNameUpdate(
            legal_first_name=" \tAiko\u00a0  Marie \n",
            legal_last_name="  Tanaka\u2003  Smith  ",
        )

        self.assertEqual(data.legal_first_name, "Aiko Marie")
        self.assertEqual(data.legal_last_name, "Tanaka Smith")

    def test_blank_names_are_rejected_at_the_request_boundary(self):
        for field in ("legal_first_name", "legal_last_name"):
            with self.subTest(field=field):
                payload = {
                    "legal_first_name": "Aiko",
                    "legal_last_name": "Tanaka",
                }
                payload[field] = " \t\n"
                with self.assertRaises(ValidationError):
                    StaffLegalNameUpdate.model_validate(payload)


class StaffLegalNameServiceTest(unittest.TestCase):
    def test_non_admin_self_set_creates_one_normalized_profile_and_one_audit(self):
        supabase = _supabase(_staff_role("user-1", "instructor"))

        response = _set_name(
            supabase,
            target_user_id="user-1",
            actor_id="user-1",
            actor_role="instructor",
            first_name=" \tAiko  ",
            last_name=" Tanaka\n Smith ",
        )

        self.assertEqual(response.model_dump(), {
            "user_id": "user-1",
            "legal_first_name": "Aiko",
            "legal_last_name": "Tanaka Smith",
        })
        self.assertEqual(len(supabase.tables["staff_profiles"]), 1)
        self.assertEqual(
            supabase.tables["staff_profiles"][0]["legal_first_name"],
            "Aiko",
        )
        self.assertEqual(
            supabase.tables["staff_profiles"][0]["legal_last_name"],
            "Tanaka Smith",
        )
        self.assertEqual(len(supabase.tables["audit_logs"]), 1)
        audit = supabase.tables["audit_logs"][0]
        self.assertEqual(audit["action"], "staff.profile_created")
        self.assertEqual(audit["entity_type"], "staff_profile")
        self.assertEqual(audit["entity_id"], "user-1")
        self.assertEqual(audit["metadata"], {
            "target_user_id": "user-1",
            "operation": "created",
        })
        self.assertNotIn("Aiko", str(audit["metadata"]))
        self.assertEqual(
            [query["table"] for query in supabase.query_log[:2]],
            ["staff_roles", "staff_profiles"],
        )
        self.assertEqual(
            supabase.query_log[0]["filters"],
            (("eq", "studio_id", "studio-a"), ("eq", "user_id", "user-1")),
        )
        self.assertEqual(
            supabase.query_log[1]["filters"],
            (("eq", "user_id", "user-1"),),
        )

    def test_non_admin_second_self_request_is_denied_without_mutation_or_audit(self):
        supabase = _supabase(
            _staff_role("user-1", "front_desk"),
            profiles=[{
                "user_id": "user-1",
                "legal_first_name": "Aiko",
                "legal_last_name": "Tanaka",
            }],
        )
        profiles_before = [dict(row) for row in supabase.tables["staff_profiles"]]
        audits_before = [dict(row) for row in supabase.tables["audit_logs"]]

        with self.assertRaises(HTTPException) as raised:
            _set_name(
                supabase,
                target_user_id="user-1",
                actor_id="user-1",
                actor_role="front_desk",
                first_name="Changed",
                last_name="Name",
            )

        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(supabase.tables["staff_profiles"], profiles_before)
        self.assertEqual(supabase.tables["audit_logs"], audits_before)
        self.assertFalse(any(query["update"] for query in supabase.query_log))
        self.assertFalse(any(query["insert"] for query in supabase.query_log))

    def test_non_admin_cannot_create_or_update_another_same_studio_member(self):
        for profiles in (
            [],
            [{
                "user_id": "user-2",
                "legal_first_name": "Existing",
                "legal_last_name": "Name",
            }],
        ):
            with self.subTest(profile_exists=bool(profiles)):
                supabase = _supabase(
                    _staff_role("user-1", "instructor"),
                    _staff_role("user-2", "front_desk"),
                    profiles=profiles,
                )
                with self.assertRaises(HTTPException) as raised:
                    _set_name(
                        supabase,
                        target_user_id="user-2",
                        actor_id="user-1",
                        actor_role="instructor",
                    )

                self.assertEqual(raised.exception.status_code, 403)
                self.assertEqual(supabase.tables["staff_profiles"], profiles)
                self.assertEqual(supabase.tables["audit_logs"], [])
                self.assertFalse(any(query["update"] for query in supabase.query_log))
                self.assertFalse(any(query["insert"] for query in supabase.query_log))

    def test_admin_can_update_self_and_create_then_update_another_member(self):
        supabase = _supabase(
            _staff_role("admin-1", "admin"),
            _staff_role("user-2", "instructor"),
            profiles=[{
                "user_id": "admin-1",
                "legal_first_name": "Admin",
                "legal_last_name": "Original",
            }],
        )

        self_response = _set_name(
            supabase,
            target_user_id="admin-1",
            actor_id="admin-1",
            actor_role="admin",
            first_name="Admin",
            last_name="Updated",
        )
        create_response = _set_name(
            supabase,
            target_user_id="user-2",
            actor_id="admin-1",
            actor_role="admin",
            first_name="Aiko",
            last_name="Tanaka",
        )
        update_response = _set_name(
            supabase,
            target_user_id="user-2",
            actor_id="admin-1",
            actor_role="admin",
            first_name="Aiko",
            last_name="Sato",
        )

        self.assertEqual(self_response.legal_last_name, "Updated")
        self.assertEqual(create_response.legal_last_name, "Tanaka")
        self.assertEqual(update_response.legal_last_name, "Sato")
        self.assertEqual(len(supabase.tables["staff_profiles"]), 2)
        target_profile = next(
            row for row in supabase.tables["staff_profiles"]
            if row["user_id"] == "user-2"
        )
        self.assertEqual(target_profile["legal_last_name"], "Sato")
        self.assertEqual(
            [audit["metadata"]["operation"] for audit in supabase.tables["audit_logs"]],
            ["updated", "created", "updated"],
        )
        self.assertEqual(
            [audit["metadata"]["target_user_id"] for audit in supabase.tables["audit_logs"]],
            ["admin-1", "user-2", "user-2"],
        )
        for audit in supabase.tables["audit_logs"]:
            self.assertNotIn("Aiko", str(audit["metadata"]))
            self.assertNotIn("Admin", str(audit["metadata"]))

    def test_cross_studio_and_missing_targets_are_non_disclosing_and_unchanged(self):
        supabase = _supabase(
            _staff_role("admin-1", "admin"),
            _staff_role("cross-studio-user", "instructor", "studio-b"),
            profiles=[{
                "user_id": "cross-studio-user",
                "legal_first_name": "Cross",
                "legal_last_name": "Studio",
            }],
        )
        profiles_before = [dict(row) for row in supabase.tables["staff_profiles"]]

        denials = []
        for target_user_id in ("cross-studio-user", "missing-user"):
            with self.subTest(target_user_id=target_user_id):
                supabase.query_log.clear()
                with self.assertRaises(HTTPException) as raised:
                    _set_name(
                        supabase,
                        target_user_id=target_user_id,
                        actor_id="admin-1",
                        actor_role="admin",
                    )
                denials.append((raised.exception.status_code, raised.exception.detail))
                self.assertEqual(
                    [query["table"] for query in supabase.query_log],
                    ["staff_roles"],
                )
                self.assertEqual(supabase.tables["staff_profiles"], profiles_before)
                self.assertEqual(supabase.tables["audit_logs"], [])

        self.assertEqual(denials, [
            (404, STAFF_PROFILE_NOT_FOUND_DETAIL),
            (404, STAFF_PROFILE_NOT_FOUND_DETAIL),
        ])

    def test_duplicate_insert_race_returns_conflict_without_updating_winner_or_auditing(self):
        supabase = _supabase(_staff_role("user-1", "instructor"))
        supabase.before_insert = self._inject_winning_profile

        with self.assertRaises(HTTPException) as raised:
            _set_name(
                supabase,
                target_user_id="user-1",
                actor_id="user-1",
                actor_role="instructor",
                first_name="Loser",
                last_name="Name",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, STAFF_PROFILE_ALREADY_EXISTS_DETAIL)
        self.assertEqual(supabase.tables["staff_profiles"], [{
            "user_id": "user-1",
            "legal_first_name": "Winner",
            "legal_last_name": "Name",
        }])
        self.assertEqual(supabase.tables["audit_logs"], [])
        self.assertFalse(any(query["update"] for query in supabase.query_log))
        self.assertFalse(any(query["table"] == "audit_logs" for query in supabase.query_log))

    @staticmethod
    def _inject_winning_profile(table_name: str, _payloads: list[dict], rows: list[dict]) -> None:
        if table_name == "staff_profiles":
            rows.append({
                "user_id": "user-1",
                "legal_first_name": "Winner",
                "legal_last_name": "Name",
            })


class StaffLegalNameEndpointTest(unittest.TestCase):
    def test_instructor_route_is_reachable_without_admin_or_subscription_dependency(self):
        supabase = _supabase(_staff_role("user-1", "instructor"))
        test_app = FastAPI()
        test_app.include_router(staff.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        route = next(
            route for route in staff.router.routes
            if isinstance(route, APIRoute)
            and route.path == "/staff/{target_user_id}/legal-name"
            and "PATCH" in route.methods
        )
        self.assertNotIn("resolve_admin_staff_role_for_user", {
            dependency.call.__name__ for dependency in route.dependant.dependencies
        })

        response = TestClient(test_app).patch(
            "/staff/user-1/legal-name",
            headers={"X-Studio-Id": "studio-a"},
            json={
                "legal_first_name": " \tAiko  ",
                "legal_last_name": "Tanaka\n Smith",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "user_id": "user-1",
            "legal_first_name": "Aiko",
            "legal_last_name": "Tanaka Smith",
        })
        self.assertNotIn("studio_subscriptions", {
            query["table"] for query in supabase.query_log
        })

    def test_unauthenticated_route_remains_controlled_by_current_user_dependency(self):
        test_app = FastAPI()
        test_app.include_router(staff.router)
        test_app.dependency_overrides[get_supabase] = lambda: _supabase()

        response = TestClient(test_app).patch(
            "/staff/user-1/legal-name",
            json={
                "legal_first_name": "Aiko",
                "legal_last_name": "Tanaka",
            },
        )

        self.assertEqual(response.status_code, 401, response.text)

    def test_foreign_requested_studio_denies_before_profile_mutation(self):
        supabase = _supabase(_staff_role("user-1", "instructor"))
        test_app = FastAPI()
        test_app.include_router(staff.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        response = TestClient(test_app).patch(
            "/staff/user-1/legal-name",
            headers={"X-Studio-Id": "studio-foreign"},
            json={
                "legal_first_name": "Aiko",
                "legal_last_name": "Tanaka",
            },
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(supabase.tables["staff_profiles"], [])
        self.assertEqual(supabase.tables["audit_logs"], [])


if __name__ == "__main__":
    unittest.main()
