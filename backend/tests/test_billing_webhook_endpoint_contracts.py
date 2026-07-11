import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.request_body_limits import STRIPE_WEBHOOK_REQUEST_MAX_BYTES
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.main import app
from app.schemas.billing import BillingLinkResponse, WebhookProcessResponse


class BillingAndWebhookEndpointContractTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.supabase = object()
        app.dependency_overrides[get_current_user_id] = lambda: "user_1"
        app.dependency_overrides[get_requested_studio_id] = lambda: "studio_1"
        app.dependency_overrides[get_supabase] = lambda: self.supabase

    def tearDown(self):
        app.dependency_overrides.clear()

    @patch("app.api.v1.endpoints.billing._admin_studio_id", return_value="studio_1")
    @patch("app.api.v1.endpoints.billing.BillingService")
    def test_connect_onboarding_endpoint_delegates_sanitized_request_to_service(
        self,
        billing_service_class,
        admin_studio_id,
    ):
        service = billing_service_class.return_value
        service.create_connect_onboarding_link = AsyncMock(
            return_value=BillingLinkResponse(url="https://connect.stripe.test/setup/acct_1")
        )
        service.audit_connect_onboarding_started = AsyncMock()

        response = self.client.post(
            "/api/v1/billing/connect/onboarding-link",
            json={
                "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
                "return_url": "https://app.koaryu.test/billing?connect=return",
                "business_entity_type": "company",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["url"], "https://connect.stripe.test/setup/acct_1")
        admin_studio_id.assert_called_once_with(self.supabase, "user_1", "studio_1")
        service.create_connect_onboarding_link.assert_awaited_once_with(
            "studio_1",
            "user_1",
            "https://app.koaryu.test/billing/connect/refresh",
            "https://app.koaryu.test/billing?connect=return",
            "company",
        )

    @patch("app.api.v1.endpoints.webhooks.StripeWebhookService")
    def test_connect_webhook_endpoint_passes_raw_payload_signature_and_supabase(self, webhook_service_class):
        service = webhook_service_class.return_value
        service.handle_connect_webhook = AsyncMock(
            return_value=WebhookProcessResponse(status="processed")
        )

        response = self.client.post(
            "/api/v1/webhooks/stripe/connect",
            content=b'{"id":"evt_1"}',
            headers={"Stripe-Signature": "t=1,v1=signature"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"received": True, "status": "processed"})
        webhook_service_class.assert_called_once_with(self.supabase)
        service.handle_connect_webhook.assert_awaited_once_with(b'{"id":"evt_1"}', "t=1,v1=signature")

    @patch("app.api.v1.endpoints.webhooks.StripeWebhookService")
    def test_platform_webhook_endpoint_passes_raw_payload_signature_and_supabase(self, webhook_service_class):
        service = webhook_service_class.return_value
        service.handle_platform_webhook = AsyncMock(
            return_value=WebhookProcessResponse(status="processed")
        )

        response = self.client.post(
            "/api/v1/webhooks/stripe/platform",
            content=b'{"id":"evt_platform"}',
            headers={"Stripe-Signature": "t=1,v1=platform-signature"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"received": True, "status": "processed"})
        webhook_service_class.assert_called_once_with(self.supabase)
        service.handle_platform_webhook.assert_awaited_once_with(
            b'{"id":"evt_platform"}',
            "t=1,v1=platform-signature",
        )

    @patch("app.api.v1.endpoints.webhooks.StripeWebhookService")
    def test_connect_webhook_endpoint_fails_closed_when_signature_validation_fails(self, webhook_service_class):
        service = webhook_service_class.return_value
        service.handle_connect_webhook = AsyncMock(
            side_effect=HTTPException(status_code=400, detail="Invalid Stripe webhook signature.")
        )

        response = self.client.post(
            "/api/v1/webhooks/stripe/connect",
            content=b'{"id":"evt_bad"}',
            headers={"Stripe-Signature": "t=1,v1=bad"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Invalid Stripe webhook signature.")
        webhook_service_class.assert_called_once_with(self.supabase)
        service.handle_connect_webhook.assert_awaited_once_with(b'{"id":"evt_bad"}', "t=1,v1=bad")

    @patch("app.api.v1.endpoints.webhooks.StripeWebhookService")
    def test_platform_webhook_rejects_oversized_content_length_before_reading_body(
        self,
        webhook_service_class,
    ):
        response = self.client.post(
            "/api/v1/webhooks/stripe/platform",
            content=b"{}",
            headers={
                "Content-Length": str(STRIPE_WEBHOOK_REQUEST_MAX_BYTES + 1),
                "Stripe-Signature": "t=1,v1=platform-signature",
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")
        self.assertEqual(response.json()["error"]["code"], "http_413")
        webhook_service_class.assert_not_called()

    @patch("app.api.v1.endpoints.webhooks.StripeWebhookService")
    def test_connect_webhook_rejects_oversized_chunked_body(
        self,
        webhook_service_class,
    ):
        def body_chunks():
            yield b"x" * STRIPE_WEBHOOK_REQUEST_MAX_BYTES
            yield b"x"

        response = self.client.post(
            "/api/v1/webhooks/stripe/connect",
            content=body_chunks(),
            headers={
                "Transfer-Encoding": "chunked",
                "Stripe-Signature": "t=1,v1=signature",
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")
        self.assertEqual(response.json()["error"]["code"], "http_413")
        webhook_service_class.assert_not_called()


if __name__ == "__main__":
    unittest.main()
