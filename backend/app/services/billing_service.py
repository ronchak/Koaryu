from __future__ import annotations

from typing import Optional

from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPayerCreate,
    BillingPayerAutopaySetupRequest,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanResponse,
    BillingPlanUpdate,
    BillingReconcileRequest,
    BillingReconcileResponse,
    BillingRefundCreate,
    BillingRefundResponse,
    BillingInvoiceResponse,
    BillingSystemStatusResponse,
    BillingSubscriptionResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    StudioPaymentAccountResponse,
)
from app.services.billing_autopay import BillingAutopayManager
from app.services.billing_connect_actions import BillingConnectActions
from app.services.billing_connect_accounts import BillingConnectAccountStore
from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.billing_invoices import BillingInvoiceManager
from app.services.billing_payers import BillingPayerManager
from app.services.billing_payments import BillingPaymentManager
from app.services.billing_reconciliation import BillingReconciliationService
from app.services.billing_plans import BillingPlanManager
from app.services.billing_system_status import BillingSystemStatusReporter
from app.services.billing_private_facade import BillingPrivateFacadeMixin
from app.services.billing_webhook_projection import BillingWebhookProjector
from app.services.stripe_service import StripeService


class BillingService(BillingPrivateFacadeMixin):
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()
        self._connect_account_store = BillingConnectAccountStore(
            supabase,
            settings=self.settings,
            stripe_service_cls=StripeService,
        )

    def _connect_accounts(self) -> BillingConnectAccountStore:
        self._connect_account_store.supabase = self.supabase
        self._connect_account_store.settings = self.settings
        self._connect_account_store.stripe_service_cls = StripeService
        return self._connect_account_store

    def _webhook_projector(self) -> BillingWebhookProjector:
        return BillingWebhookProjector(self, stripe_service_cls=StripeService)

    def _connect_actions(self) -> BillingConnectActions:
        return BillingConnectActions(
            self,
            self._connect_accounts(),
            stripe_service_cls=StripeService,
        )

    async def get_payment_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        return await self._connect_actions().get_payment_account(studio_id)

    async def create_connect_onboarding_link(
        self,
        studio_id: str,
        actor_id: str,
        refresh_url: Optional[str] = None,
        return_url: Optional[str] = None,
        business_entity_type: Optional[str] = None,
    ) -> BillingLinkResponse:
        return await self._connect_actions().create_onboarding_link(
            studio_id,
            actor_id,
            refresh_url=refresh_url,
            return_url=return_url,
            business_entity_type=business_entity_type,
        )

    async def sync_connect_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        return await self._connect_actions().sync_account(studio_id)

    async def reset_connect_account(self, studio_id: str, actor_id: str) -> StudioPaymentAccountResponse:
        return await self._connect_actions().reset_account(studio_id, actor_id)

    async def create_connect_dashboard_link(self, studio_id: str, actor_id: str) -> BillingLinkResponse:
        return await self._connect_actions().create_dashboard_link(studio_id, actor_id)

    async def get_system_status(self, studio_id: str) -> BillingSystemStatusResponse:
        return await BillingSystemStatusReporter(
            self.supabase,
            settings=self.settings,
            connect_accounts=self._connect_accounts(),
            payment_account_loader=self.get_payment_account,
        ).get_system_status(studio_id)

    async def reconcile_stripe_object(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingReconcileResponse:
        return await BillingReconciliationService(
            self,
            stripe_service_cls=StripeService,
        ).reconcile_stripe_object(data, studio_id, actor_id)

    def audit_connect_onboarding_started(self, studio_id: str, actor_id: str) -> None:
        self._connect_actions().audit_onboarding_started(studio_id, actor_id)

    def audit_connect_dashboard_opened(self, studio_id: str, actor_id: str) -> None:
        self._connect_actions().audit_dashboard_opened(studio_id, actor_id)

    async def list_plans(self, studio_id: str) -> list[BillingPlanResponse]:
        return await BillingPlanManager(self, stripe_service_cls=StripeService).list_plans(studio_id)

    async def create_plan(self, data: BillingPlanCreate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        return await BillingPlanManager(self, stripe_service_cls=StripeService).create_plan(data, studio_id, actor_id)

    async def update_plan(self, plan_id: str, data: BillingPlanUpdate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        return await BillingPlanManager(self, stripe_service_cls=StripeService).update_plan(plan_id, data, studio_id, actor_id)

    async def sync_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        return await BillingPlanManager(self, stripe_service_cls=StripeService).sync_plan(plan_id, studio_id, actor_id)

    async def archive_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        return await BillingPlanManager(self, stripe_service_cls=StripeService).archive_plan(plan_id, studio_id, actor_id)

    async def list_payers(self, studio_id: str) -> list[BillingPayerResponse]:
        return await BillingPayerManager(self, stripe_service_cls=StripeService).list_payers(studio_id)

    async def create_payer(self, data: BillingPayerCreate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        return await BillingPayerManager(self, stripe_service_cls=StripeService).create_payer(data, studio_id, actor_id)

    async def get_payer(self, payer_id: str, studio_id: str) -> BillingPayerResponse:
        return await BillingPayerManager(self, stripe_service_cls=StripeService).get_payer(payer_id, studio_id)

    async def update_payer(self, payer_id: str, data: BillingPayerUpdate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        return await BillingPayerManager(self, stripe_service_cls=StripeService).update_payer(
            payer_id,
            data,
            studio_id,
            actor_id,
        )

    async def sync_payer(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        return await BillingPayerManager(self, stripe_service_cls=StripeService).sync_payer(
            payer_id,
            studio_id,
            actor_id,
        )

    async def list_subscriptions(self, studio_id: str) -> list[BillingSubscriptionResponse]:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).list_subscriptions(studio_id)

    async def list_enrollments(self, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).list_enrollments(studio_id)

    async def list_student_billing(self, student_id: str, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).list_student_billing(
            student_id,
            studio_id,
        )

    async def add_student_billing_enrollment(
        self,
        data: StudentBillingEnrollmentCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).add_student_billing_enrollment(
            data,
            studio_id,
            actor_id,
        )

    async def update_enrollment(
        self,
        enrollment_id: str,
        data: StudentBillingEnrollmentUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).update_enrollment(
            enrollment_id,
            data,
            studio_id,
            actor_id,
        )

    async def set_enrollment_status(
        self,
        enrollment_id: str,
        status_value: str,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        return await BillingEnrollmentManager(self, stripe_service_cls=StripeService).set_enrollment_status(
            enrollment_id,
            status_value,
            studio_id,
            actor_id,
        )

    async def create_autopay_setup_link(
        self,
        payer_id: str,
        data: BillingPayerAutopaySetupRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingLinkResponse:
        return await BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        ).create_autopay_setup_link(payer_id, data, studio_id, actor_id)

    async def disable_autopay(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        return await BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        ).disable_autopay(payer_id, studio_id, actor_id)

    def _disable_payer_autopay_subscriptions(self, payer_id: str, studio_id: str) -> list[str]:
        return BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        )._disable_payer_autopay_subscriptions(payer_id, studio_id)

    def _mark_subscription_autopay_disable_pending(self, subscription: dict[str, Any]) -> dict[str, Any]:
        return BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        )._mark_subscription_autopay_disable_pending(subscription)

    def _disabled_autopay_subscription_fields(self, subscription: dict[str, Any]) -> dict[str, Any]:
        return BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        )._disabled_autopay_subscription_fields(subscription)

    def _connected_account_id_for_studio(self, studio_id: str) -> Optional[str]:
        return BillingAutopayManager(
            self,
            stripe_service_cls=StripeService,
        )._connected_account_id_for_studio(studio_id)

    async def list_invoices(self, studio_id: str) -> list[BillingInvoiceResponse]:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).list_invoices(studio_id)

    async def create_invoice(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).create_invoice(
            data,
            studio_id,
            actor_id,
            idempotency_key,
        )

    async def finalize_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).finalize_invoice(
            invoice_id,
            studio_id,
            actor_id,
        )

    async def retry_invoice_payment(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).retry_invoice_payment(
            invoice_id,
            studio_id,
            actor_id,
        )

    async def void_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).void_invoice(
            invoice_id,
            studio_id,
            actor_id,
        )

    async def reconcile_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        return await BillingInvoiceManager(self, stripe_service_cls=StripeService).reconcile_invoice(
            invoice_id,
            studio_id,
            actor_id,
        )

    async def list_payments(self, studio_id: str) -> list[BillingPaymentResponse]:
        return await BillingPaymentManager(self, stripe_service_cls=StripeService).list_payments(studio_id)

    async def record_external_payment(
        self,
        data: ExternalPaymentCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> BillingPaymentResponse:
        return await BillingPaymentManager(self, stripe_service_cls=StripeService).record_external_payment(
            data,
            studio_id,
            actor_id,
            idempotency_key,
        )

    async def refund_payment(
        self,
        payment_id: str,
        data: BillingRefundCreate,
        studio_id: str,
        actor_id: str,
    ) -> BillingRefundResponse:
        return await BillingPaymentManager(self, stripe_service_cls=StripeService).refund_payment(
            payment_id,
            data,
            studio_id,
            actor_id,
        )

    async def create_export_job(self, data: ExportJobCreate, studio_id: str, actor_id: str) -> ExportJobResponse:
        return await BillingPaymentManager(self, stripe_service_cls=StripeService).create_export_job(
            data,
            studio_id,
            actor_id,
        )

    async def get_export_job(self, export_id: str, studio_id: str) -> ExportJobResponse:
        return await BillingPaymentManager(self, stripe_service_cls=StripeService).get_export_job(export_id, studio_id)
