import inspect
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Response, status
from supabase import Client

from app.core.deps import ProviderDependency, get_current_user_id, get_requested_studio_id, get_supabase, run_supabase_operation
from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingInvoiceResponse,
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPaymentCohortSummaryResponse,
    BillingPayerAutopaySetupRequest,
    BillingPayerCreate,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanResponse,
    BillingPlanUpdate,
    BillingReconcileRequest,
    BillingReconcileResponse,
    BillingRefundCreate,
    BillingRefundResponse,
    BillingSystemStatusResponse,
    BillingSubscriptionResponse,
    ConnectOnboardingDeliveryAckRequest,
    ConnectOnboardingDeliveryAckResponse,
    ConnectOnboardingLinkResponse,
    ConnectOnboardingLinkRequest,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    StudioPaymentAccountResponse,
)
from app.services.billing_service import BillingService
from app.services.studio_scope import (
    resolve_billing_admin_staff_role_for_user,
    resolve_billing_manager_staff_role_for_user,
    resolve_billing_routine_write_staff_role_for_user,
)

router = APIRouter(prefix="/billing", tags=["billing"])

EXTERNAL_ENROLLMENT_ONLY_DETAIL = (
    "Billing attachments currently support external collection only."
)
PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL = (
    "External payments must currently target one payer, not an invoice."
)


async def _audit_billing_action(
    provider: ProviderDependency,
    method_name: str,
    studio_id: str,
    actor_id: str,
) -> None:
    async def _provider_operation(client):
        service = BillingService(client)
        result = getattr(service, method_name)(studio_id, actor_id)
        if inspect.isawaitable(result):
            await result

    await run_supabase_operation(provider, _provider_operation)


def _admin_studio_id(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
    *,
    require_platform_subscription: bool = False,
) -> str:
    return resolve_billing_admin_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )["studio_id"]


def _manager_studio_id(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
    *,
    require_platform_subscription: bool = False,
) -> str:
    return resolve_billing_manager_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )["studio_id"]


def _routine_studio_id(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
    *,
    require_platform_subscription: bool = False,
) -> str:
    return resolve_billing_routine_write_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )["studio_id"]


@router.get("/connect/status", response_model=StudioPaymentAccountResponse)
async def get_connect_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(client, user_id, requested_studio_id)
        return await BillingService(client).get_payment_account(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/connect/onboarding-link", response_model=ConnectOnboardingLinkResponse)
async def create_connect_onboarding_link(
    data: ConnectOnboardingLinkRequest,
    background_tasks: BackgroundTasks,
    response: Response,
    request_idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    response.headers["Cache-Control"] = "no-store"
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        link = await BillingService(client).create_connect_onboarding_link(
            studio_id, user_id, data.refresh_url, data.return_url,
            data.business_entity_type, request_idempotency_key,
        )
        return link, studio_id
    link, studio_id = await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
    background_tasks.add_task(
        _audit_billing_action,
        supabase,
        "audit_connect_onboarding_started",
        studio_id,
        user_id,
    )
    return link


@router.post(
    "/connect/onboarding-link/acknowledge",
    response_model=ConnectOnboardingDeliveryAckResponse,
)
async def acknowledge_connect_onboarding_link_delivery(
    data: ConnectOnboardingDeliveryAckRequest,
    response: Response,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    response.headers["Cache-Control"] = "no-store"

    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        return await BillingService(client).acknowledge_connect_onboarding_link_delivery(
            studio_id,
            data.receipt,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/connect/sync", response_model=StudioPaymentAccountResponse)
async def sync_connect_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        return await BillingService(client).sync_connect_account(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/connect/reset", response_model=StudioPaymentAccountResponse)
async def reset_connect_account(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        return await BillingService(client).reset_connect_account(studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/connect/dashboard-link", response_model=BillingLinkResponse)
async def create_connect_dashboard_link(
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):

    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        service = BillingService(client)
        link = await service.create_connect_dashboard_link(studio_id, user_id)
        return link, studio_id
    link, studio_id = await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
    background_tasks.add_task(
        _audit_billing_action,
        supabase,
        "audit_connect_dashboard_opened",
        studio_id,
        user_id,
    )
    return link


@router.get("/system/status", response_model=BillingSystemStatusResponse)
async def get_billing_system_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id)
        return await BillingService(client).get_system_status(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/reconcile", response_model=BillingReconcileResponse)
async def reconcile_billing_from_stripe(
    data: BillingReconcileRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).reconcile_stripe_object(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/plans", response_model=list[BillingPlanResponse])
async def list_plans(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_plans(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/plans", response_model=BillingPlanResponse, status_code=201)
async def create_plan(
    data: BillingPlanCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).create_plan(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/plans/{plan_id}", response_model=BillingPlanResponse)
async def update_plan(
    plan_id: str,
    data: BillingPlanUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).update_plan(plan_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/plans/{plan_id}/archive", response_model=BillingPlanResponse)
async def archive_plan(
    plan_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).archive_plan(plan_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/plans/{plan_id}/sync", response_model=BillingPlanResponse)
async def sync_plan(
    plan_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).sync_plan(plan_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/payers", response_model=list[BillingPayerResponse])
async def list_payers(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_payers(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payers", response_model=BillingPayerResponse, status_code=201)
async def create_payer(
    data: BillingPayerCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).create_payer(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/payers/{payer_id}", response_model=BillingPayerResponse)
async def get_payer(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).get_payer(payer_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/payers/{payer_id}", response_model=BillingPayerResponse)
async def update_payer(
    payer_id: str,
    data: BillingPayerUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).update_payer(payer_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payers/{payer_id}/sync", response_model=BillingPayerResponse)
async def sync_payer(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).sync_payer(payer_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payers/{payer_id}/autopay/setup-link", response_model=BillingLinkResponse)
async def create_autopay_setup_link(
    payer_id: str,
    data: BillingPayerAutopaySetupRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).create_autopay_setup_link(payer_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payers/{payer_id}/autopay/disable", response_model=BillingPayerResponse)
async def disable_autopay(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).disable_autopay(payer_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/subscriptions", response_model=list[BillingSubscriptionResponse])
async def list_subscriptions(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_subscriptions(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/enrollments", response_model=list[StudentBillingEnrollmentResponse])
async def list_enrollments(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_enrollments(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/enrollments", response_model=StudentBillingEnrollmentResponse, status_code=201)
async def create_enrollment(
    data: StudentBillingEnrollmentCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _routine_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        if data.collection_mode != "external":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=EXTERNAL_ENROLLMENT_ONLY_DETAIL,
            )
        return await BillingService(client).add_student_billing_enrollment(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/enrollments/{enrollment_id}", response_model=StudentBillingEnrollmentResponse)
async def update_enrollment(
    enrollment_id: str,
    data: StudentBillingEnrollmentUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).update_enrollment(enrollment_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/enrollments/{enrollment_id}/pause", response_model=StudentBillingEnrollmentResponse)
async def pause_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).set_enrollment_status(enrollment_id, "paused", studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/enrollments/{enrollment_id}/resume", response_model=StudentBillingEnrollmentResponse)
async def resume_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).set_enrollment_status(enrollment_id, "active", studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/enrollments/{enrollment_id}/cancel", response_model=StudentBillingEnrollmentResponse)
async def cancel_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).set_enrollment_status(enrollment_id, "canceled", studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/invoices", response_model=list[BillingInvoiceResponse])
async def list_invoices(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_invoices(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/invoices", response_model=BillingInvoiceResponse, status_code=201)
async def create_invoice(
    data: BillingInvoiceCreate,
    request_idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).create_invoice(data, studio_id, user_id, request_idempotency_key)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/invoices/{invoice_id}/finalize", response_model=BillingInvoiceResponse)
async def finalize_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).finalize_invoice(invoice_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/invoices/{invoice_id}/retry", response_model=BillingInvoiceResponse)
async def retry_invoice_payment(
    invoice_id: str,
    request_idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=1,
        max_length=255,
    ),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).retry_invoice_payment(
            invoice_id,
            studio_id,
            user_id,
            request_idempotency_key,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/invoices/{invoice_id}/void", response_model=BillingInvoiceResponse)
async def void_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).void_invoice(invoice_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/invoices/{invoice_id}/reconcile", response_model=BillingInvoiceResponse)
async def reconcile_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _routine_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).reconcile_invoice(invoice_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/payments", response_model=list[BillingPaymentResponse])
async def list_payments(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).list_payments(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/payments/current-month-cohort", response_model=BillingPaymentCohortSummaryResponse)
async def get_current_month_payment_cohort_summary(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _manager_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).current_month_payment_cohort_summary(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payments/external", response_model=BillingPaymentResponse, status_code=201)
async def record_external_payment(
    data: ExternalPaymentCreate,
    request_idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _routine_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        if not data.payer_id or data.invoice_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL,
            )
        return await BillingService(client).record_external_payment(
            data,
            studio_id,
            user_id,
            request_idempotency_key,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/payments/{payment_id}/refund", response_model=BillingRefundResponse)
async def refund_payment(
    payment_id: str,
    data: BillingRefundCreate,
    request_idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(client, user_id, requested_studio_id, require_platform_subscription=True)
        return await BillingService(client).refund_payment(
            payment_id,
            data,
            studio_id,
            user_id,
            request_idempotency_key,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/exports", response_model=ExportJobResponse, status_code=202)
async def create_export_job(
    data: ExportJobCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).create_export_job(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/exports/{export_id}", response_model=ExportJobResponse)
async def get_export_job(
    export_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _admin_studio_id(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await BillingService(client).get_export_job(export_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
