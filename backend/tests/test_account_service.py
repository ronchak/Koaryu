from __future__ import annotations

import asyncio
import unittest
from datetime import datetime

from fastapi import HTTPException

from app.schemas.account import AccountDeletionRequestCreate
from app.services.account_service import AccountService


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
        })())

    def delete_user(self, user_id):
        self.supabase.deleted_user_ids.append(user_id)
        self.supabase.tables["staff_roles"] = [
            row
            for row in self.supabase.tables["staff_roles"]
            if row.get("user_id") != user_id
        ]
        return True


class FakeAuth:
    def __init__(self, supabase):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase:
    def __init__(self):
        self.inactive_user_ids = set()
        self.deleted_user_ids = []
        self.auth = FakeAuth(self)
        self.tables = {
            "account_deletion_requests": [],
            "audit_logs": [],
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
        self.insert_payload = None
        self.update_payload = None
        self.delete_requested = False

    def select(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def update(self, payload):
        self.update_payload = payload
        return self

    def delete(self):
        self.delete_requested = True
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def lte(self, key, value):
        self.filters.append((key, ("lte", value)))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = self.supabase.tables[self.name]
        if self.insert_payload is not None:
            row = {
                "id": f"{self.name}_1",
                **self.insert_payload,
            }
            rows.append(row)
            return Result([dict(row)])

        matched = [
            row for row in rows
            if all(
                (row.get(key) <= value[1] if isinstance(value, tuple) and value[0] == "lte" else row.get(key) == value)
                for key, value in self.filters
            )
        ]

        if self.delete_requested:
            self.supabase.tables[self.name] = [row for row in rows if row not in matched]
            return Result([dict(row) for row in matched])

        if self.update_payload is not None:
            for row in matched:
                row.update(self.update_payload)
            return Result([dict(row) for row in matched])

        return Result([dict(row) for row in matched])


class AccountServiceTest(unittest.TestCase):
    def test_schedule_deletion_creates_30_day_request(self):
        supabase = FakeSupabase()
        service = AccountService(supabase)

        request = asyncio.run(service.schedule_deletion(
            AccountDeletionRequestCreate(),
            "user_1",
            None,
        ))

        self.assertEqual(request.user_id, "user_1")
        self.assertEqual(request.status, "scheduled")
        requested_at = datetime.fromisoformat(request.requested_at)
        scheduled_for = datetime.fromisoformat(request.scheduled_for)
        self.assertEqual((scheduled_for - requested_at).days, 30)

    def test_schedule_deletion_is_idempotent_when_existing_request_exists(self):
        supabase = FakeSupabase()
        supabase.tables["account_deletion_requests"] = [{
            "id": "delete_1",
            "user_id": "user_1",
            "studio_id": "studio_1",
            "requested_by": "user_1",
            "requester_email": "user_1@example.com",
            "status": "scheduled",
            "requested_at": "2026-05-20T00:00:00+00:00",
            "scheduled_for": "2026-06-19T00:00:00+00:00",
            "reason": None,
        }]
        service = AccountService(supabase)

        request = asyncio.run(service.schedule_deletion(
            AccountDeletionRequestCreate(),
            "user_1",
            "studio_1",
        ))

        self.assertEqual(request.id, "delete_1")
        self.assertEqual(len(supabase.tables["account_deletion_requests"]), 1)

    def test_sole_admin_owner_is_blocked(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "user_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "user_2", "role": "admin"},
        ]
        service = AccountService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.schedule_deletion(
                AccountDeletionRequestCreate(),
                "user_1",
                "studio_1",
            ))

        self.assertEqual(context.exception.status_code, 409)

    def test_admin_deletion_ignores_other_admins_already_scheduled_for_deletion(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "user_2", "role": "admin"},
        ]
        supabase.tables["account_deletion_requests"] = [{
            "id": "delete_2",
            "user_id": "user_2",
            "studio_id": "studio_1",
            "requested_by": "user_2",
            "requester_email": "user_2@example.com",
            "status": "scheduled",
            "requested_at": "2026-05-20T00:00:00+00:00",
            "scheduled_for": "2026-06-19T00:00:00+00:00",
            "reason": None,
        }]
        service = AccountService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.schedule_deletion(
                AccountDeletionRequestCreate(),
                "user_1",
                "studio_1",
            ))

        self.assertEqual(context.exception.status_code, 409)

    def test_pending_invited_admin_does_not_count_as_survivor(self):
        supabase = FakeSupabase()
        supabase.inactive_user_ids.add("pending_admin")
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "pending_admin", "role": "admin"},
        ]
        service = AccountService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.schedule_deletion(
                AccountDeletionRequestCreate(),
                "user_1",
                "studio_1",
            ))

        self.assertEqual(context.exception.status_code, 409)

    def test_cancel_deletion_marks_existing_request_canceled(self):
        supabase = FakeSupabase()
        supabase.tables["account_deletion_requests"] = [{
            "id": "delete_1",
            "user_id": "user_1",
            "studio_id": "studio_1",
            "requested_by": "user_1",
            "requester_email": "user_1@example.com",
            "status": "scheduled",
            "requested_at": "2026-05-20T00:00:00+00:00",
            "scheduled_for": "2026-06-19T00:00:00+00:00",
            "reason": None,
        }]
        service = AccountService(supabase)

        request = asyncio.run(service.cancel_deletion("user_1", "studio_1"))

        self.assertIsNotNone(request)
        self.assertEqual(request.status, "canceled")
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["status"], "canceled")

    def test_process_due_deletions_removes_staff_roles_and_auth_user(self):
        supabase = FakeSupabase()
        supabase.tables["account_deletion_requests"] = [{
            "id": "delete_1",
            "user_id": "user_1",
            "studio_id": "studio_1",
            "requested_by": "user_1",
            "requester_email": "user_1@example.com",
            "status": "scheduled",
            "requested_at": "2026-04-01T00:00:00+00:00",
            "scheduled_for": "2026-04-30T00:00:00+00:00",
            "reason": None,
        }]
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "instructor"},
        ]
        service = AccountService(supabase)

        result = asyncio.run(service.process_due_deletions())

        self.assertEqual(result.completed, 1)
        self.assertEqual(supabase.deleted_user_ids, ["user_1"])
        self.assertEqual(supabase.tables["staff_roles"], [])
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
