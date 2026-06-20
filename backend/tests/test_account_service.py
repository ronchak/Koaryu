from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app.schemas.account import AccountDeletionRequestCreate
from app.services.account_service import AccountService
from tests.fakes.supabase import RpcBackedSupabase


class FakeUserResponse:
    def __init__(self, user):
        self.user = user


class FakeAuthUserNotFound(Exception):
    status_code = 404
    code = "user_not_found"


class FakeAuthAdmin:
    def __init__(self, supabase):
        self.supabase = supabase

    def get_user_by_id(self, user_id):
        if user_id in self.supabase.lookup_error_user_ids:
            raise RuntimeError("temporary auth lookup outage")
        if user_id in self.supabase.deleted_auth_user_ids:
            raise FakeAuthUserNotFound("User not found")
        is_active = user_id not in self.supabase.inactive_user_ids
        return FakeUserResponse(type("User", (), {
            "id": user_id,
            "email": f"{user_id}@example.com",
            "email_confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "confirmed_at": "2026-05-01T00:00:00+00:00" if is_active else None,
            "last_sign_in_at": None,
        })())

    def delete_user(self, user_id):
        if user_id in self.supabase.deleted_auth_user_ids:
            raise FakeAuthUserNotFound("User not found")
        self.supabase.deleted_user_ids.append(user_id)
        self.supabase.deleted_auth_user_ids.add(user_id)
        self.supabase.tables["staff_roles"] = [
            row
            for row in self.supabase.tables["staff_roles"]
            if row.get("user_id") != user_id
        ]
        return True


class FakeAuth:
    def __init__(self, supabase):
        self.admin = FakeAuthAdmin(supabase)


class FakeSupabase(RpcBackedSupabase):
    def __init__(self):
        super().__init__({
            "account_deletion_requests": [],
            "audit_logs": [],
            "staff_roles": [],
            "studios": [],
        })
        self.inactive_user_ids = set()
        self.lookup_error_user_ids = set()
        self.deleted_auth_user_ids = set()
        self.deleted_user_ids = []
        self.auth = FakeAuth(self)

    def _rpc_claim_due_account_deletion_requests(self, params: dict) -> list[dict]:
        now = datetime.now(timezone.utc)
        claimed = []
        for row in sorted(
            self.tables["account_deletion_requests"],
            key=lambda item: (item.get("scheduled_for") or "", item.get("requested_at") or "", item.get("id") or ""),
        ):
            if len(claimed) >= params["p_limit"]:
                break
            if row.get("status") != "scheduled" or not self._is_due(row, now):
                continue
            if row.get("processing_token") and not self._claim_is_stale(row, now):
                continue
            row["processing_token"] = params["p_processing_token"]
            row["processing_started_at"] = now.isoformat()
            claimed.append(dict(row))
        return claimed

    def _rpc_finish_account_deletion_request(self, params: dict) -> list[dict]:
        for row in self.tables["account_deletion_requests"]:
            if row.get("id") == params["p_request_id"] and row.get("processing_token") == params["p_processing_token"]:
                row["status"] = params["p_status"]
                row["processing_token"] = None
                row["processing_started_at"] = None
                if params["p_status"] == "completed":
                    row["completed_at"] = datetime.now(timezone.utc).isoformat()
                if params["p_status"] == "canceled":
                    row["canceled_at"] = datetime.now(timezone.utc).isoformat()
                    row["reason"] = params.get("p_reason")
                return [{"updated": True, "request_row": dict(row)}]
        return [{"updated": False, "request_row": None}]

    @staticmethod
    def _parse_datetime(value):
        if isinstance(value, datetime):
            parsed = value
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _is_due(self, row: dict, now: datetime) -> bool:
        return self._parse_datetime(row["scheduled_for"]) <= now

    def _claim_is_stale(self, row: dict, now: datetime) -> bool:
        started_at = row.get("processing_started_at")
        if not started_at:
            return False
        return now - self._parse_datetime(started_at) >= timedelta(minutes=30)


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
        self.assertIsNone(supabase.tables["account_deletion_requests"][0]["processing_token"])

    def test_process_due_deletions_skips_fresh_claimed_request(self):
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
            "processing_token": "other-worker",
            "processing_started_at": datetime.now().astimezone().isoformat(),
            "reason": None,
        }]
        service = AccountService(supabase)

        result = asyncio.run(service.process_due_deletions())

        self.assertEqual(result.processed, 0)
        self.assertEqual(result.completed, 0)
        self.assertEqual(supabase.deleted_user_ids, [])
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["processing_token"], "other-worker")

    def test_process_due_deletions_reclaims_stale_claim(self):
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
            "processing_token": "stale-worker",
            "processing_started_at": "2026-04-30T00:00:00+00:00",
            "reason": None,
        }]
        supabase.tables["studios"] = [{"id": "studio_1", "owner_id": "owner_1"}]
        supabase.tables["staff_roles"] = [
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "instructor"},
        ]
        service = AccountService(supabase)

        result = asyncio.run(service.process_due_deletions())

        self.assertEqual(result.processed, 1)
        self.assertEqual(result.completed, 1)
        self.assertEqual(supabase.deleted_user_ids, ["user_1"])
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["status"], "completed")
        self.assertIsNone(supabase.tables["account_deletion_requests"][0]["processing_token"])

    def test_process_due_deletions_uses_worker_claim_rpc_when_available(self):
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

        result = asyncio.run(service.process_due_deletions(limit=10))

        self.assertEqual(result.completed, 1)
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["claim_due_account_deletion_requests", "finish_account_deletion_request"],
        )
        self.assertEqual(supabase.rpc_calls[0][1]["p_limit"], 10)

    def test_process_due_deletions_retries_when_survivor_auth_lookup_fails(self):
        supabase = FakeSupabase()
        supabase.lookup_error_user_ids.add("user_2")
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
            {"id": "role_1", "studio_id": "studio_1", "user_id": "user_1", "role": "admin"},
            {"id": "role_2", "studio_id": "studio_1", "user_id": "user_2", "role": "admin"},
        ]
        service = AccountService(supabase)

        result = asyncio.run(service.process_due_deletions())

        self.assertEqual(result.blocked, 0)
        self.assertEqual(result.failed, 1)
        self.assertEqual(result.completed, 0)
        self.assertEqual(supabase.deleted_user_ids, [])
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["status"], "scheduled")
        self.assertIsNotNone(supabase.tables["account_deletion_requests"][0]["processing_token"])

    def test_process_due_deletions_completes_when_auth_user_already_deleted(self):
        supabase = FakeSupabase()
        supabase.deleted_auth_user_ids.add("user_1")
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

        self.assertEqual(result.failed, 0)
        self.assertEqual(result.completed, 1)
        self.assertEqual(supabase.deleted_user_ids, [])
        self.assertEqual(supabase.tables["account_deletion_requests"][0]["status"], "completed")
        self.assertIsNone(supabase.tables["account_deletion_requests"][0]["processing_token"])


if __name__ == "__main__":
    unittest.main()
