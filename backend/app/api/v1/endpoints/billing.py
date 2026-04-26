from typing import Optional

from fastapi import APIRouter, Depends
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.billing import (
    BillingActionRequest,
    BillingInvoiceResponse,
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPayerCreate,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanResponse,
    BillingPlanUpdate,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudioPaymentAccountResponse,
)
from app.services.billing_service import BillingService
from app.services.studio_scope import (
    resolve_billing_admin_staff_role_for_user,
    resolve_billing_manager_staff_role_for_user,
)

router = APIRouter(prefix="/billing", tags=["billing"])


def _admin_studio_id(supabase: Client, user_id: str, requested_studio_id: Optional[str]) -> str:
    return resolve_billing_admin_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]


def _manager_studio_id(supabase: Client, user_id: str, requested_studio_id: Optional[str]) -> str:
    return resolve_billing_manager_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]


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
    data: BillingActionRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).create_connect_onboarding_link(
        studio_id,
        user_id,
        data.refresh_url,
        data.return_url,
    )


@router.post("/connect/dashboard-link", response_model=BillingLinkResponse)
async def create_connect_dashboard_link(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).create_connect_dashboard_link(studio_id, user_id)


@router.get("/plans", response_model=list[BillingPlanResponse])
async def list_plans(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).list_plans(studio_id)


@router.post("/plans", response_model=BillingPlanResponse, status_code=201)
async def create_plan(
    data: BillingPlanCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).create_plan(data, studio_id, user_id)


@router.patch("/plans/{plan_id}", response_model=BillingPlanResponse)
async def update_plan(
    plan_id: str,
    data: BillingPlanUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).update_plan(plan_id, data, studio_id, user_id)


@router.post("/plans/{plan_id}/archive", response_model=BillingPlanResponse)
async def archive_plan(
    plan_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).archive_plan(plan_id, studio_id, user_id)


@router.get("/payers", response_model=list[BillingPayerResponse])
async def list_payers(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).list_payers(studio_id)


@router.post("/payers", response_model=BillingPayerResponse, status_code=201)
async def create_payer(
    data: BillingPayerCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).create_payer(data, studio_id, user_id)


@router.get("/payers/{payer_id}", response_model=BillingPayerResponse)
async def get_payer(
    payer_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).get_payer(payer_id, studio_id)


@router.patch("/payers/{payer_id}", response_model=BillingPayerResponse)
async def update_payer(
    payer_id: str,
    data: BillingPayerUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).update_payer(payer_id, data, studio_id, user_id)


@router.get("/invoices", response_model=list[BillingInvoiceResponse])
async def list_invoices(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).list_invoices(studio_id)


@router.get("/payments", response_model=list[BillingPaymentResponse])
async def list_payments(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).list_payments(studio_id)


@router.post("/payments/external", response_model=BillingPaymentResponse, status_code=201)
async def record_external_payment(
    data: ExternalPaymentCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).record_external_payment(data, studio_id, user_id)


@router.post("/exports", response_model=ExportJobResponse, status_code=202)
async def create_export_job(
    data: ExportJobCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).create_export_job(data, studio_id, user_id)


@router.get("/exports/{export_id}", response_model=ExportJobResponse)
async def get_export_job(
    export_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _manager_studio_id(supabase, user_id, requested_studio_id)
    return await BillingService(supabase).get_export_job(export_id, studio_id)
