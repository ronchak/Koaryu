import unittest

from fastapi import HTTPException

from app.services.staff_service import StaffService


class Result:
    def __init__(self, data):
        self.data = data


class FakeUserResponse:
    def __init__(self, user):
        self.user = user


class FakeAuthAdmin:
    def __init__(self, supabase):
        self.supabase = supabase

    def get_user_by_id(self, user_id):
        is_active = user_id not in self.supabase.inactive_user_ids
        return FakeUserResponse(type("User", (), {
            "id": user_id,
            "email": f"{user_id}@example.com",
            "email_confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "last_sign_in_at": None,
            "user_metadata": {},
        })())


class FakeAuth:
    def __init__(self, supabase):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase:
    def __init__(self):
        self.inactive_user_ids = set()
        self.auth = FakeAuth(self)
        self.tables = {
            "staff_roles": [],
            "account_deletion_requests": [],
        }

    def table(self, name):
        return FakeTable(self, name)


class FakeTable:
    def __init__(self, supabase, name):
        self.supabase = supabase
        self.name = name
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = self.supabase.tables[self.name]
        matched = [
            row for row in rows
            if all(row.get(key) == value for key, value in self.filters)
        ]
        return Result([dict(row) for row in matched])


class StaffServiceAccountDeletionTest(unittest.TestCase):
    def test_scheduled_deleting_admin_does_not_count_as_remaining_admin(self):
        supabase = FakeSupabase()
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "deleting_admin", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "active_admin", "role": "admin"},
        ]
        supabase.tables["account_deletion_requests"] = [
            {"id": "delete_1", "user_id": "deleting_admin", "status": "scheduled"},
        ]
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            service._ensure_more_than_one_admin("studio_1", "active_admin")

        self.assertEqual(context.exception.status_code, 409)

    def test_pending_admin_can_be_removed_when_active_admin_remains(self):
        supabase = FakeSupabase()
        supabase.inactive_user_ids.add("pending_admin")
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "pending_admin", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "active_admin", "role": "admin"},
        ]
        service = StaffService(supabase)

        service._ensure_more_than_one_admin("studio_1", "pending_admin")

    def test_two_active_admins_pass_even_if_third_admin_is_deleting(self):
        supabase = FakeSupabase()
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "deleting_admin", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "active_admin_1", "role": "admin"},
            {"id": "role_3", "studio_id": "studio_1", "user_id": "active_admin_2", "role": "admin"},
        ]
        supabase.tables["account_deletion_requests"] = [
            {"id": "delete_1", "user_id": "deleting_admin", "status": "scheduled"},
        ]
        service = StaffService(supabase)

        service._ensure_more_than_one_admin("studio_1")

    def test_pending_admin_does_not_count_as_remaining_admin(self):
        supabase = FakeSupabase()
        supabase.inactive_user_ids.add("pending_admin")
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "pending_admin", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "active_admin", "role": "admin"},
        ]
        service = StaffService(supabase)

        with self.assertRaises(HTTPException) as context:
            service._ensure_more_than_one_admin("studio_1", "active_admin")

        self.assertEqual(context.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
