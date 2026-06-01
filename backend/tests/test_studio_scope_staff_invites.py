import unittest
from types import SimpleNamespace

from fastapi import HTTPException

from app.services.studio_scope import resolve_optional_staff_role_for_user, resolve_staff_role_for_user
from tests.fakes.supabase import TableBackedSupabase


class FakeAuthAdmin:
    def __init__(self, supabase: "FakeSupabase"):
        self.supabase = supabase

    def get_user_by_id(self, user_id):
        self.supabase.operations.append(("auth_get_user", user_id))
        return SimpleNamespace(user=SimpleNamespace(
            id=user_id,
            email=self.supabase.user_emails.get(user_id),
        ))


class FakeAuth:
    def __init__(self, supabase: "FakeSupabase"):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase(TableBackedSupabase):
    def __init__(self, staff_roles):
        super().__init__({"staff_roles": staff_roles})
        self.user_emails = {"user_1": "Invited@Example.com"}
        self.operations = []
        self.auth = FakeAuth(self)


class StudioScopePendingStaffInviteTest(unittest.TestCase):
    def test_resolve_claims_pending_staff_invite_by_auth_email(self):
        supabase = FakeSupabase([
            {
                "id": "role_pending",
                "studio_id": "studio_1",
                "user_id": None,
                "role": "instructor",
                "invited_email": "invited@example.com",
                "created_at": "2026-05-24T12:00:00+00:00",
            },
        ])

        role = resolve_staff_role_for_user(supabase, "user_1")

        self.assertEqual(role["studio_id"], "studio_1")
        self.assertEqual(role["role"], "instructor")
        self.assertEqual(supabase.tables["staff_roles"][0]["user_id"], "user_1")
        self.assertIn(("auth_get_user", "user_1"), supabase.operations)

    def test_requested_studio_claims_pending_invite_when_user_has_other_memberships(self):
        supabase = FakeSupabase([
            {
                "id": "role_existing",
                "studio_id": "studio_existing",
                "user_id": "user_1",
                "role": "front_desk",
                "invited_email": "other@example.com",
                "created_at": "2026-05-23T12:00:00+00:00",
            },
            {
                "id": "role_pending",
                "studio_id": "studio_requested",
                "user_id": None,
                "role": "admin",
                "invited_email": "invited@example.com",
                "created_at": "2026-05-24T12:00:00+00:00",
            },
        ])

        role = resolve_staff_role_for_user(supabase, "user_1", "studio_requested")

        self.assertEqual(role["studio_id"], "studio_requested")
        self.assertEqual(role["role"], "admin")
        self.assertEqual(supabase.tables["staff_roles"][1]["user_id"], "user_1")

    def test_requested_studio_must_match_membership_or_claimed_invite(self):
        supabase = FakeSupabase([
            {
                "id": "role_existing",
                "studio_id": "studio_existing",
                "user_id": "user_1",
                "role": "front_desk",
                "invited_email": "other@example.com",
                "created_at": "2026-05-23T12:00:00+00:00",
            },
            {
                "id": "role_pending_other_email",
                "studio_id": "studio_requested",
                "user_id": None,
                "role": "admin",
                "invited_email": "someone-else@example.com",
                "created_at": "2026-05-24T12:00:00+00:00",
            },
        ])

        with self.assertRaises(HTTPException) as context:
            resolve_staff_role_for_user(supabase, "user_1", "studio_requested")

        self.assertEqual(context.exception.status_code, 403)
        self.assertIsNone(supabase.tables["staff_roles"][1]["user_id"])

    def test_email_wildcard_characters_do_not_pattern_match_other_invites(self):
        supabase = FakeSupabase([
            {
                "id": "role_pending",
                "studio_id": "studio_1",
                "user_id": None,
                "role": "instructor",
                "invited_email": "axb@example.com",
                "created_at": "2026-05-24T12:00:00+00:00",
            },
        ])
        supabase.user_emails["user_1"] = "a_b@example.com"

        with self.assertRaises(HTTPException) as context:
            resolve_staff_role_for_user(supabase, "user_1")

        self.assertEqual(context.exception.status_code, 404)
        self.assertIsNone(supabase.tables["staff_roles"][0]["user_id"])

    def test_optional_resolver_preserves_no_studio_onboarding_profile(self):
        supabase = FakeSupabase([])

        role = resolve_optional_staff_role_for_user(supabase, "user_1")

        self.assertIsNone(role)

    def test_optional_resolver_rejects_unclaimed_requested_studio(self):
        supabase = FakeSupabase([
            {
                "id": "role_existing",
                "studio_id": "studio_existing",
                "user_id": "user_1",
                "role": "front_desk",
                "invited_email": "other@example.com",
                "created_at": "2026-05-23T12:00:00+00:00",
            },
        ])

        with self.assertRaises(HTTPException) as context:
            resolve_optional_staff_role_for_user(supabase, "user_1", "studio_requested")

        self.assertEqual(context.exception.status_code, 403)

    def test_optional_resolver_claims_requested_invite_with_supplied_email(self):
        supabase = FakeSupabase([
            {
                "id": "role_pending",
                "studio_id": "studio_requested",
                "user_id": None,
                "role": "admin",
                "invited_email": "profile@example.com",
                "created_at": "2026-05-24T12:00:00+00:00",
            },
        ])

        role = resolve_optional_staff_role_for_user(
            supabase,
            "user_1",
            "studio_requested",
            user_email="Profile@Example.com",
        )

        self.assertEqual(role["studio_id"], "studio_requested")
        self.assertEqual(role["role"], "admin")
        self.assertEqual(supabase.tables["staff_roles"][0]["user_id"], "user_1")
        self.assertNotIn(("auth_get_user", "user_1"), supabase.operations)


if __name__ == "__main__":
    unittest.main()
