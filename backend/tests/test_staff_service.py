import asyncio
import unittest
from types import SimpleNamespace

from fastapi import HTTPException
from gotrue.errors import AuthApiError
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.staff import StaffInviteCreate
from app.services.staff_service import StaffService
from tests.fakes.supabase import TableBackedSupabase


def conflict_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


def postgrest_error(code: str = "PGRST000") -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": code,
        "message": "postgrest failure",
        "details": "",
        "hint": "",
    })


class FakeAuthAdmin:
    def __init__(self, supabase: "FakeSupabase"):
        self.supabase = supabase

    def invite_user_by_email(self, email, options):
        self.supabase.operations.append(("auth_invite", email, options))
        if self.supabase.invite_exception is not None:
            raise self.supabase.invite_exception
        return SimpleNamespace(user=SimpleNamespace(
            id=self.supabase.invited_user_id,
            email=email,
            user_metadata={},
            email_confirmed_at=None,
            confirmed_at=None,
            last_sign_in_at=None,
        ))

    def get_user_by_id(self, user_id):
        self.supabase.operations.append(("auth_get_user", user_id))
        user = self.supabase.auth_users.get(user_id)
        return SimpleNamespace(user=user)


class FakeAuth:
    def __init__(self, supabase: "FakeSupabase"):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase(TableBackedSupabase):
    def __init__(self):
        super().__init__({"staff_roles": [], "audit_logs": []})
        self.operations = []
        self.invited_user_id = "user_invited"
        self.invite_exception = None
        self.fail_pending_insert_conflict = False
        self.fail_link_conflict = False
        self.link_exceptions = []
        self.empty_link_attempts = 0
        self.auth_users = {}
        self.auth = FakeAuth(self)
        self.insert_defaults["staff_roles"] = self._timestamp_defaults
        self.insert_defaults["audit_logs"] = self._timestamp_defaults
        self.before_insert = self._before_insert
        self.on_update_query = self._on_update_query
        self.on_delete_query = self._on_delete_query

    def _timestamp_defaults(self, _table_name: str) -> dict:
        return {
            "created_at": "2026-05-24T12:00:00+00:00",
            "updated_at": "2026-05-24T12:00:00+00:00",
        }

    def _before_insert(self, table_name: str, payloads: list[dict], _rows: list[dict]) -> None:
        for payload in payloads:
            self.operations.append(("insert", table_name, dict(payload)))
        if table_name == "staff_roles" and self.fail_pending_insert_conflict:
            raise conflict_error()

    def _on_update_query(self, query, rows: list[dict]):
        self.operations.append(("update", query.name, dict(query.update_payload), list(query.filters)))
        if query.name == "staff_roles" and self.empty_link_attempts > 0:
            self.empty_link_attempts -= 1
            matched = query._matched_rows(rows)
            self.tables[query.name] = [row for row in rows if row not in matched]
            return []
        if query.name == "staff_roles" and self.fail_link_conflict:
            raise conflict_error()
        if query.name == "staff_roles" and self.link_exceptions:
            raise self.link_exceptions.pop(0)
        return None

    def _on_delete_query(self, query, _rows: list[dict]):
        self.operations.append(("delete", query.name, list(query.filters)))
        return None


class StaffServiceInviteTest(unittest.TestCase):
    def test_invite_reserves_staff_role_before_auth_invite_then_links_user(self):
        supabase = FakeSupabase()
        service = StaffService(supabase)

        response = asyncio.run(
            service.invite_staff(
                StaffInviteCreate(email="Instructor@Example.com", role="instructor"),
                "studio_1",
                "admin_1",
            )
        )

        operation_names = [operation[0] for operation in supabase.operations]
        self.assertLess(operation_names.index("insert"), operation_names.index("auth_invite"))
        self.assertLess(operation_names.index("auth_invite"), operation_names.index("update"))
        self.assertEqual(supabase.tables["staff_roles"][0]["user_id"], "user_invited")
        self.assertEqual(supabase.tables["staff_roles"][0]["invited_email"], "instructor@example.com")
        self.assertEqual(response.user_id, "user_invited")
        self.assertEqual(response.status, "pending")

    def test_invite_failure_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.invite_exception = AuthApiError("already exists", 409, "email_exists")
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "delete"],
        )

    def test_non_auth_invite_failure_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.invite_exception = RuntimeError("network timeout")
        service = StaffService(supabase)

        with self.assertRaises(RuntimeError):
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "delete"],
        )

    def test_pending_invite_conflict_does_not_send_auth_invite(self):
        supabase = FakeSupabase()
        supabase.fail_pending_insert_conflict = True
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertNotIn("auth_invite", [operation[0] for operation in supabase.operations])

    def test_link_conflict_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.fail_link_conflict = True
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "update", "delete"],
        )

    def test_non_conflict_link_failure_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.link_exceptions = [postgrest_error()]
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError):
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "update", "delete"],
        )

    def test_empty_link_update_recreates_pending_role_and_retries(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        service = StaffService(supabase)

        response = asyncio.run(
            service.invite_staff(
                StaffInviteCreate(email="instructor@example.com", role="instructor"),
                "studio_1",
                "admin_1",
            )
        )

        self.assertEqual(response.user_id, "user_invited")
        self.assertEqual(len(supabase.tables["staff_roles"]), 1)
        self.assertEqual(supabase.tables["staff_roles"][0]["user_id"], "user_invited")
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "update", "insert", "update", "insert"],
        )

    def test_recovered_link_failure_removes_recovered_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        supabase.link_exceptions = [postgrest_error()]
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError):
            asyncio.run(
                service.invite_staff(
                    StaffInviteCreate(email="instructor@example.com", role="instructor"),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "update", "insert", "update", "delete"],
        )

    def test_hydrates_pending_staff_role_without_user_id(self):
        service = StaffService(FakeSupabase())

        response = service._hydrate_staff_member({
            "id": "role_1",
            "studio_id": "studio_1",
            "user_id": None,
            "role": "front_desk",
            "invited_email": "desk@example.com",
            "invited_by": "admin_1",
            "created_at": "2026-05-24T12:00:00+00:00",
            "updated_at": "2026-05-24T12:00:00+00:00",
        })

        self.assertIsNone(response.user_id)
        self.assertEqual(response.email, "desk@example.com")
        self.assertEqual(response.status, "pending")


if __name__ == "__main__":
    unittest.main()
