import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from gotrue.errors import AuthApiError
from postgrest.exceptions import APIError as PostgrestAPIError

from app.core.config import KOARYU_PRODUCTION_FRONTEND_URL, Settings
from app.schemas.staff import StaffInviteCreate
from app.services.staff_service import SINGLE_STUDIO_MEMBERSHIP_DETAIL, StaffService
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


def invite_data(
    email: str = "instructor@example.com",
    role: str = "instructor",
    full_name: str = "Display Instructor",
    legal_first_name: str = "Legal",
    legal_last_name: str = "Instructor",
) -> StaffInviteCreate:
    return StaffInviteCreate(
        email=email,
        role=role,
        full_name=full_name,
        legal_first_name=legal_first_name,
        legal_last_name=legal_last_name,
    )


class FakeAuthAdmin:
    def __init__(self, supabase: "FakeSupabase"):
        self.supabase = supabase

    def invite_user_by_email(self, email, options):
        self.supabase.operations.append(("auth_invite", email, options))
        if self.supabase.invite_exception is not None:
            raise self.supabase.invite_exception
        user = SimpleNamespace(
            id=self.supabase.invited_user_id,
            email=email,
            user_metadata=options["data"].copy(),
            email_confirmed_at=None,
            confirmed_at=None,
            last_sign_in_at=None,
        )
        self.supabase.auth_users[user.id] = user
        return SimpleNamespace(user=user)

    def get_user_by_id(self, user_id):
        self.supabase.operations.append(("auth_get_user", user_id))
        user = self.supabase.auth_users.get(user_id)
        return SimpleNamespace(user=user)

    def delete_user(self, user_id):
        self.supabase.operations.append(("auth_delete", user_id))
        if self.supabase.fail_auth_delete:
            raise postgrest_error()
        self.supabase.auth_users.pop(user_id, None)
        self.supabase.tables["staff_profiles"] = [
            row for row in self.supabase.tables["staff_profiles"]
            if row.get("user_id") != user_id
        ]


class FakeAuth:
    def __init__(self, supabase: "FakeSupabase"):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase(TableBackedSupabase):
    def __init__(self):
        super().__init__({
            "staff_roles": [],
            "staff_profiles": [{
                "user_id": "admin_1",
                "legal_first_name": "Admin",
                "legal_last_name": "Actor",
            }],
            "audit_logs": [],
        })
        self.operations = []
        self.next_staff_role_id = 1
        self.invited_user_id = "user_invited"
        self.invite_exception = None
        self.fail_pending_insert_conflict = False
        self.staff_role_insert_failures = []
        self.profile_insert_exception = None
        self.fail_profile_delete = False
        self.fail_audit_insert = False
        self.fail_auth_delete = False
        self.fail_link_conflict = False
        self.link_exceptions = []
        self.empty_link_attempts = 0
        self.fail_delete_pending = False
        self.auth_users = {
            "admin_1": SimpleNamespace(
                id="admin_1",
                email="admin@example.com",
                user_metadata={"full_name": "Admin Display"},
                email_confirmed_at="2026-05-01T00:00:00+00:00",
                confirmed_at="2026-05-01T00:00:00+00:00",
                last_sign_in_at=None,
            ),
        }
        self.unique_constraints["staff_profiles"] = [("user_id",)]
        self.unique_conflict_error_factory = lambda _table, _columns: conflict_error()
        self.auth = FakeAuth(self)
        self.insert_defaults["staff_roles"] = self._timestamp_defaults
        self.insert_defaults["staff_profiles"] = self._timestamp_defaults
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
            if table_name == "staff_roles":
                payload["id"] = f"invite-role-{self.next_staff_role_id}"
                self.next_staff_role_id += 1
            if table_name == "audit_logs":
                actor_profile = next(
                    (
                        row for row in self.tables["staff_profiles"]
                        if row.get("user_id") == payload.get("actor_id")
                    ),
                    None,
                )
                payload["actor_legal_name"] = (
                    f"{actor_profile['legal_first_name']} {actor_profile['legal_last_name']}"
                    if actor_profile else None
                )
            self.operations.append(("insert", table_name, dict(payload)))
        if table_name == "staff_roles" and self.fail_pending_insert_conflict:
            raise conflict_error()
        if table_name == "staff_roles" and self.staff_role_insert_failures:
            failure = self.staff_role_insert_failures.pop(0)
            if failure is not None:
                raise failure
        if table_name == "staff_profiles" and self.profile_insert_exception is not None:
            raise self.profile_insert_exception
        if table_name == "audit_logs" and self.fail_audit_insert:
            raise postgrest_error("AUDIT_FAILURE")

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
        if query.name == "staff_roles" and self.fail_delete_pending:
            raise postgrest_error()
        if query.name == "staff_profiles" and self.fail_profile_delete:
            raise postgrest_error()
        return None


class StaffServiceInviteTest(unittest.TestCase):
    def test_invite_reserves_staff_role_before_auth_invite_then_links_user(self):
        supabase = FakeSupabase()
        service = StaffService(supabase)

        with patch(
            "app.services.staff_service.get_settings",
            return_value=Settings(
                ENVIRONMENT="production",
                FRONTEND_URL=KOARYU_PRODUCTION_FRONTEND_URL,
            ),
        ):
            response = asyncio.run(
                service.invite_staff(
                    invite_data(email="Instructor@Example.com"),
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
        self.assertEqual(response.full_name, "Display Instructor")
        self.assertEqual(response.legal_first_name, "Legal")
        self.assertEqual(response.legal_last_name, "Instructor")
        self.assertEqual(
            [(operation[0], operation[1]) for operation in supabase.operations],
            [
                ("insert", "staff_roles"),
                ("auth_invite", "instructor@example.com"),
                ("insert", "staff_profiles"),
                ("update", "staff_roles"),
                ("insert", "audit_logs"),
            ],
        )
        self.assertIn(
            (
                "auth_invite",
                "instructor@example.com",
                {
                    "redirect_to": "https://koaryu.app/auth/callback",
                    "data": {"full_name": "Display Instructor"},
                },
            ),
            supabase.operations,
        )
        self.assertEqual(supabase.auth_users["user_invited"].user_metadata, {
            "full_name": "Display Instructor",
        })
        self.assertEqual(
            supabase.operations[2],
            (
                "insert",
                "staff_profiles",
                {
                    "user_id": "user_invited",
                    "legal_first_name": "Legal",
                    "legal_last_name": "Instructor",
                },
            ),
        )
        self.assertEqual(supabase.operations[3][2], {"user_id": "user_invited"})
        self.assertEqual(
            supabase.operations[3][3],
            [("eq", "id", "invite-role-1"), ("eq", "studio_id", "studio_1")],
        )
        self.assertNotIn("legal_first_name", supabase.operations[4][2]["metadata"])
        self.assertNotIn("legal_last_name", supabase.operations[4][2]["metadata"])
        self.assertEqual(supabase.tables["audit_logs"][0]["actor_legal_name"], "Admin Actor")

    def test_invalid_frontend_origin_fails_before_invite_side_effects(self):
        supabase = FakeSupabase()
        service = StaffService(supabase)
        settings = Settings(
            ENVIRONMENT="production",
            FRONTEND_URL="https://koaryu.app@evil.example",
        )

        with (
            patch("app.services.staff_service.get_settings", return_value=settings),
            self.assertRaisesRegex(RuntimeError, "FRONTEND_URL"),
        ):
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.operations, [])

    def test_invite_link_rejects_existing_membership_in_another_studio_and_cleans_up(self):
        supabase = FakeSupabase()
        supabase.tables["staff_roles"].append({
            "id": "existing-role",
            "studio_id": "studio_existing",
            "user_id": "user_invited",
            "role": "instructor",
            "created_at": "2026-07-12T12:00:00+00:00",
        })
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.invite_staff(
                invite_data(),
                "studio_new",
                "admin_1",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(context.exception.detail, SINGLE_STUDIO_MEMBERSHIP_DETAIL)
        self.assertEqual(len(supabase.tables["staff_roles"]), 1)
        self.assertEqual(supabase.tables["staff_roles"][0]["id"], "existing-role")
        self.assertIn(("auth_delete", "user_invited"), supabase.operations)

    def test_invite_failure_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.invite_exception = AuthApiError("already exists", 409, "email_exists")
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)
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
                    invite_data(),
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
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertNotIn("auth_invite", [operation[0] for operation in supabase.operations])

    def test_profile_insert_failure_removes_role_profile_and_auth_user(self):
        supabase = FakeSupabase()
        failure = postgrest_error("PROFILE_FAILURE")
        supabase.profile_insert_exception = failure
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertIs(raised.exception, failure)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)
        self.assertEqual(
            [(operation[0], operation[1]) for operation in supabase.operations],
            [
                ("insert", "staff_roles"),
                ("auth_invite", "instructor@example.com"),
                ("insert", "staff_profiles"),
                ("delete", "staff_roles"),
                ("delete", "staff_profiles"),
                ("auth_delete", "user_invited"),
            ],
        )

    def test_link_conflict_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.fail_link_conflict = True
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            [
                "insert",
                "auth_invite",
                "insert",
                "update",
                "delete",
                "delete",
                "auth_delete",
            ],
        )

    def test_non_conflict_link_failure_removes_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.link_exceptions = [postgrest_error()]
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError):
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            [
                "insert",
                "auth_invite",
                "insert",
                "update",
                "delete",
                "delete",
                "auth_delete",
            ],
        )

    def test_link_failure_still_deletes_auth_user_when_pending_role_cleanup_fails(self):
        supabase = FakeSupabase()
        supabase.link_exceptions = [postgrest_error()]
        supabase.fail_delete_pending = True
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError):
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            [
                "insert",
                "auth_invite",
                "insert",
                "update",
                "delete",
                "delete",
                "auth_delete",
            ],
        )
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_empty_link_update_recreates_pending_role_and_retries(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        service = StaffService(supabase)

        response = asyncio.run(
            service.invite_staff(
                invite_data(),
                "studio_1",
                "admin_1",
            )
        )

        self.assertEqual(response.user_id, "user_invited")
        self.assertEqual(len(supabase.tables["staff_roles"]), 1)
        self.assertEqual(supabase.tables["staff_roles"][0]["user_id"], "user_invited")
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            ["insert", "auth_invite", "insert", "update", "insert", "update", "insert"],
        )

    def test_recovered_role_insert_failure_removes_profile_and_auth_user(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        failure = postgrest_error("RECOVERED_INSERT_FAILURE")
        supabase.staff_role_insert_failures = [None, failure]
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertIs(raised.exception, failure)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_empty_final_link_cleans_recovered_role_profile_and_auth_user(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 2
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_recovered_link_failure_removes_recovered_pending_staff_role(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        supabase.link_exceptions = [postgrest_error()]
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError):
            asyncio.run(
                service.invite_staff(
                    invite_data(),
                    "studio_1",
                    "admin_1",
                )
            )

        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [operation[0] for operation in supabase.operations],
            [
                "insert",
                "auth_invite",
                "insert",
                "update",
                "insert",
                "update",
                "delete",
                "delete",
                "delete",
                "auth_delete",
            ],
        )

    def test_recovered_link_conflict_maps_and_cleans_recovered_resources(self):
        supabase = FakeSupabase()
        supabase.empty_link_attempts = 1
        supabase.fail_link_conflict = True
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_audit_failure_removes_linked_role_profile_and_auth_user(self):
        supabase = FakeSupabase()
        supabase.fail_audit_insert = True
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertEqual(raised.exception.code, "AUDIT_FAILURE")
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_role_cleanup_failure_still_deletes_profile_and_auth_user(self):
        supabase = FakeSupabase()
        supabase.link_exceptions = [postgrest_error("LINK_FAILURE")]
        supabase.fail_delete_pending = True
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertEqual(raised.exception.code, "LINK_FAILURE")
        self.assertEqual(len(supabase.tables["staff_roles"]), 1)
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_profile_cleanup_failure_still_deletes_role_and_auth_user_via_cascade(self):
        supabase = FakeSupabase()
        supabase.link_exceptions = [postgrest_error("LINK_FAILURE")]
        supabase.fail_profile_delete = True
        service = StaffService(supabase)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))

        self.assertEqual(raised.exception.code, "LINK_FAILURE")
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(
            [row for row in supabase.tables["staff_profiles"] if row["user_id"] == "user_invited"],
            [],
        )
        self.assertNotIn("user_invited", supabase.auth_users)

    def test_cleanup_is_idempotent_and_does_not_delete_unrelated_rows(self):
        supabase = FakeSupabase()
        supabase.tables["staff_roles"].extend([
            {
                "id": "invite-role",
                "studio_id": "studio_1",
                "user_id": "user_invited",
                "role": "instructor",
            },
            {
                "id": "unrelated-role",
                "studio_id": "studio_other",
                "user_id": "unrelated-user",
                "role": "instructor",
            },
        ])
        supabase.tables["staff_profiles"].append({
            "user_id": "user_invited",
            "legal_first_name": "Legal",
            "legal_last_name": "Instructor",
        })
        supabase.tables["staff_profiles"].append({
            "user_id": "unrelated-user",
            "legal_first_name": "Other",
            "legal_last_name": "User",
        })
        supabase.auth_users["user_invited"] = SimpleNamespace(
            id="user_invited",
            email="instructor@example.com",
            user_metadata={"full_name": "Display Instructor"},
            email_confirmed_at=None,
            confirmed_at=None,
            last_sign_in_at=None,
        )
        supabase.auth_users["unrelated-user"] = SimpleNamespace(
            id="unrelated-user",
            email="unrelated@example.com",
            user_metadata={"full_name": "Other User"},
            email_confirmed_at=None,
            confirmed_at=None,
            last_sign_in_at=None,
        )
        service = StaffService(supabase)

        service._cleanup_failed_invite_resources(["invite-role"], "studio_1", "user_invited")
        service._cleanup_failed_invite_resources(["invite-role"], "studio_1", "user_invited")

        self.assertEqual(supabase.tables["staff_roles"], [{
            "id": "unrelated-role",
            "studio_id": "studio_other",
            "user_id": "unrelated-user",
            "role": "instructor",
        }])
        self.assertEqual(
            supabase.tables["staff_profiles"],
            [
                {
                    "user_id": "admin_1",
                    "legal_first_name": "Admin",
                    "legal_last_name": "Actor",
                },
                {
                    "user_id": "unrelated-user",
                    "legal_first_name": "Other",
                    "legal_last_name": "User",
                },
            ],
        )
        self.assertNotIn("user_invited", supabase.auth_users)
        self.assertIn("unrelated-user", supabase.auth_users)
        role_delete_filters = [
            operation[2]
            for operation in supabase.operations
            if operation[0:2] == ("delete", "staff_roles")
        ]
        self.assertEqual(
            role_delete_filters,
            [
                [("eq", "id", "invite-role"), ("eq", "studio_id", "studio_1")],
                [("eq", "id", "invite-role"), ("eq", "studio_id", "studio_1")],
            ],
        )

    def test_audit_actor_name_survives_actor_profile_and_auth_deletion(self):
        supabase = FakeSupabase()
        service = StaffService(supabase)

        asyncio.run(service.invite_staff(invite_data(), "studio_1", "admin_1"))
        audit_before_cleanup = dict(supabase.tables["audit_logs"][0])

        service._delete_invited_staff_profile("admin_1")
        service._delete_invited_auth_user("admin_1")

        self.assertFalse(any(
            row["user_id"] == "admin_1"
            for row in supabase.tables["staff_profiles"]
        ))
        self.assertNotIn("admin_1", supabase.auth_users)
        self.assertEqual(supabase.tables["audit_logs"][0], audit_before_cleanup)
        self.assertEqual(supabase.tables["audit_logs"][0]["actor_legal_name"], "Admin Actor")

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


class StaffServiceListTest(unittest.TestCase):
    @staticmethod
    def _user(user_id: str, full_name: str, *, active: bool = False):
        timestamp = "2026-08-15T00:00:00+00:00" if active else None
        return SimpleNamespace(
            id=user_id,
            email=f"{user_id}@example.com",
            user_metadata={"full_name": full_name},
            email_confirmed_at=timestamp,
            confirmed_at=timestamp,
            last_sign_in_at=None,
        )

    def test_list_staff_attaches_one_bounded_profile_read_and_nulls_missing_names(self):
        supabase = FakeSupabase()
        supabase.auth_users.update({
            "user-1": self._user("user-1", "Aiko Display", active=True),
            "user-2": self._user("user-2", "Missing Profile"),
        })
        supabase.tables["staff_roles"] = [
            {
                "id": "role-1",
                "studio_id": "studio_1",
                "user_id": "user-1",
                "role": "instructor",
                "created_at": "2026-08-15T00:00:00+00:00",
            },
            {
                "id": "role-2",
                "studio_id": "studio_1",
                "user_id": "user-2",
                "role": "front_desk",
                "created_at": "2026-08-15T00:01:00+00:00",
            },
            {
                "id": "role-pending",
                "studio_id": "studio_1",
                "user_id": None,
                "role": "instructor",
                "invited_email": "pending@example.com",
                "created_at": "2026-08-15T00:02:00+00:00",
            },
        ]
        supabase.tables["staff_profiles"].append({
            "user_id": "user-1",
            "legal_first_name": "Aiko",
            "legal_last_name": "Tanaka",
        })

        response = asyncio.run(StaffService(supabase).list_staff("studio_1"))

        self.assertEqual(response[0].full_name, "Aiko Display")
        self.assertEqual(response[0].legal_first_name, "Aiko")
        self.assertEqual(response[0].legal_last_name, "Tanaka")
        self.assertEqual(response[1].full_name, "Missing Profile")
        self.assertIsNone(response[1].legal_first_name)
        self.assertIsNone(response[1].legal_last_name)
        self.assertIsNone(response[2].user_id)
        self.assertIsNone(response[2].legal_first_name)
        self.assertIsNone(response[2].legal_last_name)

        profile_queries = [
            query for query in supabase.query_log
            if query["table"] == "staff_profiles"
        ]
        self.assertEqual(len(profile_queries), 1)
        self.assertEqual(
            profile_queries[0]["filters"],
            (("in", "user_id", {"user-1", "user-2"}),),
        )

    def test_pending_only_roster_never_reads_profiles(self):
        supabase = FakeSupabase()
        supabase.tables["staff_roles"] = [{
            "id": "role-pending",
            "studio_id": "studio_1",
            "user_id": None,
            "role": "instructor",
            "invited_email": "pending@example.com",
            "created_at": "2026-08-15T00:00:00+00:00",
        }]
        supabase.table_failures["staff_profiles"] = postgrest_error("UNRELATED_FAILURE")

        response = asyncio.run(StaffService(supabase).list_staff("studio_1"))

        self.assertEqual(len(response), 1)
        self.assertIsNone(response[0].legal_first_name)
        self.assertNotIn("staff_profiles", [query["table"] for query in supabase.query_log])

    def test_missing_profile_schema_codes_degrade_to_display_only(self):
        for code in ("42P01", "42703", "PGRST204", "PGRST205"):
            with self.subTest(code=code):
                supabase = FakeSupabase()
                supabase.auth_users["user-1"] = self._user("user-1", "Display Name")
                supabase.tables["staff_roles"] = [{
                    "id": "role-1",
                    "studio_id": "studio_1",
                    "user_id": "user-1",
                    "role": "instructor",
                    "created_at": "2026-08-15T00:00:00+00:00",
                }]
                supabase.table_failures["staff_profiles"] = postgrest_error(code)

                response = asyncio.run(StaffService(supabase).list_staff("studio_1"))

                self.assertEqual(response[0].full_name, "Display Name")
                self.assertIsNone(response[0].legal_first_name)
                self.assertIsNone(response[0].legal_last_name)

    def test_unrelated_profile_read_error_propagates(self):
        supabase = FakeSupabase()
        supabase.auth_users["user-1"] = self._user("user-1", "Display Name")
        supabase.tables["staff_roles"] = [{
            "id": "role-1",
            "studio_id": "studio_1",
            "user_id": "user-1",
            "role": "instructor",
            "created_at": "2026-08-15T00:00:00+00:00",
        }]
        failure = postgrest_error("PGRST000")
        supabase.table_failures["staff_profiles"] = failure

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(StaffService(supabase).list_staff("studio_1"))

        self.assertIs(raised.exception, failure)


if __name__ == "__main__":
    unittest.main()
