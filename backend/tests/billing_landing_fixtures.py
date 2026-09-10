from app.schemas.billing import (
    BillingSystemStatusResponse,
    BillingWebhookHealthResponse,
    StudioPaymentAccountResponse,
)


def billing_system_status() -> BillingSystemStatusResponse:
    return BillingSystemStatusResponse(
        studio_id="studio",
        configured_stripe_mode="test",
        ready_for_configured_mode=True,
        live_payments_authorized=False,
        ready_for_live_payments=False,
        checked_at="2026-12-31T00:00:00Z",
        payment_account=StudioPaymentAccountResponse(studio_id="studio"),
        mutation_capabilities={},
        platform_webhooks=BillingWebhookHealthResponse(),
        connect_webhooks=BillingWebhookHealthResponse(),
        checks=[],
    )
