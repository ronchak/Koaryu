import asyncio
import unittest

from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.studio import StudioCreate, StudioUpdate
from app.api.v1.endpoints.studios import update_current_studio
from app.services.studio_service import StudioService
from tests.fakes.supabase import RpcBackedSupabase


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


class FakeSupabase(RpcBackedSupabase):
    def __init__(self):
        super().__init__({
            "audit_logs": [],
            "studio_subscriptions": [],
            "staff_roles": [],
            "studios": [],
        })
        self.inactive_user_ids = set()
        self.auth = FakeAuth(self)
        self.rpc_exception = None
        self.rpc_result_data = []

    def _rpc_create_studio_onboarding(self, _params):
        if self.rpc_exception:
            raise self.rpc_exception
        return self.rpc_result_data


class StudioSchemaTest(unittest.TestCase):
    def test_studio_create_trims_name_and_timezone(self):
        data = StudioCreate(name="  River City Dojo  ", timezone="  UTC  ")

        self.assertEqual(data.name, "River City Dojo")
        self.assertEqual(data.timezone, "UTC")

    def test_studio_create_rejects_blank_name(self):
        with self.assertRaises(ValidationError) as context:
            StudioCreate(name="   ", timezone="America/New_York")

        self.assertIn("Studio name is required", str(context.exception))

    def test_studio_create_rejects_invalid_timezone(self):
        with self.assertRaises(ValidationError) as context:
            StudioCreate(name="River City Dojo", timezone="Mars/Olympus")

        self.assertIn("Choose a valid timezone", str(context.exception))

    def test_studio_update_rejects_blank_name(self):
        with self.assertRaises(ValidationError) as context:
            StudioUpdate(name=" ", timezone="America/Los_Angeles")

        self.assertIn("Studio name is required", str(context.exception))


class StudioServiceTest(unittest.TestCase):
    def test_create_studio_uses_atomic_rpc_with_idempotency_key(self):
        supabase = FakeSupabase()
        supabase.rpc_result_data = [{
            "id": "studio_1",
            "name": "River City Dojo",
            "slug": "river-city-dojo-abc123",
            "owner_id": "user_1",
            "logo_url": None,
            "timezone": "UTC",
            "created_at": "2026-05-23T00:00:00+00:00",
            "updated_at": "2026-05-23T00:00:00+00:00",
        }]
        service = StudioService(supabase)

        response = asyncio.run(
            service.create_studio(
                StudioCreate(name="River City Dojo", timezone="UTC"),
                "user_1",
                "request-key-1",
            )
        )

        self.assertEqual(response.id, "studio_1")
        self.assertEqual(supabase.rpc_calls, [(
            "create_studio_onboarding",
            {
                "p_user_id": "user_1",
                "p_name": "River City Dojo",
                "p_timezone": "UTC",
                "p_idempotency_key": "request-key-1",
            },
        )])

    def test_create_studio_maps_existing_account_to_conflict(self):
        supabase = FakeSupabase()
        supabase.rpc_exception = Exception("You already have a studio. Only one studio per account in v1.")
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_studio(StudioCreate(name="River City", timezone="UTC"), "user_1"))

        self.assertEqual(context.exception.status_code, 409)

    def test_create_studio_maps_idempotency_conflict(self):
        supabase = FakeSupabase()
        supabase.rpc_exception = Exception(
            "Idempotency key was already used for a different studio creation request."
        )
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_studio(StudioCreate(name="River City", timezone="UTC"), "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(
            context.exception.detail,
            "This studio creation request was already used with different details.",
        )

    def test_create_studio_maps_rpc_validation_to_bad_request(self):
        supabase = FakeSupabase()
        supabase.rpc_exception = Exception("Choose a valid timezone.")
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_studio(StudioCreate(name="River City", timezone="UTC"), "user_1"))

        self.assertEqual(context.exception.status_code, 400)

    def test_create_studio_requires_rpc_result(self):
        supabase = FakeSupabase()
        supabase.rpc_result_data = []
        service = StudioService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_studio(StudioCreate(name="River City", timezone="UTC"), "user_1"))

        self.assertEqual(context.exception.status_code, 500)

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

    def test_non_admin_cannot_update_current_studio_endpoint(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{
            "id": "studio_1",
            "name": "River City Dojo",
            "slug": "river-city-dojo",
            "owner_id": "owner_1",
            "logo_url": None,
            "timezone": "UTC",
            "created_at": "2026-05-23T00:00:00+00:00",
            "updated_at": "2026-05-23T00:00:00+00:00",
        }]
        supabase.tables["staff_roles"] = [{
            "id": "role_1",
            "studio_id": "studio_1",
            "user_id": "front_desk_1",
            "role": "front_desk",
            "created_at": "2026-05-23T00:00:00+00:00",
        }]
        supabase.tables["studio_subscriptions"] = [{
            "studio_id": "studio_1",
            "status": "active",
            "comped": False,
            "trial_end": None,
        }]

        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                update_current_studio(
                    StudioUpdate(name="Front Desk Rename"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=supabase,
                )
            )

        self.assertEqual(context.exception.status_code, 403)
        self.assertEqual(supabase.tables["studios"][0]["name"], "River City Dojo")
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_admin_can_update_current_studio_endpoint(self):
        supabase = FakeSupabase()
        supabase.tables["studios"] = [{
            "id": "studio_1",
            "name": "River City Dojo",
            "slug": "river-city-dojo",
            "owner_id": "owner_1",
            "logo_url": None,
            "timezone": "UTC",
            "created_at": "2026-05-23T00:00:00+00:00",
            "updated_at": "2026-05-23T00:00:00+00:00",
        }]
        supabase.tables["staff_roles"] = [{
            "id": "role_1",
            "studio_id": "studio_1",
            "user_id": "admin_1",
            "role": "admin",
            "created_at": "2026-05-23T00:00:00+00:00",
        }]
        supabase.tables["studio_subscriptions"] = [{
            "studio_id": "studio_1",
            "status": "active",
            "comped": False,
            "trial_end": None,
        }]

        response = asyncio.run(
            update_current_studio(
                StudioUpdate(name="Admin Rename"),
                user_id="admin_1",
                requested_studio_id="studio_1",
                supabase=supabase,
            )
        )

        self.assertEqual(response.name, "Admin Rename")
        self.assertEqual(supabase.tables["studios"][0]["name"], "Admin Rename")


if __name__ == "__main__":
    unittest.main()
