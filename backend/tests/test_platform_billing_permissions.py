import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import platform_billing
from app.core.deps import get_current_user_id, get_supabase
from tests.fakes.supabase import TableBackedSupabase


class PlatformBillingPermissionsTest(unittest.TestCase):
    def test_non_admin_roles_cannot_fetch_platform_stripe_status(self):
        for role in ("front_desk", "instructor"):
            with self.subTest(role=role):
                supabase = TableBackedSupabase({
                    "staff_roles": [{
                        "id": f"role-{role}",
                        "studio_id": "studio-1",
                        "user_id": "user-1",
                        "role": role,
                        "created_at": "2026-07-12T12:00:00Z",
                    }],
                })
                app = FastAPI()
                app.include_router(platform_billing.router)
                app.dependency_overrides[get_current_user_id] = lambda: "user-1"
                app.dependency_overrides[get_supabase] = lambda: supabase

                with patch(
                    "app.api.v1.endpoints.platform_billing.PlatformBillingService"
                ) as service_class:
                    response = TestClient(app).get(
                        "/platform-billing/status",
                        headers={"X-Studio-Id": "studio-1"},
                    )

                self.assertEqual(response.status_code, 403, response.text)
                service_class.assert_not_called()


if __name__ == "__main__":
    unittest.main()
