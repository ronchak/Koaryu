import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.api.v1.endpoints import internal
from app.core.config import get_settings
from app.core.deps import get_supabase
from app.main import app
from app.schemas.account import AccountDeletionProcessFailure, AccountDeletionProcessResponse


class FakeSettings:
    ACCOUNT_DELETION_WORKER_SECRET = "delete-secret"
    SUPPORT_TRIAGE_SECRET = "support-secret"


class InternalEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides[get_supabase] = lambda: object()
        internal.get_settings.cache_clear()
        internal.get_settings = get_settings

    def tearDown(self):
        app.dependency_overrides.clear()
        internal.get_settings.cache_clear()
        internal.get_settings = get_settings

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.AccountService")
    def test_process_due_account_deletions_returns_500_when_worker_has_failures(
        self,
        account_service_class,
        _settings,
    ):
        service = account_service_class.return_value
        service.process_due_deletions = AsyncMock(return_value=AccountDeletionProcessResponse(
            processed=1,
            failed=1,
            failures=[
                AccountDeletionProcessFailure(
                    request_id="delete_1",
                    user_id="user_1",
                    detail="Auth deletion failed",
                )
            ],
        ))

        response = self.client.post(
            "/api/v1/internal/account-deletions/process-due",
            headers={"X-Internal-Secret": "delete-secret"},
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"]["failed"], 1)
        self.assertEqual(response.json()["detail"]["failures"][0]["request_id"], "delete_1")

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.AccountService")
    def test_process_due_account_deletions_returns_200_when_worker_succeeds(
        self,
        account_service_class,
        _settings,
    ):
        service = account_service_class.return_value
        service.process_due_deletions = AsyncMock(return_value=AccountDeletionProcessResponse(
            processed=1,
            completed=1,
        ))

        response = self.client.post(
            "/api/v1/internal/account-deletions/process-due",
            headers={"X-Internal-Secret": "delete-secret"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["completed"], 1)
