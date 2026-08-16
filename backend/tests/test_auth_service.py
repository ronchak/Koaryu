import asyncio
import unittest
from types import SimpleNamespace

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.auth_service import AuthService
from tests.fakes.supabase import TableBackedSupabase


class FakeAuthSupabase(TableBackedSupabase):
    def __init__(
        self,
        *,
        profile_rows=None,
        staff_roles=None,
        profile_failure=None,
        user_metadata=None,
    ):
        super().__init__({
            "staff_profiles": profile_rows or [],
            "staff_roles": staff_roles or [],
        })
        self.auth_user_id = None
        self.auth_user = SimpleNamespace(
            id="user-1",
            email="owner@example.com",
            user_metadata=user_metadata if user_metadata is not None else {},
        )
        self.auth = SimpleNamespace(
            admin=SimpleNamespace(get_user_by_id=self._get_user_by_id),
        )
        if profile_failure is not None:
            self.table_failures["staff_profiles"] = profile_failure

    def _get_user_by_id(self, user_id):
        self.auth_user_id = user_id
        return SimpleNamespace(user=self.auth_user)


class AuthServiceTest(unittest.TestCase):
    def test_existing_profile_returns_names_display_metadata_and_requested_membership(self):
        supabase = FakeAuthSupabase(
            profile_rows=[{
                "user_id": "user-1",
                "legal_first_name": "Aiko",
                "legal_last_name": "Tanaka",
            }],
            staff_roles=[{
                "user_id": "user-1",
                "studio_id": "studio-1",
                "role": "admin",
                "created_at": "2026-08-15T00:00:00Z",
            }],
            user_metadata={
                "full_name": "Aiko T.",
                "legal_first_name": "MetadataFirst",
                "legal_last_name": "MetadataLast",
            },
        )

        auth = asyncio.run(
            AuthService(supabase).get_user_profile("user-1", "studio-1")
        )

        self.assertTrue(auth.staff_profiles_available)
        self.assertEqual(auth.user.legal_first_name, "Aiko")
        self.assertEqual(auth.user.legal_last_name, "Tanaka")
        self.assertEqual(auth.user.full_name, "Aiko T.")
        self.assertEqual(auth.studio_id, "studio-1")
        self.assertEqual(auth.role, "admin")
        self.assertEqual(supabase.auth_user_id, "user-1")

        profile_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_profiles"
        )
        self.assertEqual(
            profile_query,
            {
                "table": "staff_profiles",
                "columns": "legal_first_name, legal_last_name",
                "filters": (("eq", "user_id", "user-1"),),
                "or_filters": (),
                "orders": (),
                "range": None,
                "limit": 1,
                "insert": None,
                "upsert": None,
                "update": None,
                "delete": False,
            },
        )

        staff_role_query = next(
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        )
        self.assertEqual(staff_role_query["filters"], (("eq", "user_id", "user-1"),))

    def test_existing_schema_without_profile_row_returns_available_with_null_names(self):
        supabase = FakeAuthSupabase(profile_rows=[])

        auth = asyncio.run(AuthService(supabase).get_user_profile("user-1"))

        self.assertTrue(auth.staff_profiles_available)
        self.assertIsNone(auth.user.legal_first_name)
        self.assertIsNone(auth.user.legal_last_name)

    def test_missing_staff_profile_schema_codes_return_unavailable_with_null_names(self):
        for code in ("42P01", "42703", "PGRST204", "PGRST205"):
            with self.subTest(code=code):
                failure = PostgrestAPIError({
                    "code": code,
                    "message": "staff_profiles is unavailable",
                    "details": "",
                    "hint": "",
                })
                supabase = FakeAuthSupabase(
                    profile_failure=failure,
                    user_metadata={"full_name": "Display Name"},
                )

                auth = asyncio.run(AuthService(supabase).get_user_profile("user-1"))

                self.assertFalse(auth.staff_profiles_available)
                self.assertIsNone(auth.user.legal_first_name)
                self.assertIsNone(auth.user.legal_last_name)
                self.assertEqual(auth.user.full_name, "Display Name")

    def test_unrelated_postgrest_failure_is_reraised(self):
        failure = PostgrestAPIError({
            "code": "42501",
            "message": "permission denied for table staff_profiles",
            "details": "",
            "hint": "",
        })
        supabase = FakeAuthSupabase(profile_failure=failure)

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(AuthService(supabase).get_user_profile("user-1"))

        self.assertIs(raised.exception, failure)


if __name__ == "__main__":
    unittest.main()
