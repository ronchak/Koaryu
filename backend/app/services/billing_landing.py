"""Compose independently bounded status and totals without widening access."""
import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import TypeVar

from fastapi import HTTPException
from supabase import Client

from app.core.deps import ProviderDependency, run_supabase_operation
from app.schemas.billing import BillingLandingResponse, BillingLandingAggregatesResponse
from app.services.billing_service import BillingService
from app.services.platform_billing_service import PlatformBillingService
from app.services.studio_scope import get_platform_subscription_access
from app.services.supabase_rpc import execute_required_rpc


BILLING_LANDING_REQUEST_TIMEOUT_SECONDS = 30.0
ProjectionT = TypeVar("ProjectionT")


def payment_cohort_period(as_of: datetime | None = None) -> tuple[datetime, datetime]:
    observed = as_of or datetime.now(timezone.utc)
    if observed.tzinfo is None:
        observed = observed.replace(tzinfo=timezone.utc)
    start = observed.astimezone(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


async def _diagnostics(client: Client, studio_id: str, role: str):
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
    return system_status, payment_account, errors


def _financials(client: Client, studio_id: str, observed: datetime):
    errors = []
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
    return financial_access, aggregates, errors


async def _bounded_projection(
    provider: ProviderDependency,
    operation: Callable[[Client], ProjectionT | Awaitable[ProjectionT]],
    deadline: float,
) -> ProjectionT:
    # Cancel only this caller's wait. The existing runtime owns the source future,
    # its thread-affine client and its capacity slot until provider work finishes.
    if deadline <= asyncio.get_running_loop().time():
        raise TimeoutError("Billing landing request deadline expired.")
    async with asyncio.timeout_at(deadline):
        return await run_supabase_operation(provider, operation, lane="interactive")


async def get_billing_landing(
    provider: ProviderDependency,
    membership: dict,
    *,
    deadline: float | None = None,
) -> BillingLandingResponse:
    studio_id = membership["studio_id"]
    role = membership["role"]
    observed = datetime.now(timezone.utc)
    if deadline is None:
        deadline = asyncio.get_running_loop().time() + BILLING_LANDING_REQUEST_TIMEOUT_SECONDS

    # Each operation receives its owning worker's client, never the membership
    # worker's client. Submit independent recovery/financial work before diagnostics.
    operations = [lambda client: _financials(client, studio_id, observed)]
    if role == "admin":
        operations.append(lambda client: PlatformBillingService(client).get_status(studio_id))
    operations.append(lambda client: _diagnostics(client, studio_id, role))
    results = await asyncio.gather(
        *(_bounded_projection(provider, operation, deadline) for operation in operations),
        return_exceptions=True,
    )
    financial_result = results[0]
    diagnostic_result = results[-1]
    platform_result = results[1] if role == "admin" else None

    if isinstance(diagnostic_result, BaseException):
        system_status, payment_account = None, None
        errors = ["Billing system diagnostics are unavailable.", "Stripe account status is unavailable."]
    else:
        system_status, payment_account, errors = diagnostic_result
    if isinstance(platform_result, BaseException):
        platform_status = None
        errors.append("Platform subscription status is unavailable.")
    else:
        platform_status = platform_result
    if isinstance(financial_result, BaseException):
        financial_access, aggregates = "unavailable", None
        errors.append("Financial access could not be verified.")
    else:
        financial_access, aggregates, financial_errors = financial_result
        errors.extend(financial_errors)

    return BillingLandingResponse(
        studio_id=studio_id, observed_at=observed.isoformat(), system_status=system_status,
        payment_account=payment_account, platform_status=platform_status, financial_access=financial_access, aggregates=aggregates, errors=errors,
    )
