"""Compose status and complete totals without broadening their individual access rules."""
from datetime import datetime, timezone

from fastapi import HTTPException

from app.schemas.billing import BillingLandingResponse, BillingLandingAggregatesResponse
from app.services.billing_service import BillingService
from app.services.platform_billing_service import PlatformBillingService
from app.services.studio_scope import get_platform_subscription_access
from app.services.supabase_rpc import execute_required_rpc


def payment_cohort_period(as_of: datetime | None = None) -> tuple[datetime, datetime]:
    observed = as_of or datetime.now(timezone.utc)
    if observed.tzinfo is None:
        observed = observed.replace(tzinfo=timezone.utc)
    start = observed.astimezone(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


async def get_billing_landing(client, membership: dict) -> BillingLandingResponse:
    studio_id = membership["studio_id"]
    role = membership["role"]
    observed = datetime.now(timezone.utc)
    # The reporter owns Connect refresh and its stored-state fallback. Reuse its result.
    errors = []
    system_status = None
    payment_account = None
    service = BillingService(client)
    try:
        system_status = await service.get_system_status(studio_id, role)
        payment_account = system_status.payment_account
    except Exception:
        errors.append("Billing system diagnostics are unavailable.")
        try:
            payment_account = await service.get_payment_account(studio_id)
        except Exception:
            errors.append("Stripe account status is unavailable.")
    platform_status = None
    if role == "admin":
        try:
            platform_status = await PlatformBillingService(client).get_status(studio_id)
        except Exception:
            errors.append("Platform subscription status is unavailable.")
    try:
        access = get_platform_subscription_access(client, studio_id)
        financial_access = "subscription_required" if access["subscription_required"] else "available"
    except HTTPException:
        financial_access = "unavailable"
        errors.append("Financial access could not be verified.")
    aggregates = None
    if financial_access == "available":
        start, end = payment_cohort_period(observed)
        try:
            result = execute_required_rpc(client, "billing_landing_aggregates", {
                "p_studio_id": studio_id, "p_period_start": start.isoformat(), "p_period_end": end.isoformat(),
            })
            aggregates = BillingLandingAggregatesResponse.model_validate(result.data)
        except Exception:
            financial_access = "unavailable"
            errors.append("Financial totals are unavailable.")
    return BillingLandingResponse(
        studio_id=studio_id, observed_at=observed.isoformat(), system_status=system_status,
        payment_account=payment_account, platform_status=platform_status, financial_access=financial_access, aggregates=aggregates, errors=errors,
    )
