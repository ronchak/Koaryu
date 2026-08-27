import hashlib
import asyncio
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID

from fastapi import HTTPException, Response
from fastapi.testclient import TestClient

from app.api.v1.endpoints import internal
from app.core.config import get_settings
from app.core.deps import get_operational_alert_supabase, get_supabase
from app.main import app
from app.schemas.account import AccountDeletionProcessFailure, AccountDeletionProcessResponse
from app.schemas.support import SupportTicketResponse


class FakeSettings:
    ACCOUNT_DELETION_WORKER_SECRET = "delete-secret"
    BILLING_TRANSITION_WORKER_SECRET = "billing-transition-secret"
    BILLING_TRANSITION_SCHEDULER_ENABLED = True
    OPERATIONAL_ALERTS_ENABLED = False
    OPERATIONAL_ALERT_WORKER_SECRET = "operational-alert-secret"
    SUPPORT_TRIAGE_SECRET = "support-secret"


class EnabledAlertSettings(FakeSettings):
    ENVIRONMENT = "staging"
    SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
    OPERATIONAL_ALERTS_ENABLED = True
    OPERATIONAL_ALERT_WORKER_SECRET = "operational-alert-secret-1234567890"
    OPERATIONAL_ALERT_PRIMARY_URL = "https://alerts.example.com/primary"
    OPERATIONAL_ALERT_PRIMARY_HOST = "alerts.example.com"
    OPERATIONAL_ALERT_PRIMARY_URL_SHA256 = hashlib.sha256(
        OPERATIONAL_ALERT_PRIMARY_URL.encode()
    ).hexdigest()
    OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET = "p" * 40
    OPERATIONAL_ALERT_PRIMARY_ACK_SECRET = "a" * 40
    OPERATIONAL_ALERT_BACKUP_URL = "https://alerts.example.com/backup"
    OPERATIONAL_ALERT_BACKUP_HOST = "alerts.example.com"
    OPERATIONAL_ALERT_BACKUP_URL_SHA256 = hashlib.sha256(
        OPERATIONAL_ALERT_BACKUP_URL.encode()
    ).hexdigest()
    OPERATIONAL_ALERT_BACKUP_BEARER_SECRET = "b" * 40
    OPERATIONAL_ALERT_BACKUP_ACK_SECRET = "c" * 40


class LocalAlertSettings(EnabledAlertSettings):
    ENVIRONMENT = "development"
    SUPABASE_URL = "http://127.0.0.1:54321"


class InternalEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides[get_supabase] = lambda: object()
        app.dependency_overrides[get_operational_alert_supabase] = lambda: object()
        internal.get_settings.cache_clear()
        internal.get_settings = get_settings

    def tearDown(self):
        app.dependency_overrides.clear()
        internal.get_settings.cache_clear()
        internal.get_settings = get_settings

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.BillingService")
    def test_due_billing_enrollment_transitions_require_dedicated_secret(
        self,
        billing_service_class,
        _settings,
    ):
        response = self.client.post(
            "/api/v1/internal/billing/enrollment-transitions/process-due",
            headers={"X-Internal-Secret": "wrong-secret"},
        )

        self.assertEqual(response.status_code, 403)
        billing_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.BillingService")
    def test_due_billing_enrollment_transitions_dispatch_bounded_worker(
        self,
        billing_service_class,
        _settings,
    ):
        service = billing_service_class.return_value
        service.process_due_enrollment_transitions = AsyncMock(return_value={
            "claimed": 2,
            "completed": 1,
            "reconciliation_required": 1,
            "failed": 0,
        })

        response = self.client.post(
            "/api/v1/internal/billing/enrollment-transitions/process-due?limit=7",
            headers={"X-Internal-Secret": "billing-transition-secret"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["claimed"], 2)
        called = service.process_due_enrollment_transitions.await_args.kwargs
        self.assertEqual(called["limit"], 7)
        self.assertNotEqual(UUID(called["worker_id"]).int, 0)

    @patch(
        "app.api.v1.endpoints.internal.get_settings",
        return_value=type(
            "DisabledTransitionSettings",
            (),
            {
                "BILLING_TRANSITION_WORKER_SECRET": "billing-transition-secret",
                "BILLING_TRANSITION_SCHEDULER_ENABLED": False,
            },
        )(),
    )
    @patch("app.api.v1.endpoints.internal.BillingService")
    def test_due_billing_enrollment_transitions_fail_closed_when_scheduler_disabled(
        self,
        billing_service_class,
        _settings,
    ):
        response = self.client.post(
            "/api/v1/internal/billing/enrollment-transitions/process-due",
            headers={"X-Internal-Secret": "billing-transition-secret"},
        )

        self.assertEqual(response.status_code, 503)
        billing_service_class.assert_not_called()

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

    @patch("app.api.v1.endpoints.internal.get_settings")
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    @patch("app.api.v1.endpoints.internal.AccountService")
    def test_deletion_heartbeat_rejects_dev_label_on_production_target_before_rpc(
        self,
        account_service_class,
        alert_service_class,
        settings,
    ):
        class UnsafeSettings(EnabledAlertSettings):
            ENVIRONMENT = "development"
            SUPABASE_URL = "https://mimguepumzsgmcaycdsh.supabase.co"

        settings.return_value = UnsafeSettings()
        account_service_class.return_value.process_due_deletions = AsyncMock(
            return_value=AccountDeletionProcessResponse(processed=0),
        )

        response = self.client.post(
            "/api/v1/internal/account-deletions/process-due",
            headers={"X-Internal-Secret": "delete-secret"},
        )

        self.assertEqual(response.status_code, 200)
        alert_service_class.assert_not_called()

    def test_operational_alert_target_accepts_pinned_staging_and_local_supabase(self):
        self.assertEqual(
            internal._verify_operational_alert_target(
                EnabledAlertSettings.ENVIRONMENT,
                EnabledAlertSettings.SUPABASE_URL,
            ),
            "staging",
        )
        self.assertEqual(
            internal._verify_operational_alert_target(
                LocalAlertSettings.ENVIRONMENT,
                LocalAlertSettings.SUPABASE_URL,
            ),
            "development",
        )

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=FakeSettings())
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_evaluator_stays_inactive_by_default(
        self,
        alert_service_class,
        _settings,
    ):
        response = self.client.post(
            "/api/v1/internal/operational-alerts/evaluate",
            headers={"X-Internal-Secret": "operational-alert-secret"},
        )

        self.assertEqual(response.status_code, 503)
        alert_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=EnabledAlertSettings())
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_evaluator_requires_dedicated_secret(
        self,
        alert_service_class,
        _settings,
    ):
        response = self.client.post(
            "/api/v1/internal/operational-alerts/evaluate",
            headers={"X-Internal-Secret": "wrong-secret"},
        )

        self.assertEqual(response.status_code, 403)
        alert_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_evaluator_rejects_unsafe_configured_secret_before_client(
        self,
        alert_service_class,
    ):
        class UnsafeSettings(EnabledAlertSettings):
            OPERATIONAL_ALERT_WORKER_SECRET = f"{'w' * 40}\x7f"

        with patch(
            "app.api.v1.endpoints.internal.get_settings",
            return_value=UnsafeSettings(),
        ):
            response = self.client.post(
                "/api/v1/internal/operational-alerts/evaluate",
                headers={"X-Internal-Secret": "w" * 40},
            )

        self.assertEqual(response.status_code, 503)
        alert_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_evaluator_rejects_dev_label_on_hosted_target(
        self,
        alert_service_class,
    ):
        class UnsafeSettings(EnabledAlertSettings):
            ENVIRONMENT = "development"
            SUPABASE_URL = "https://mimguepumzsgmcaycdsh.supabase.co"

        with patch(
            "app.api.v1.endpoints.internal.get_settings",
            return_value=UnsafeSettings(),
        ):
            response = self.client.post(
                "/api/v1/internal/operational-alerts/evaluate",
                headers={
                    "X-Internal-Secret": EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET,
                },
            )

        self.assertEqual(response.status_code, 503)
        alert_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=EnabledAlertSettings())
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_evaluator_returns_counts_only_summary(
        self,
        alert_service_class,
        _settings,
    ):
        alert_service_class.return_value.evaluate.return_value = {
            "environment": "staging",
            "mode": "https",
            "metrics": {
                "stripe-live-webhook-failure": 0,
                "account-deletion-worker-overdue": 0,
                "support-urgent-untriaged": 0,
                "billing-reconciliation-stale": 0,
            },
            "lifecycle_events": {},
            "deliveries_claimed": 0,
            "deliveries_delivered": 0,
            "deliveries_failed": 0,
            "heartbeat_recorded": True,
            "heartbeat_sequence": 1,
        }

        response = self.client.post(
            "/api/v1/internal/operational-alerts/evaluate",
            headers={"X-Internal-Secret": EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "https")
        alert_service_class.return_value.evaluate.assert_called_once()

    def test_operational_alert_worker_owns_lock_until_sync_evaluation_exits(self):
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        result = {
            "environment": "staging",
            "mode": "https",
            "metrics": {},
            "lifecycle_events": {},
            "deliveries_claimed": 0,
            "deliveries_delivered": 0,
            "deliveries_failed": 0,
            "heartbeat_recorded": True,
            "heartbeat_sequence": 1,
        }

        def blocking_evaluate(**_kwargs):
            started.set()
            release.wait(timeout=1)
            completed.set()
            return result

        with (
            patch("app.api.v1.endpoints.internal.HttpsAlertDestination.from_settings"),
            patch("app.api.v1.endpoints.internal.OperationalAlertService") as service_class,
        ):
            service_class.return_value.evaluate.side_effect = blocking_evaluate
            worker = threading.Thread(
                target=internal._run_operational_alert_evaluation,
                kwargs={
                    "supabase": object(),
                    "settings": EnabledAlertSettings(),
                    "environment": "staging",
                    "commit_sha": None,
                    "deadline_monotonic": time.monotonic() + 1,
                },
            )
            worker.start()
            try:
                self.assertTrue(started.wait(timeout=1))

                with self.assertRaises(internal._OperationalAlertEvaluationBusy):
                    internal._run_operational_alert_evaluation(
                        supabase=object(),
                        settings=EnabledAlertSettings(),
                        environment="staging",
                        commit_sha=None,
                        deadline_monotonic=time.monotonic() + 1,
                    )

                self.assertFalse(completed.is_set())
                self.assertTrue(worker.is_alive())
            finally:
                release.set()
                worker.join(timeout=1)

        self.assertTrue(completed.is_set())
        self.assertFalse(worker.is_alive())

    def test_expired_queued_evaluation_performs_no_destination_or_rpc_work(self):
        with (
            patch(
                "app.api.v1.endpoints.internal.HttpsAlertDestination.from_settings"
            ) as destination_factory,
            patch(
                "app.api.v1.endpoints.internal.OperationalAlertService"
            ) as service_class,
            self.assertRaisesRegex(
                internal.OperationalAlertDeadlineExceeded,
                "deadline exceeded",
            ),
        ):
            internal._run_operational_alert_evaluation(
                supabase=object(),
                settings=EnabledAlertSettings(),
                environment="staging",
                commit_sha=None,
                deadline_monotonic=time.monotonic() - 1,
            )

        destination_factory.assert_not_called()
        service_class.assert_not_called()

    def test_operational_alert_evaluator_stays_off_loop_and_overlap_is_truthful(self):
        async def exercise():
            started = threading.Event()
            release = threading.Event()
            completed = threading.Event()
            result = {
                "environment": "staging",
                "mode": "https",
                "metrics": {
                    "stripe-live-webhook-failure": 0,
                    "account-deletion-worker-overdue": 0,
                    "support-urgent-untriaged": 0,
                    "billing-reconciliation-stale": 0,
                },
                "lifecycle_events": {},
                "deliveries_claimed": 0,
                "deliveries_delivered": 0,
                "deliveries_failed": 0,
                "heartbeat_recorded": True,
                "heartbeat_sequence": 1,
            }

            evaluation_calls = 0

            def blocking_evaluate(**_kwargs):
                nonlocal evaluation_calls
                evaluation_calls += 1
                if evaluation_calls == 1:
                    started.set()
                    release.wait(timeout=1)
                    completed.set()
                return result

            with (
                patch("app.api.v1.endpoints.internal.get_settings", return_value=EnabledAlertSettings()),
                patch("app.api.v1.endpoints.internal.HttpsAlertDestination.from_settings"),
                patch("app.api.v1.endpoints.internal.OperationalAlertService") as service_class,
            ):
                service_class.return_value.evaluate.side_effect = blocking_evaluate
                first = asyncio.create_task(internal.evaluate_operational_alerts(
                    internal_secret=EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET,
                    supabase=object(),
                ))
                try:
                    self.assertTrue(await asyncio.to_thread(started.wait, 1))
                    first.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await first

                    from app.api.v1.endpoints.health import health_live

                    health_payload = await health_live(Response())
                    self.assertEqual(health_payload["status"], "ok")

                    with self.assertRaises(HTTPException) as overlap:
                        await internal.evaluate_operational_alerts(
                            internal_secret=EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET,
                            supabase=object(),
                        )
                    self.assertEqual(overlap.exception.status_code, 409)
                    self.assertEqual(
                        overlap.exception.detail,
                        "Operational alert evaluation is already in progress.",
                    )
                    self.assertFalse(completed.is_set())
                finally:
                    release.set()
                self.assertTrue(await asyncio.to_thread(completed.wait, 1))
                resumed = await internal.evaluate_operational_alerts(
                    internal_secret=EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET,
                    supabase=object(),
                )
                self.assertEqual(resumed["heartbeat_sequence"], 1)

        asyncio.run(exercise())

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=EnabledAlertSettings())
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_ack_derives_primary_identity_from_secret(
        self,
        alert_service_class,
        _settings,
    ):
        alert_service_class.return_value.acknowledge.return_value = {
            "episode_id": "11111111-1111-4111-8111-111111111111",
            "lifecycle_event": "acknowledged",
            "acknowledged": True,
            "acknowledged_by_role": "primary",
        }

        response = self.client.post(
            "/api/v1/internal/operational-alerts/11111111-1111-4111-8111-111111111111/acknowledge",
            headers={"X-Internal-Secret": EnabledAlertSettings.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET},
        )

        self.assertEqual(response.status_code, 200)
        call = alert_service_class.return_value.acknowledge.call_args.kwargs
        self.assertEqual(call["actor_role"], "primary")
        self.assertEqual(call["actor_ref"], "primary-owner")

    @patch("app.api.v1.endpoints.internal.get_settings", return_value=EnabledAlertSettings())
    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_ack_rejects_worker_secret(
        self,
        alert_service_class,
        _settings,
    ):
        response = self.client.post(
            "/api/v1/internal/operational-alerts/11111111-1111-4111-8111-111111111111/acknowledge",
            headers={"X-Internal-Secret": EnabledAlertSettings.OPERATIONAL_ALERT_WORKER_SECRET},
        )

        self.assertEqual(response.status_code, 403)
        alert_service_class.return_value.acknowledge.assert_not_called()

    @patch("app.api.v1.endpoints.internal.OperationalAlertService")
    def test_operational_alert_ack_rejects_unsafe_configured_secret_before_rpc(
        self,
        alert_service_class,
    ):
        class UnsafeSettings(EnabledAlertSettings):
            OPERATIONAL_ALERT_PRIMARY_ACK_SECRET = f"{'a' * 40}\n"

        with patch(
            "app.api.v1.endpoints.internal.get_settings",
            return_value=UnsafeSettings(),
        ):
            response = self.client.post(
                "/api/v1/internal/operational-alerts/11111111-1111-4111-8111-111111111111/acknowledge",
                headers={"X-Internal-Secret": "a" * 40},
            )

        self.assertEqual(response.status_code, 503)
        alert_service_class.return_value.acknowledge.assert_not_called()

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
