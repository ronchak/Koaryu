from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingInvoiceResponse,
    BillingLinkResponse,
    BillingPaymentResponse,
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
)

router = APIRouter(prefix="/billing", tags=["billing"])


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


@router.get("/connect/status", response_model=StudioPaymentAccountResponse)
async def get_connect_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).get_payment_account(studio_id)


@router.post("/connect/onboarding-link", response_model=BillingLinkResponse)
async def create_connect_onboarding_link(
    data: ConnectOnboardingLinkRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    service = BillingService(supabase)
    link = await service.create_connect_onboarding_link(
        studio_id,
        user_id,
        data.refresh_url,
        data.return_url,
        data.business_entity_type,
    )
    background_tasks.add_task(service.audit_connect_onboarding_started, studio_id, user_id)
    return link


@router.post("/connect/sync", response_model=StudioPaymentAccountResponse)
async def sync_connect_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).sync_connect_account(studio_id)


@router.post("/connect/reset", response_model=StudioPaymentAccountResponse)
async def reset_connect_account(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).reset_connect_account(studio_id, user_id)


@router.post("/connect/dashboard-link", response_model=BillingLinkResponse)
async def create_connect_dashboard_link(
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    service = BillingService(supabase)
    link = await service.create_connect_dashboard_link(studio_id, user_id)
    background_tasks.add_task(service.audit_connect_dashboard_opened, studio_id, user_id)
    return link


@router.get("/system/status", response_model=BillingSystemStatusResponse)
async def get_billing_system_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).get_system_status(studio_id)


@router.post("/reconcile", response_model=BillingReconcileResponse)
async def reconcile_billing_from_stripe(
    data: BillingReconcileRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).reconcile_stripe_object(data, studio_id, user_id)


@router.get("/plans", response_model=list[BillingPlanResponse])
async def list_plans(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_plans(studio_id)


@router.post("/plans", response_model=BillingPlanResponse, status_code=201)
async def create_plan(
    data: BillingPlanCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).create_plan(data, studio_id, user_id)


@router.patch("/plans/{plan_id}", response_model=BillingPlanResponse)
async def update_plan(
    plan_id: str,
    data: BillingPlanUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).update_plan(plan_id, data, studio_id, user_id)


@router.post("/plans/{plan_id}/archive", response_model=BillingPlanResponse)
async def archive_plan(
    plan_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).archive_plan(plan_id, studio_id, user_id)


@router.post("/plans/{plan_id}/sync", response_model=BillingPlanResponse)
async def sync_plan(
    plan_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).sync_plan(plan_id, studio_id, user_id)


@router.get("/payers", response_model=list[BillingPayerResponse])
async def list_payers(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_payers(studio_id)


@router.post("/payers", response_model=BillingPayerResponse, status_code=201)
async def create_payer(
    data: BillingPayerCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).create_payer(data, studio_id, user_id)


@router.get("/payers/{payer_id}", response_model=BillingPayerResponse)
async def get_payer(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).get_payer(payer_id, studio_id)


@router.patch("/payers/{payer_id}", response_model=BillingPayerResponse)
async def update_payer(
    payer_id: str,
    data: BillingPayerUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).update_payer(payer_id, data, studio_id, user_id)


@router.post("/payers/{payer_id}/sync", response_model=BillingPayerResponse)
async def sync_payer(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).sync_payer(payer_id, studio_id, user_id)


@router.post("/payers/{payer_id}/autopay/setup-link", response_model=BillingLinkResponse)
async def create_autopay_setup_link(
    payer_id: str,
    data: BillingPayerAutopaySetupRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).create_autopay_setup_link(payer_id, data, studio_id, user_id)


@router.post("/payers/{payer_id}/autopay/disable", response_model=BillingPayerResponse)
async def disable_autopay(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).disable_autopay(payer_id, studio_id, user_id)


@router.get("/subscriptions", response_model=list[BillingSubscriptionResponse])
async def list_subscriptions(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_subscriptions(studio_id)


@router.get("/enrollments", response_model=list[StudentBillingEnrollmentResponse])
async def list_enrollments(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_enrollments(studio_id)


@router.post("/enrollments", response_model=StudentBillingEnrollmentResponse, status_code=201)
async def create_enrollment(
    data: StudentBillingEnrollmentCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).add_student_billing_enrollment(data, studio_id, user_id)


@router.patch("/enrollments/{enrollment_id}", response_model=StudentBillingEnrollmentResponse)
async def update_enrollment(
    enrollment_id: str,
    data: StudentBillingEnrollmentUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).update_enrollment(enrollment_id, data, studio_id, user_id)


@router.post("/enrollments/{enrollment_id}/pause", response_model=StudentBillingEnrollmentResponse)
async def pause_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).set_enrollment_status(enrollment_id, "paused", studio_id, user_id)


@router.post("/enrollments/{enrollment_id}/resume", response_model=StudentBillingEnrollmentResponse)
async def resume_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).set_enrollment_status(enrollment_id, "active", studio_id, user_id)


@router.post("/enrollments/{enrollment_id}/cancel", response_model=StudentBillingEnrollmentResponse)
async def cancel_enrollment(
    enrollment_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).set_enrollment_status(enrollment_id, "canceled", studio_id, user_id)


@router.get("/invoices", response_model=list[BillingInvoiceResponse])
async def list_invoices(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_invoices(studio_id)


@router.post("/invoices", response_model=BillingInvoiceResponse, status_code=201)
async def create_invoice(
    data: BillingInvoiceCreate,
    request_idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).create_invoice(data, studio_id, user_id, request_idempotency_key)


@router.post("/invoices/{invoice_id}/finalize", response_model=BillingInvoiceResponse)
async def finalize_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).finalize_invoice(invoice_id, studio_id, user_id)


@router.post("/invoices/{invoice_id}/retry", response_model=BillingInvoiceResponse)
async def retry_invoice_payment(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).retry_invoice_payment(invoice_id, studio_id, user_id)


@router.post("/invoices/{invoice_id}/void", response_model=BillingInvoiceResponse)
async def void_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).void_invoice(invoice_id, studio_id, user_id)


@router.post("/invoices/{invoice_id}/reconcile", response_model=BillingInvoiceResponse)
async def reconcile_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).reconcile_invoice(invoice_id, studio_id, user_id)


@router.get("/payments", response_model=list[BillingPaymentResponse])
async def list_payments(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).list_payments(studio_id)


@router.post("/payments/external", response_model=BillingPaymentResponse, status_code=201)
async def record_external_payment(
    data: ExternalPaymentCreate,
    request_idempotency_key: str = Header(..., alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).record_external_payment(
        data,
        studio_id,
        user_id,
        request_idempotency_key,
    )


@router.post("/payments/{payment_id}/refund", response_model=BillingRefundResponse)
async def refund_payment(
    payment_id: str,
    data: BillingRefundCreate,
    request_idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id, require_platform_subscription=True)
    return await BillingService(supabase).refund_payment(
        payment_id,
        data,
        studio_id,
        user_id,
        request_idempotency_key,
    )


@router.post("/exports", response_model=ExportJobResponse, status_code=202)
async def create_export_job(
    data: ExportJobCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).create_export_job(data, studio_id, user_id)


@router.get("/exports/{export_id}", response_model=ExportJobResponse)
async def get_export_job(
    export_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return await BillingService(supabase).get_export_job(export_id, studio_id)
