import unittest

from fastapi import HTTPException

from app.services.studio_service import StudioService


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
            "email_confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "last_sign_in_at": None,
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
            "studios": [],
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


class StudioServiceTest(unittest.TestCase):
    def test_owner_can_transfer_to_active_admin(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "admin_2", "role": "admin"},
        ]
        service = StudioService(supabase)

        service._validate_owner_transfer("studio_1", "owner_1", "admin_2")

    def test_non_owner_cannot_transfer_ownership(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "admin_2", "role": "admin"},
        ]
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            service._validate_owner_transfer("studio_1", "admin_2", "admin_3")

        self.assertEqual(context.exception.status_code, 403)

    def test_owner_cannot_transfer_to_pending_admin(self):
        supabase = FakeSupabase()
        supabase.inactive_user_ids.add("pending_admin")
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "pending_admin", "role": "admin"},
        ]
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            service._validate_owner_transfer("studio_1", "owner_1", "pending_admin")

        self.assertEqual(context.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
