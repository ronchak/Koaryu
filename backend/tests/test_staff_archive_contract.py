import asyncio
import csv
import unittest
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError as PostgrestAPIError

from app.api.v1.endpoints import staff as staff_endpoint
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.auth_service import AuthService
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from app.services.report_export_service import ReportExportService
from app.services.staff_service import (
    STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL,
    STAFF_DELETE_CONFIRMATION_MISMATCH_DETAIL,
    STAFF_DELETE_REQUIRES_LINKED_DETAIL,
    STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL,
    STAFF_OWNER_ARCHIVE_CONFLICT_DETAIL,
    StaffService,
)
from app.schemas.staff import StaffDeletionRequestCreate
from app.services.studio_scope import (
    STAFF_ARCHIVED_DETAIL,
    ensure_staff_user_in_studio,
    resolve_optional_staff_role_for_user,
    resolve_staff_role_for_user,
)
from app.services.studio_service import StudioService
from tests.fakes.supabase import TableBackedSupabase


ARCHIVED_AT = "2026-08-15T20:00:00+00:00"


def staff_role(
    role_id: str,
    user_id: str | None,
    role: str = "instructor",
    *,
    archived_at: str | None = None,
    studio_id: str = "studio-1",
) -> dict:
    return {
        "id": role_id,
        "studio_id": studio_id,
        "user_id": user_id,
        "role": role,
        "archived_at": archived_at,
        "invited_by": "admin-1",
        "invited_email": f"{role_id}@invite.example",
        "created_at": "2026-08-15T00:00:00+00:00",
        "updated_at": "2026-08-15T00:00:00+00:00",
    }


def auth_user(user_id: str, *, active: bool = True) -> SimpleNamespace:
    timestamp = "2026-08-15T00:00:00+00:00" if active else None
    return SimpleNamespace(
        id=user_id,
        email=f"{user_id}@example.com",
        user_metadata={"full_name": f"Display {user_id}"},
        confirmed_at=timestamp,
        email_confirmed_at=timestamp,
        last_sign_in_at=timestamp if active else None,
    )


class ArchiveAuthAdmin:
    def __init__(self, supabase: "ArchiveSupabase"):
        self.supabase = supabase

    def get_user_by_id(self, user_id: str):
        return SimpleNamespace(user=self.supabase.auth_users.get(user_id))

    def delete_user(self, user_id: str):
        self.supabase.delete_calls.append(user_id)
        self.supabase.auth_users.pop(user_id, None)
        self.supabase.tables["staff_profiles"] = [
            row
            for row in self.supabase.tables.get("staff_profiles", [])
            if row.get("user_id") != user_id
        ]


class ArchiveSupabase(TableBackedSupabase):
    def __init__(self, tables: dict[str, list[dict]] | None = None, *, auth_users=None):
        super().__init__(tables or {})
        self.auth_users = auth_users or {}
        self.delete_calls = []
        self.auth = SimpleNamespace(admin=ArchiveAuthAdmin(self))


class StaffArchiveReadTest(unittest.TestCase):
    def test_archived_status_precedes_auth_status_and_hydrates_timestamp(self):
        service = StaffService(ArchiveSupabase())

        response = service._hydrate_staff_member(
            staff_role("role-1", "user-1", archived_at=ARCHIVED_AT),
            user=auth_user("user-1", active=True),
        )

        self.assertEqual(response.status, "archived")
        self.assertEqual(response.archived_at, ARCHIVED_AT)
        self.assertEqual(response.full_name, "Display user-1")

    def test_staff_list_excludes_archived_rows_at_database_query_by_default(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [
                    staff_role("active-role", "active-user"),
                    staff_role("archived-role", "archived-user", archived_at=ARCHIVED_AT),
                ],
            },
            auth_users={
                "active-user": auth_user("active-user"),
                "archived-user": auth_user("archived-user"),
            },
        )
        service = StaffService(supabase)

        visible = asyncio.run(service.list_staff("studio-1"))
        included = asyncio.run(service.list_staff("studio-1", include_archived=True))

        self.assertEqual([row.id for row in visible], ["active-role"])
        self.assertEqual([row.id for row in included], ["active-role", "archived-role"])
        default_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        )
        self.assertIn(("is", "archived_at", None), default_query["filters"])
        include_query = [
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        ][1]
        self.assertNotIn(("is", "archived_at", None), include_query["filters"])

    def test_staff_list_route_passes_include_archived_only_after_admin_resolution(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [
                    staff_role("active-role", "active-user"),
                    staff_role("archived-role", "archived-user", archived_at=ARCHIVED_AT),
                ],
            },
            auth_users={
                "active-user": auth_user("active-user"),
                "archived-user": auth_user("archived-user"),
            },
        )
        test_app = FastAPI()
        test_app.include_router(staff_endpoint.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "admin-1"
        test_app.dependency_overrides[get_requested_studio_id] = lambda: "studio-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch(
            "app.api.v1.endpoints.staff._resolve_admin_studio_id",
            return_value="studio-1",
        ):
            client = TestClient(test_app)
            default_response = client.get("/staff")
            included_response = client.get("/staff?include_archived=true")

        self.assertEqual(default_response.status_code, 200, default_response.text)
        self.assertEqual(included_response.status_code, 200, included_response.text)
        self.assertEqual(
            [row["id"] for row in default_response.json()],
            ["active-role"],
        )
        self.assertEqual(
            [row["id"] for row in included_response.json()],
            ["active-role", "archived-role"],
        )

    def test_staff_list_does_not_fail_open_when_archive_column_is_unavailable(self):
        supabase = ArchiveSupabase({
            "staff_roles": [staff_role("active-role", "active-user")],
        })
        supabase.table_failures["staff_roles"] = PostgrestAPIError({
            "code": "42703",
            "message": "column staff_roles.archived_at does not exist",
            "details": "",
            "hint": "",
        })

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(StaffService(supabase).list_staff("studio-1"))

        self.assertEqual(raised.exception.code, "42703")
        role_queries = [
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        ]
        self.assertEqual(len(role_queries), 2)
        self.assertTrue(all(("is", "archived_at", None) in query["filters"] for query in role_queries))


class StaffArchiveMutationTest(unittest.TestCase):
    def test_archive_and_unarchive_are_idempotent_and_only_update_archived_at(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("role-1", "user-1")],
                "studios": [{"id": "studio-1", "owner_id": "owner-1"}],
                "audit_logs": [],
            },
            auth_users={"user-1": auth_user("user-1")},
        )
        service = StaffService(supabase)

        archived = asyncio.run(service.archive_staff("role-1", "studio-1", "admin-1"))
        archived_again = asyncio.run(service.archive_staff("role-1", "studio-1", "admin-1"))
        unarchived = asyncio.run(service.unarchive_staff("role-1", "studio-1", "admin-1"))
        unarchived_again = asyncio.run(service.unarchive_staff("role-1", "studio-1", "admin-1"))

        self.assertEqual(archived.status, "archived")
        self.assertIsNotNone(archived.archived_at)
        self.assertEqual(archived_again.archived_at, archived.archived_at)
        self.assertEqual(unarchived.status, "active")
        self.assertIsNone(unarchived.archived_at)
        self.assertEqual(unarchived_again.status, "active")
        updates = [
            query["update"]
            for query in supabase.query_log
            if query["table"] == "staff_roles" and query["update"] is not None
        ]
        self.assertEqual(len(updates), 2)
        self.assertEqual(set(updates[0]), {"archived_at"})
        self.assertEqual(updates[1], {"archived_at": None})
        self.assertEqual(len(supabase.tables["audit_logs"]), 2)
        for audit in supabase.tables["audit_logs"]:
            self.assertNotIn("Display user-1", str(audit["metadata"]))
            self.assertNotIn("legal_first_name", audit["metadata"])
            self.assertNotIn("legal_last_name", audit["metadata"])

    def test_archive_owner_and_last_active_admin_are_refused(self):
        owner_supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("owner-role", "owner-1", "admin")],
                "studios": [{"id": "studio-1", "owner_id": "owner-1"}],
                "audit_logs": [],
                "account_deletion_requests": [],
            },
            auth_users={"owner-1": auth_user("owner-1")},
        )
        with self.assertRaises(HTTPException) as owner_error:
            asyncio.run(StaffService(owner_supabase).archive_staff("owner-role", "studio-1", "admin-1"))
        self.assertEqual(owner_error.exception.status_code, 409)
        self.assertEqual(owner_error.exception.detail, STAFF_OWNER_ARCHIVE_CONFLICT_DETAIL)
        self.assertFalse(any(query["update"] for query in owner_supabase.query_log))

        admin_supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("admin-role", "admin-1", "admin")],
                "studios": [{"id": "studio-1", "owner_id": "owner-1"}],
                "audit_logs": [],
                "account_deletion_requests": [],
            },
            auth_users={"admin-1": auth_user("admin-1")},
        )
        with self.assertRaises(HTTPException) as admin_error:
            asyncio.run(StaffService(admin_supabase).archive_staff("admin-role", "studio-1", "actor-1"))
        self.assertEqual(admin_error.exception.status_code, 409)
        self.assertEqual(admin_error.exception.detail, STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL)
        admin_query = next(
            query for query in admin_supabase.query_log
            if query["table"] == "staff_roles" and query["columns"] == "user_id"
        )
        self.assertIn(("is", "archived_at", None), admin_query["filters"])

    def test_archived_admin_does_not_count_as_active_survivor(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [
                    staff_role("departing", "departing", "admin"),
                    staff_role("archived-survivor", "archived-survivor", "admin", archived_at=ARCHIVED_AT),
                ],
                "studios": [{"id": "studio-1", "owner_id": "owner-1"}],
                "account_deletion_requests": [],
            },
            auth_users={
                "departing": auth_user("departing"),
                "archived-survivor": auth_user("archived-survivor"),
            },
        )

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(StaffService(supabase).archive_staff("departing", "studio-1", "actor-1"))

        self.assertEqual(raised.exception.detail, STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL)

    def test_delete_revokes_unlinked_and_linked_pending_invitations_only(self):
        pending_supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("pending-role", None)],
                "audit_logs": [],
            }
        )
        asyncio.run(StaffService(pending_supabase).remove_staff("pending-role", "studio-1", "admin-1"))
        self.assertEqual(pending_supabase.tables["staff_roles"], [])
        delete_query = next(
            query for query in pending_supabase.query_log
            if query["table"] == "staff_roles" and query["delete"]
        )
        self.assertIn(("is", "user_id", None), delete_query["filters"])

        linked_pending_supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("linked-pending-role", "user-1")],
                "audit_logs": [],
            },
            auth_users={"user-1": auth_user("user-1", active=False)},
        )
        asyncio.run(
            StaffService(linked_pending_supabase).remove_staff(
                "linked-pending-role",
                "studio-1",
                "admin-1",
            )
        )
        self.assertEqual(linked_pending_supabase.tables["staff_roles"], [])
        linked_delete_query = next(
            query for query in linked_pending_supabase.query_log
            if query["table"] == "staff_roles" and query["delete"]
        )
        self.assertNotIn(("is", "user_id", None), linked_delete_query["filters"])
        self.assertIn(("is", "archived_at", None), linked_delete_query["filters"])

    def test_delete_rejects_active_archived_missing_and_failed_auth_rows(self):
        cases = (
            ("active", staff_role("active-role", "user-1"), {"user-1": auth_user("user-1")}),
            (
                "archived",
                staff_role("archived-role", "user-1", archived_at=ARCHIVED_AT),
                {"user-1": auth_user("user-1", active=False)},
            ),
            ("missing", staff_role("missing-role", "user-1"), {}),
        )

        for case_name, row, auth_users in cases:
            with self.subTest(case_name=case_name):
                supabase = ArchiveSupabase(
                    {"staff_roles": [row], "audit_logs": []},
                    auth_users=auth_users,
                )
                with self.assertRaises(HTTPException) as raised:
                    asyncio.run(
                        StaffService(supabase).remove_staff(
                            row["id"],
                            "studio-1",
                            "admin-1",
                        )
                    )
                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(raised.exception.detail, STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL)
                self.assertEqual(len(supabase.tables["staff_roles"]), 1)
                self.assertFalse(any(query["delete"] for query in supabase.query_log))

        failed_supabase = ArchiveSupabase(
            {"staff_roles": [staff_role("failed-role", "user-1")], "audit_logs": []},
        )
        failed_service = StaffService(failed_supabase)
        with patch.object(failed_service, "_get_auth_user", side_effect=RuntimeError("Auth unavailable")):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(failed_service.remove_staff("failed-role", "studio-1", "admin-1"))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL)
        self.assertEqual(len(failed_supabase.tables["staff_roles"]), 1)
        self.assertFalse(any(query["delete"] for query in failed_supabase.query_log))


class StaffDeletionSchedulingTest(unittest.TestCase):
    def _base_supabase(self, row, *, auth_users=None, studios=None):
        return ArchiveSupabase(
            {
                "staff_roles": [row],
                "account_deletion_requests": [],
                "audit_logs": [],
                "staff_profiles": [],
                "studios": studios or [{"id": "studio-1", "owner_id": "owner-1"}],
            },
            auth_users=auth_users or {
                "admin-1": auth_user("admin-1"),
                row.get("user_id"): auth_user(row["user_id"]),
            },
        )

    def test_endpoint_schedules_archived_staff_with_actor_fields_and_no_deletion_side_effect(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        supabase = self._base_supabase(row)
        test_app = FastAPI()
        test_app.include_router(staff_endpoint.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "admin-1"
        test_app.dependency_overrides[get_requested_studio_id] = lambda: "studio-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch(
            "app.api.v1.endpoints.staff._resolve_admin_studio_id",
            return_value="studio-1",
        ):
            response = TestClient(test_app).post(
                "/staff/archived-role/deletion-request",
                json={
                    "confirmation_name": "Display target-1",
                    "reason": "offboarding",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["user_id"], "target-1")
        self.assertEqual(body["studio_id"], "studio-1")
        self.assertEqual(body["requester_email"], "admin-1@example.com")
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)
        row = supabase.tables["account_deletion_requests"][0]
        self.assertEqual(row["requested_by"], "admin-1")
        self.assertEqual(row["metadata"], {"delay_days": 30})
        self.assertEqual(supabase.delete_calls, [])
        self.assertEqual(supabase.tables["staff_profiles"], [])

    def test_duplicate_endpoint_request_returns_same_row(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        supabase = self._base_supabase(row)
        test_app = FastAPI()
        test_app.include_router(staff_endpoint.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "admin-1"
        test_app.dependency_overrides[get_requested_studio_id] = lambda: "studio-1"
        test_app.dependency_overrides[get_supabase] = lambda: supabase

        with patch(
            "app.api.v1.endpoints.staff._resolve_admin_studio_id",
            return_value="studio-1",
        ):
            client = TestClient(test_app)
            first = client.post(
                "/staff/archived-role/deletion-request",
                json={"confirmation_name": "Display target-1"},
            )
            second = client.post(
                "/staff/archived-role/deletion-request",
                json={"confirmation_name": "Display target-1"},
            )

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)
        self.assertEqual(supabase.delete_calls, [])

    def test_non_archived_and_unlinked_targets_are_refused(self):
        active = self._base_supabase(staff_role("active-role", "target-1"))
        with self.assertRaises(HTTPException) as active_error:
            asyncio.run(StaffService(active).schedule_staff_deletion(
                "active-role",
                StaffDeletionRequestCreate(confirmation_name="Display target-1"),
                "studio-1",
                "admin-1",
            ))
        self.assertEqual(active_error.exception.status_code, 409)
        self.assertEqual(active_error.exception.detail, STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL)
        self.assertEqual(active.tables["account_deletion_requests"], [])

        unlinked = self._base_supabase(staff_role("invite-role", None))
        with self.assertRaises(HTTPException) as unlinked_error:
            asyncio.run(StaffService(unlinked).schedule_staff_deletion(
                "invite-role",
                StaffDeletionRequestCreate(confirmation_name="invite-role@example.com"),
                "studio-1",
                "admin-1",
            ))
        self.assertEqual(unlinked_error.exception.status_code, 409)
        self.assertEqual(unlinked_error.exception.detail, STAFF_DELETE_REQUIRES_LINKED_DETAIL)
        self.assertEqual(unlinked.tables["account_deletion_requests"], [])

    def test_confirmation_uses_email_when_display_and_legal_names_are_missing(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        target = SimpleNamespace(
            id="target-1",
            email="target@example.com",
            user_metadata={},
            confirmed_at="2026-08-15T00:00:00+00:00",
            email_confirmed_at="2026-08-15T00:00:00+00:00",
            last_sign_in_at=None,
        )
        supabase = self._base_supabase(
            row,
            auth_users={"admin-1": auth_user("admin-1"), "target-1": target},
        )

        request = asyncio.run(StaffService(supabase).schedule_staff_deletion(
            "archived-role",
            StaffDeletionRequestCreate(confirmation_name=" target@example.com "),
            "studio-1",
            "admin-1",
        ))

        self.assertEqual(request.user_id, "target-1")
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)

    def test_confirmation_uses_normalized_invitation_email_when_auth_email_is_blank(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        row["invited_email"] = " \n invite-target@example.com \t "
        target = SimpleNamespace(
            id="target-1",
            email=" \t ",
            user_metadata={},
            confirmed_at="2026-08-15T00:00:00+00:00",
            email_confirmed_at="2026-08-15T00:00:00+00:00",
            last_sign_in_at=None,
        )
        supabase = self._base_supabase(
            row,
            auth_users={"admin-1": auth_user("admin-1"), "target-1": target},
        )

        target_response = StaffService(supabase)._hydrate_staff_member(row, target)
        self.assertEqual(target_response.email, "invite-target@example.com")
        self.assertEqual(target_response.deletion_confirmation_name, "invite-target@example.com")

        request = asyncio.run(StaffService(supabase).schedule_staff_deletion(
            "archived-role",
            StaffDeletionRequestCreate(confirmation_name="invite-target@example.com"),
            "studio-1",
            "admin-1",
        ))

        self.assertEqual(request.user_id, "target-1")
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)

    def test_confirmation_uses_normalized_legacy_display_name(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        target = SimpleNamespace(
            id="target-1",
            email="target@example.com",
            user_metadata={"full_name": " \t ", "name": "  Legacy\t  Staff  "},
            confirmed_at="2026-08-15T00:00:00+00:00",
            email_confirmed_at="2026-08-15T00:00:00+00:00",
            last_sign_in_at=None,
        )
        supabase = self._base_supabase(
            row,
            auth_users={"admin-1": auth_user("admin-1"), "target-1": target},
        )

        target_response = StaffService(supabase)._hydrate_staff_member(row, target)
        self.assertEqual(target_response.full_name, "Legacy Staff")
        self.assertEqual(target_response.deletion_confirmation_name, "Legacy Staff")

        request = asyncio.run(StaffService(supabase).schedule_staff_deletion(
            "archived-role",
            StaffDeletionRequestCreate(confirmation_name="Legacy Staff"),
            "studio-1",
            "admin-1",
        ))

        self.assertEqual(request.user_id, "target-1")
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)

    def test_confirmation_uses_role_id_when_display_and_email_are_missing(self):
        row = staff_role("role-fallback", "target-1", archived_at=ARCHIVED_AT)
        row["invited_email"] = None
        target = SimpleNamespace(
            id="target-1",
            email=None,
            user_metadata={},
            confirmed_at="2026-08-15T00:00:00+00:00",
            email_confirmed_at="2026-08-15T00:00:00+00:00",
            last_sign_in_at=None,
        )
        supabase = self._base_supabase(
            row,
            auth_users={"admin-1": auth_user("admin-1"), "target-1": target},
        )

        target_response = StaffService(supabase)._hydrate_staff_member(row, target)
        self.assertEqual(target_response.deletion_confirmation_name, "staff role role-fallback")
        request = asyncio.run(StaffService(supabase).schedule_staff_deletion(
            "role-fallback",
            StaffDeletionRequestCreate(confirmation_name="staff role role-fallback"),
            "studio-1",
            "admin-1",
        ))

        self.assertEqual(request.user_id, "target-1")

    def test_confirmation_mismatch_is_stable_and_does_not_schedule(self):
        row = staff_role("archived-role", "target-1", archived_at=ARCHIVED_AT)
        supabase = self._base_supabase(row)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(StaffService(supabase).schedule_staff_deletion(
                "archived-role",
                StaffDeletionRequestCreate(confirmation_name="display target-1"),
                "studio-1",
                "admin-1",
            ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, STAFF_DELETE_CONFIRMATION_MISMATCH_DETAIL)
        self.assertEqual(supabase.tables["account_deletion_requests"], [])

    def test_owner_and_no_surviving_active_admin_are_refused(self):
        owner_row = staff_role("owner-role", "owner-1", "admin", archived_at=ARCHIVED_AT)
        owner_supabase = self._base_supabase(
            owner_row,
            auth_users={"admin-1": auth_user("admin-1"), "owner-1": auth_user("owner-1")},
            studios=[{"id": "studio-1", "owner_id": "owner-1"}],
        )
        with self.assertRaises(HTTPException) as owner_error:
            asyncio.run(StaffService(owner_supabase).schedule_staff_deletion(
                "owner-role",
                StaffDeletionRequestCreate(confirmation_name="Display owner-1"),
                "studio-1",
                "admin-1",
            ))
        self.assertEqual(owner_error.exception.status_code, 409)
        self.assertEqual(owner_supabase.tables["account_deletion_requests"], [])

        admin_row = staff_role("admin-role", "admin-target", "admin", archived_at=ARCHIVED_AT)
        no_survivor_supabase = self._base_supabase(
            admin_row,
            auth_users={
                "admin-1": auth_user("admin-1"),
                "admin-target": auth_user("admin-target"),
            },
            studios=[{"id": "studio-1", "owner_id": "owner-1"}],
        )
        with self.assertRaises(HTTPException) as survivor_error:
            asyncio.run(StaffService(no_survivor_supabase).schedule_staff_deletion(
                "admin-role",
                StaffDeletionRequestCreate(confirmation_name="Display admin-target"),
                "studio-1",
                "admin-1",
            ))
        self.assertEqual(survivor_error.exception.status_code, 409)
        self.assertEqual(no_survivor_supabase.tables["account_deletion_requests"], [])


class StaffArchiveMembershipTest(unittest.TestCase):
    def test_optional_resolver_rejects_archived_but_retains_active_same_studio_and_none(self):
        archived_supabase = ArchiveSupabase({
            "staff_roles": [staff_role("archived-role", "user-1", archived_at=ARCHIVED_AT)],
        })
        with self.assertRaises(HTTPException) as archived_error:
            resolve_optional_staff_role_for_user(archived_supabase, "user-1")
        self.assertEqual(archived_error.exception.status_code, 403)
        self.assertEqual(archived_error.exception.detail, STAFF_ARCHIVED_DETAIL)

        active_supabase = ArchiveSupabase({
            "staff_roles": [staff_role("active-role", "user-1")],
        })
        active_membership = resolve_optional_staff_role_for_user(
            active_supabase,
            "user-1",
            "studio-1",
        )
        self.assertEqual(active_membership["studio_id"], "studio-1")
        self.assertEqual(active_membership["role"], "instructor")

        no_membership_supabase = ArchiveSupabase({"staff_roles": []})
        self.assertIsNone(resolve_optional_staff_role_for_user(no_membership_supabase, "user-1"))

    def test_archived_membership_is_denied_but_remains_a_same_studio_reservation(self):
        supabase = ArchiveSupabase({
            "staff_roles": [staff_role("archived-role", "user-1", archived_at=ARCHIVED_AT)],
        })

        with self.assertRaises(HTTPException) as raised:
            resolve_staff_role_for_user(supabase, "user-1")
        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(raised.exception.detail, STAFF_ARCHIVED_DETAIL)

        with self.assertRaises(HTTPException) as assignment_denial:
            ensure_staff_user_in_studio(
                supabase,
                "user-1",
                "studio-1",
                "Staff assignment denied.",
            )
        self.assertEqual(assignment_denial.exception.status_code, 404)
        assignment_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_roles" and query["columns"] == "id"
        )
        self.assertIn(("is", "archived_at", None), assignment_query["filters"])

        StaffService(supabase)._ensure_single_studio_membership_candidate("user-1", "studio-1")
        with self.assertRaises(HTTPException):
            StaffService(supabase)._ensure_single_studio_membership_candidate("user-1", "studio-2")

    def test_owner_transfer_requires_an_active_admin_candidate(self):
        supabase = ArchiveSupabase(
            {
                "studios": [{"id": "studio-1", "owner_id": "owner-1"}],
                "staff_roles": [staff_role("archived-admin", "admin-2", "admin", archived_at=ARCHIVED_AT)],
            },
            auth_users={"admin-2": auth_user("admin-2")},
        )

        with self.assertRaises(HTTPException) as raised:
            StudioService(supabase)._validate_owner_transfer("studio-1", "owner-1", "admin-2")
        self.assertEqual(raised.exception.status_code, 409)
        staff_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        )
        self.assertIn(("is", "archived_at", None), staff_query["filters"])


class StaffArchiveAuthAndExportTest(unittest.TestCase):
    def test_auth_reports_archived_only_and_true_no_membership_states(self):
        archived_supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("archived-role", "user-1", archived_at=ARCHIVED_AT)],
                "staff_profiles": [],
            },
            auth_users={"user-1": auth_user("user-1")},
        )
        archived = asyncio.run(AuthService(archived_supabase).get_user_profile("user-1"))
        self.assertEqual(archived.membership_status, "archived")
        self.assertIsNone(archived.studio_id)
        self.assertIsNone(archived.role)

        with self.assertRaises(HTTPException) as requested_error:
            asyncio.run(
                AuthService(archived_supabase).get_user_profile("user-1", "studio-other")
            )
        self.assertEqual(requested_error.exception.status_code, 403)

        no_membership_supabase = ArchiveSupabase(
            {"staff_roles": [], "staff_profiles": []},
            auth_users={"user-1": auth_user("user-1")},
        )
        none = asyncio.run(AuthService(no_membership_supabase).get_user_profile("user-1"))
        self.assertEqual(none.membership_status, "none")
        self.assertIsNone(none.studio_id)
        self.assertIsNone(none.role)

    def test_dashboard_bootstrap_returns_archived_state_without_tenant_reads(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [staff_role("archived-role", "user-1", archived_at=ARCHIVED_AT)],
                "staff_profiles": [],
            },
            auth_users={"user-1": auth_user("user-1")},
        )

        with patch.object(
            DashboardBootstrapService,
            "_timed_fetch_with_isolated_client",
        ) as tenant_fetch:
            payload, _ = asyncio.run(
                DashboardBootstrapService(supabase).get_dashboard_bootstrap("user-1")
            )

        tenant_fetch.assert_not_called()
        self.assertEqual(payload.auth.membership_status, "archived")
        self.assertIsNone(payload.auth.studio_id)
        self.assertIsNone(payload.auth.role)

    def test_default_staff_export_excludes_archived_rows(self):
        supabase = ArchiveSupabase(
            {
                "staff_roles": [
                    staff_role("active-role", "active-user"),
                    staff_role("archived-role", "archived-user", archived_at=ARCHIVED_AT),
                ],
                "staff_profiles": [],
            },
            auth_users={
                "active-user": auth_user("active-user"),
                "archived-user": auth_user("archived-user"),
            },
        )

        csv_text, _ = asyncio.run(
            ReportExportService(supabase).build_csv("staff_roles", "studio-1")
        )
        rows = list(csv.DictReader(StringIO(csv_text)))

        self.assertEqual([row["id"] for row in rows], ["active-role"])
        role_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        )
        self.assertIn(("is", "archived_at", None), role_query["filters"])


if __name__ == "__main__":
    unittest.main()
