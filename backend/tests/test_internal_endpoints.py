import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.api.v1.endpoints import internal
from app.core.config import get_settings
from app.core.deps import get_supabase
from app.main import app
from app.schemas.account import AccountDeletionProcessFailure, AccountDeletionProcessResponse
from app.schemas.support import SupportTicketResponse


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

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_rejects_invalid_secret(self, support_service_class, _settings):
        response = self.client.get(
            "/api/v1/internal/support/tickets",
            headers={"X-Internal-Secret": "wrong-secret"},
        )

        self.assertEqual(response.status_code, 403)
        support_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_list_passes_filters(self, support_service_class, _settings):
        service = support_service_class.return_value
        service.list_triage_tickets = AsyncMock(return_value=[
            SupportTicketResponse(
                id="ticket_1",
                studio_id="studio_1",
                created_by="user_1",
                requester_email="user_1@example.com",
                topic="billing",
                severity="urgent",
                subject="Billing failed",
                details="Payment did not work.",
                browser_context={},
                status="open",
                created_at="2026-05-20T00:00:00+00:00",
                updated_at="2026-05-20T00:00:00+00:00",
            )
        ])

        response = self.client.get(
            "/api/v1/internal/support/tickets?status=open&severity=urgent&topic=billing&limit=25",
            headers={"X-Internal-Secret": "support-secret"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["id"], "ticket_1")
        filters = service.list_triage_tickets.call_args.args[0]
        self.assertEqual(filters.statuses, ["open"])
        self.assertEqual(filters.severities, ["urgent"])
        self.assertEqual(filters.topics, ["billing"])
        self.assertEqual(filters.limit, 25)

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_list_rejects_invalid_limit(self, support_service_class, _settings):
        response = self.client.get(
            "/api/v1/internal/support/tickets?limit=500",
            headers={"X-Internal-Secret": "support-secret"},
        )

        self.assertEqual(response.status_code, 422)
        support_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_update_changes_status_and_adds_note(self, support_service_class, _settings):
        ticket_id = "11111111-1111-4111-8111-111111111111"
        service = support_service_class.return_value
        service.triage_ticket = AsyncMock(return_value=SupportTicketResponse(
            id=ticket_id,
            studio_id="studio_1",
            created_by="user_1",
            requester_email="user_1@example.com",
            topic="bug_report",
            severity="high",
            subject="Import failed",
            details="CSV import failed.",
            browser_context={},
            status="triaging",
            created_at="2026-05-20T00:00:00+00:00",
            updated_at="2026-05-20T01:00:00+00:00",
        ))

        response = self.client.patch(
            f"/api/v1/internal/support/tickets/{ticket_id}",
            headers={"X-Internal-Secret": "support-secret"},
            json={"status": "triaging", "note": "Looking into this.", "metadata": {"source": "test"}},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "triaging")
        called_ticket_id, payload = service.triage_ticket.call_args.args
        self.assertEqual(called_ticket_id, ticket_id)
        self.assertEqual(payload.status, "triaging")
        self.assertEqual(payload.note, "Looking into this.")

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_update_rejects_malformed_ticket_id(self, support_service_class, _settings):
        response = self.client.patch(
            "/api/v1/internal/support/tickets/not-a-uuid",
            headers={"X-Internal-Secret": "support-secret"},
            json={"status": "triaging", "note": "Looking into this."},
        )

        self.assertEqual(response.status_code, 422)
        support_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.SupportService")
    def test_support_triage_update_rejects_empty_action(self, support_service_class, _settings):
        response = self.client.patch(
            "/api/v1/internal/support/tickets/11111111-1111-4111-8111-111111111111",
            headers={"X-Internal-Secret": "support-secret"},
            json={"metadata": {"source": "test"}},
        )

        self.assertEqual(response.status_code, 422)
        support_service_class.assert_not_called()
