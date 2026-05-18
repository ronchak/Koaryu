from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingDisputeResponse,
    BillingInvoiceCreate,
    BillingLinkResponse,
    BillingPaymentResponse,
    BillingPayerCreate,
    BillingPayerAutopaySetupRequest,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanProgramResponse,
    BillingPlanResponse,
    BillingPlanUpdate,
    BillingReconcileRequest,
    BillingReconcileResponse,
    BillingRefundCreate,
    BillingRefundResponse,
    BillingInvoiceResponse,
    BillingSystemCheck,
    BillingSystemStatusResponse,
    BillingWebhookHealthResponse,
    BillingSubscriptionResponse,
    ExportJobCreate,
    ExportJobResponse,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    StudioPaymentAccountResponse,
)
from app.services.stripe_service import StripeService


CONNECT_STATUS_STALE_AFTER = timedelta(minutes=15)
BILLING_WEBHOOK_PROCESSING_STALE_AFTER = timedelta(minutes=10)


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _stripe_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("id")
    return getattr(value, "id", None)


def _object_get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


class BillingService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    async def get_payment_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        account = self._ensure_payment_account_row(studio_id)
        if self._should_refresh_connect_account(account):
            account = self._refresh_connect_account_status(account, strict=False)
        return self._payment_account_response(account)

    async def create_connect_onboarding_link(
        self,
        studio_id: str,
        actor_id: str,
        refresh_url: Optional[str] = None,
        return_url: Optional[str] = None,
        business_entity_type: Optional[str] = None,
    ) -> BillingLinkResponse:
        account = self._ensure_payment_account_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        stripe_service = StripeService()

        if not stripe_account_id:
            if business_entity_type not in {"company", "individual"}:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Choose whether this Stripe account is for a company or a sole proprietor.",
                )
            studio = self._get_studio(studio_id)
            account_generation = int((account.get("metadata") or {}).get("connect_account_generation") or 1)
            stripe_account = stripe_service.create_connect_account(
                studio_id=studio_id,
                business_name=studio.get("name") or "Koaryu studio",
                contact_email=self._get_user_email(actor_id) or self._get_user_email(studio.get("owner_id")),
                business_entity_type=business_entity_type,
                account_generation=account_generation,
            )
            stripe_account_id = stripe_account["id"] if isinstance(stripe_account, dict) else stripe_account.id
            metadata = dict(account.get("metadata") or {})
            metadata["business_entity_type"] = business_entity_type
            account = self._update_payment_account(studio_id, {
                "stripe_connected_account_id": stripe_account_id,
                "status": "onboarding_incomplete",
                "metadata": metadata,
            })

        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        link = stripe_service.create_connect_onboarding_link(
            account_id=stripe_account_id,
            refresh_url=refresh_url or f"{frontend_url}/billing/connect/refresh",
            return_url=return_url or f"{frontend_url}/billing?connect=return",
        )
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

    async def sync_connect_account(self, studio_id: str) -> StudioPaymentAccountResponse:
        account = self._ensure_payment_account_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before syncing the account status.")

        account = self._refresh_connect_account_status(account, strict=True)
        return self._payment_account_response(account)

    async def reset_connect_account(self, studio_id: str, actor_id: str) -> StudioPaymentAccountResponse:
        account = self._ensure_payment_account_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        if not stripe_account_id:
            return self._payment_account_response(account)
        if self._has_stripe_billing_history(studio_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Reconnect requires support because this studio already has Stripe billing history.",
            )

        metadata = dict(account.get("metadata") or {})
        previous_accounts = list(metadata.get("previous_stripe_connected_account_ids") or [])
        previous_accounts.append(stripe_account_id)
        metadata["previous_stripe_connected_account_ids"] = list(dict.fromkeys(previous_accounts))
        metadata["connect_account_generation"] = int(metadata.get("connect_account_generation") or 1) + 1
        account = self._update_payment_account(studio_id, {
            "stripe_connected_account_id": None,
            "status": "not_connected",
            "charges_enabled": False,
            "payouts_enabled": False,
            "details_submitted": False,
            "requirements_due": [],
            "metadata": metadata,
        })
        self._audit(studio_id, actor_id, "billing.connect_account_reset", studio_id, {
            "previous_stripe_account_id": stripe_account_id,
        })
        return self._payment_account_response(account)

    async def create_connect_dashboard_link(self, studio_id: str, actor_id: str) -> BillingLinkResponse:
        account = self._ensure_payment_account_row(studio_id)
        stripe_account_id = account.get("stripe_connected_account_id")
        if not stripe_account_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before opening the Stripe dashboard.")
        url = StripeService().create_connect_dashboard_url(account_id=stripe_account_id)
        return BillingLinkResponse(url=url)

    async def get_system_status(self, studio_id: str) -> BillingSystemStatusResponse:
        checked_at = datetime.now(timezone.utc).isoformat()
        checks: list[BillingSystemCheck] = []

        def add_check(name: str, passed: bool, detail: str, *, warn: bool = False) -> None:
            checks.append(BillingSystemCheck(
                name=name,
                status="pass" if passed else ("warn" if warn else "fail"),
                detail=detail,
            ))

        add_check(
            "Stripe API key",
            bool(getattr(self.settings, "STRIPE_SECRET_KEY", "")),
            "Stripe API key is configured." if getattr(self.settings, "STRIPE_SECRET_KEY", "") else "STRIPE_SECRET_KEY is missing.",
        )
        add_check(
            "Koaryu Core price",
            bool(getattr(self.settings, "STRIPE_KOARYU_CORE_PRICE_ID", "")),
            "Koaryu Core price ID is configured." if getattr(self.settings, "STRIPE_KOARYU_CORE_PRICE_ID", "") else "STRIPE_KOARYU_CORE_PRICE_ID is missing.",
        )
        add_check(
            "Platform webhook secret",
            bool(getattr(self.settings, "STRIPE_PLATFORM_WEBHOOK_SECRET", "")),
            "Platform webhook signature secret is configured." if getattr(self.settings, "STRIPE_PLATFORM_WEBHOOK_SECRET", "") else "STRIPE_PLATFORM_WEBHOOK_SECRET is missing.",
        )
        add_check(
            "Connect webhook secret",
            bool(getattr(self.settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "")),
            "Connect webhook signature secret is configured." if getattr(self.settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "") else "STRIPE_CONNECT_WEBHOOK_SECRET is missing.",
        )

        try:
            account_response = await self.get_payment_account(studio_id)
            account_failed = False
        except Exception as exc:
            account_failed = True
            account_row = self._ensure_payment_account_row(studio_id)
            account_response = self._payment_account_response(account_row)
            add_check("Connect account refresh", False, f"Could not refresh Stripe Connect account: {exc}")

        if not account_failed:
            add_check(
                "Connect account",
                bool(account_response.stripe_connected_account_id),
                "Stripe Connect account exists." if account_response.stripe_connected_account_id else "Studio has not connected Stripe Payments.",
            )
            add_check(
                "Connect charges",
                account_response.charges_enabled,
                "Connected account can accept charges." if account_response.charges_enabled else "Connected account cannot accept charges yet.",
            )
            add_check(
                "Connect payouts",
                account_response.payouts_enabled,
                "Connected account payouts are enabled." if account_response.payouts_enabled else "Connected account payouts are not enabled yet.",
                warn=account_response.charges_enabled,
            )
            add_check(
                "Connect requirements",
                not account_response.requirements_due,
                "No currently due Connect requirements." if not account_response.requirements_due else "Connect has currently due requirements: " + ", ".join(account_response.requirements_due),
            )

        try:
            self.supabase.table("studio_payment_accounts").select("studio_id").eq("studio_id", studio_id).limit(1).execute()
            add_check("Supabase write path", True, "Supabase billing tables are reachable.")
        except Exception as exc:
            add_check("Supabase write path", False, f"Supabase billing tables are not reachable: {exc}")

        platform_webhooks = self._webhook_health(None)
        connect_webhooks = self._webhook_health(account_response.stripe_connected_account_id)

        add_check(
            "Platform webhook processing",
            platform_webhooks.failed_count == 0 and platform_webhooks.stale_processing_count == 0,
            "No failed or stale platform webhook events found." if platform_webhooks.failed_count == 0 and platform_webhooks.stale_processing_count == 0 else "Platform webhook failures or stale processing rows need review.",
        )
        add_check(
            "Connect webhook processing",
            connect_webhooks.failed_count == 0 and connect_webhooks.stale_processing_count == 0,
            "No failed or stale Connect webhook events found." if connect_webhooks.failed_count == 0 and connect_webhooks.stale_processing_count == 0 else "Connect webhook failures or stale processing rows need review.",
        )
        add_check(
            "Recent Connect webhook",
            bool(connect_webhooks.latest_processed_at),
            "A Connect webhook has processed for this account." if connect_webhooks.latest_processed_at else "No processed Connect webhook row is visible for this account yet.",
            warn=True,
        )

        ready = all(check.status == "pass" for check in checks if check.name != "Recent Connect webhook")
        return BillingSystemStatusResponse(
            studio_id=studio_id,
            ready_for_live_payments=ready,
            checked_at=checked_at,
            payment_account=account_response,
            platform_webhooks=platform_webhooks,
            connect_webhooks=connect_webhooks,
            checks=checks,
        )

    async def reconcile_stripe_object(
        self,
        data: BillingReconcileRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingReconcileResponse:
        if data.object_type == "connect_account":
            account = await self.sync_connect_account(studio_id)
            self._audit(studio_id, actor_id, "billing.reconcile_connect_account", studio_id, {
                "stripe_account_id": account.stripe_connected_account_id,
            })
            return BillingReconcileResponse(
                object_type=data.object_type,
                stripe_object_id=account.stripe_connected_account_id,
                local_object_id=studio_id,
                status=account.status,
                detail="Connect account status was refreshed from Stripe.",
            )

        if data.object_type == "payer":
            if not data.payer_id:
                raise HTTPException(status_code=400, detail="payer_id is required to reconcile a payer.")
            payer = await self.sync_payer(data.payer_id, studio_id, actor_id)
            return BillingReconcileResponse(
                object_type=data.object_type,
                stripe_object_id=payer.stripe_customer_id,
                local_object_id=payer.id,
                status=payer.billing_status,
                detail="Payer customer and default payment method were refreshed from Stripe.",
            )

        if not data.stripe_object_id:
            raise HTTPException(status_code=400, detail="stripe_object_id is required for this reconciliation.")
        account = self._ensure_connect_ready(studio_id)
        account_id = account["stripe_connected_account_id"]
        stripe_service = StripeService()

        if data.object_type == "invoice":
            stripe_invoice = stripe_service.retrieve_connected_invoice(
                account_id=account_id,
                invoice_id=data.stripe_object_id,
                expand=["payment_intent"],
            )
            invoice = self._stripe_object_to_dict(stripe_invoice)
            stored_invoice = self._stored_stripe_event_object(
                account_id,
                data.stripe_object_id,
                ["invoice.paid", "invoice.finalized", "invoice.created"],
            )
            if stored_invoice and self._invoice_subscription_id(stored_invoice) and not self._invoice_subscription_id(invoice):
                invoice = self._merge_invoice_identity_from_stored_event(invoice, stored_invoice)
            event_type = "invoice.paid" if invoice.get("status") == "paid" else "invoice.finalized"
            self._project_invoice_event(invoice, account_id, event_type, event_created=None)
            local = self._find_invoice_for_stripe(invoice, account_id)
            self._audit(studio_id, actor_id, "billing.reconcile_invoice", local.get("id") if local else data.stripe_object_id, {
                "stripe_invoice_id": data.stripe_object_id,
            })
            return BillingReconcileResponse(
                object_type=data.object_type,
                stripe_object_id=data.stripe_object_id,
                local_object_id=(local or {}).get("id"),
                status=(local or {}).get("status") or "reconciled",
                detail="Invoice was refreshed from Stripe.",
            )

        if data.object_type == "subscription":
            stripe_subscription = stripe_service.retrieve_connected_subscription(
                account_id=account_id,
                subscription_id=data.stripe_object_id,
                expand=["items.data"],
            )
            subscription = self._stripe_object_to_dict(stripe_subscription)
            local = self._project_subscription(subscription, account_id, "customer.subscription.updated", None)
            self._audit(studio_id, actor_id, "billing.reconcile_subscription", (local or {}).get("id") or data.stripe_object_id, {
                "stripe_subscription_id": data.stripe_object_id,
            })
            return BillingReconcileResponse(
                object_type=data.object_type,
                stripe_object_id=data.stripe_object_id,
                local_object_id=(local or {}).get("id"),
                status=(local or {}).get("status") or subscription.get("status") or "reconciled",
                detail="Subscription was refreshed from Stripe.",
            )

        stripe_intent = stripe_service.retrieve_connected_payment_intent(
            account_id=account_id,
            payment_intent_id=data.stripe_object_id,
            expand=["latest_charge", "payment_method"],
        )
        intent = self._stripe_object_to_dict(stripe_intent)
        event_type = "payment_intent.succeeded"
        if intent.get("status") == "processing":
            event_type = "payment_intent.processing"
        elif intent.get("status") not in {"succeeded", "requires_capture"}:
            event_type = "payment_intent.payment_failed"
        self._project_payment_intent(intent, account_id, event_type)
        local_payment = self._find_payment_by_intent(account_id, data.stripe_object_id)
        self._audit(studio_id, actor_id, "billing.reconcile_payment_intent", (local_payment or {}).get("id") or data.stripe_object_id, {
            "stripe_payment_intent_id": data.stripe_object_id,
        })
        return BillingReconcileResponse(
            object_type=data.object_type,
            stripe_object_id=data.stripe_object_id,
            local_object_id=(local_payment or {}).get("id"),
            status=(local_payment or {}).get("status") or intent.get("status") or "reconciled",
            detail="PaymentIntent was refreshed from Stripe.",
        )

    def audit_connect_onboarding_started(self, studio_id: str, actor_id: str) -> None:
        account = self._ensure_payment_account_row(studio_id)
        self._audit_best_effort(
            studio_id,
            actor_id,
            "billing.connect_onboarding_started",
            studio_id,
            {"stripe_account_id": account.get("stripe_connected_account_id")},
        )

    def audit_connect_dashboard_opened(self, studio_id: str, actor_id: str) -> None:
        account = self._ensure_payment_account_row(studio_id)
        self._audit_best_effort(
            studio_id,
            actor_id,
            "billing.connect_dashboard_opened",
            studio_id,
            {"stripe_account_id": account.get("stripe_connected_account_id")},
        )

    async def list_plans(self, studio_id: str) -> list[BillingPlanResponse]:
        account = self._ensure_payment_account_row(studio_id)
        result = (
            self.supabase.table("billing_plans")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at")
            .execute()
        )
        return [self._plan_response(row, account) for row in (result.data or [])]

    async def create_plan(self, data: BillingPlanCreate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        self._ensure_programs_in_studio(studio_id, data.program_ids)
        account = self._ensure_payment_account_row(studio_id)
        if account.get("stripe_connected_account_id"):
            account = self._refresh_connect_account_status(account, strict=True)
        plan_row = data.model_dump(exclude={"program_ids"})
        plan_row["studio_id"] = studio_id
        plan_row["name"] = " ".join(data.name.strip().split())
        plan_row["status"] = "pending"
        if not plan_row["name"]:
            raise HTTPException(status_code=400, detail="Billing plan name is required.")
        try:
            result = self.supabase.table("billing_plans").insert(plan_row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(status_code=409, detail="A billing plan with this name already exists.") from exc
            raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create billing plan.")
        plan = result.data[0]
        self._replace_plan_programs(studio_id, plan["id"], data.program_ids)
        if account.get("charges_enabled"):
            plan = self._sync_plan_price(plan, account)
        self._audit(studio_id, actor_id, "billing.plan_created", plan["id"], {"name": plan["name"], "program_ids": data.program_ids})
        return self._plan_response(plan, account)

    async def update_plan(self, plan_id: str, data: BillingPlanUpdate, studio_id: str, actor_id: str) -> BillingPlanResponse:
        current = self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        update = data.model_dump(exclude_unset=True, exclude={"program_ids"})
        if "name" in update and update["name"]:
            update["name"] = " ".join(update["name"].strip().split())
        if "currency" in update and update["currency"]:
            update["currency"] = update["currency"].lower()
        account = self._ensure_payment_account_row(studio_id)
        if account.get("stripe_connected_account_id"):
            account = self._refresh_connect_account_status(account, strict=True)
        should_sync_after_update = account.get("charges_enabled") and (
            not current.get("stripe_price_id")
            or any(key in update for key in ("amount_cents", "currency", "billing_interval", "name", "description"))
        )
        if current.get("status") == "pending" and account.get("charges_enabled") and current.get("stripe_price_id"):
            update.setdefault("status", "active")
        if update:
            try:
                result = (
                    self.supabase.table("billing_plans")
                    .update(update)
                    .eq("id", plan_id)
                    .eq("studio_id", studio_id)
                    .execute()
                )
            except PostgrestAPIError as exc:
                if exc.code == "23505":
                    raise HTTPException(status_code=409, detail="A billing plan with this name already exists.") from exc
                raise
            if not result.data:
                raise HTTPException(status_code=404, detail="Billing plan not found.")
            current = result.data[0]
        if data.program_ids is not None:
            self._ensure_programs_in_studio(studio_id, data.program_ids)
            self._replace_plan_programs(studio_id, plan_id, data.program_ids)
        if should_sync_after_update:
            current = self._sync_plan_price(current, account)
        self._audit(studio_id, actor_id, "billing.plan_updated", plan_id, {"changes": update, "program_ids": data.program_ids})
        return self._plan_response(current, account)

    async def sync_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        plan = self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        account = self._ensure_connect_ready(studio_id)
        plan = self._sync_plan_price(plan, account, force=True)
        self._audit(studio_id, actor_id, "billing.plan_synced", plan_id, {
            "stripe_account_id": account.get("stripe_connected_account_id"),
            "stripe_price_id": plan.get("stripe_price_id"),
        })
        return self._plan_response(plan, account)

    async def archive_plan(self, plan_id: str, studio_id: str, actor_id: str) -> BillingPlanResponse:
        self._get_row_or_404("billing_plans", plan_id, studio_id, "Billing plan not found.")
        result = (
            self.supabase.table("billing_plans")
            .update({"status": "archived", "archived_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", plan_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing plan not found.")
        self._audit(studio_id, actor_id, "billing.plan_archived", plan_id, {})
        return self._plan_response(result.data[0], self._ensure_payment_account_row(studio_id))

    async def list_payers(self, studio_id: str) -> list[BillingPayerResponse]:
        result = (
            self.supabase.table("billing_payers")
            .select("*")
            .eq("studio_id", studio_id)
            .order("display_name")
            .execute()
        )
        return [BillingPayerResponse(**row) for row in (result.data or [])]

    async def create_payer(self, data: BillingPayerCreate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        row = data.model_dump()
        row["studio_id"] = studio_id
        if row.get("guardian_id"):
            self._ensure_record_in_studio("guardians", row["guardian_id"], studio_id, "Guardian not found.")
        account = self._ensure_payment_account_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create payer.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_created", payer["id"], {"display_name": data.display_name})
        return BillingPayerResponse(**payer)

    async def get_payer(self, payer_id: str, studio_id: str) -> BillingPayerResponse:
        return BillingPayerResponse(**self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found."))

    async def update_payer(self, payer_id: str, data: BillingPayerUpdate, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("guardian_id"):
            self._ensure_record_in_studio("guardians", update["guardian_id"], studio_id, "Guardian not found.")
        if not update:
            return await self.get_payer(payer_id, studio_id)
        account = self._ensure_payment_account_row(studio_id)
        if account.get("charges_enabled"):
            self._validate_connect_account_access(account)
        result = self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        payer = result.data[0]
        if account.get("charges_enabled"):
            payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_updated", payer_id, {"changes": update})
        return BillingPayerResponse(**payer)

    async def sync_payer(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        self._audit(studio_id, actor_id, "billing.payer_synced", payer_id, {
            "stripe_account_id": account.get("stripe_connected_account_id"),
            "stripe_customer_id": payer.get("stripe_customer_id"),
        })
        return BillingPayerResponse(**payer)

    async def create_autopay_setup_link(
        self,
        payer_id: str,
        data: BillingPayerAutopaySetupRequest,
        studio_id: str,
        actor_id: str,
    ) -> BillingLinkResponse:
        if not data.terms_accepted:
            raise HTTPException(status_code=400, detail="Autopay setup requires accepted autopay terms.")
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        if not payer.get("stripe_customer_id"):
            raise HTTPException(status_code=409, detail="Stripe customer could not be created for this payer.")
        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        now = datetime.now(timezone.utc).isoformat()
        self.supabase.table("billing_payers").update({
            "autopay_status": "pending",
            "autopay_terms_accepted_at": now if data.terms_accepted else None,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()
        return_url = self._safe_redirect_url(data.return_url, f"{frontend_url}/billing?autopay=success")
        if payer.get("default_payment_method_id"):
            self.supabase.table("billing_payers").update({
                "autopay_status": "enabled",
                "autopay_authorized_at": now,
                "autopay_terms_accepted_at": now,
                "billing_status": "current",
            }).eq("id", payer_id).eq("studio_id", studio_id).execute()
            self._audit(studio_id, actor_id, "billing.autopay_authorized_existing_payment_method", payer_id, {
                "stripe_customer_id": payer.get("stripe_customer_id"),
                "default_payment_method_id": payer.get("default_payment_method_id"),
            })
            return BillingLinkResponse(url=return_url)
        link = StripeService().create_setup_checkout_session(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            success_url=self._safe_redirect_url(data.success_url or data.return_url, f"{frontend_url}/billing?autopay=success"),
            cancel_url=self._safe_redirect_url(data.cancel_url or data.return_url, f"{frontend_url}/billing?autopay=cancelled"),
            metadata={
                "studio_id": studio_id,
                "payer_id": payer_id,
                "product": "koaryu_payments_autopay",
            },
            idempotency_key=self._idempotency_key("payer-autopay-setup", payer_id, now),
        )
        self._audit(studio_id, actor_id, "billing.autopay_setup_started", payer_id, {
            "stripe_customer_id": payer.get("stripe_customer_id"),
        })
        return BillingLinkResponse(url=link["url"] if isinstance(link, dict) else link.url)

    async def disable_autopay(self, payer_id: str, studio_id: str, actor_id: str) -> BillingPayerResponse:
        self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        result = (
            self.supabase.table("billing_payers")
            .update({
                "autopay_status": "disabled",
                "autopay_disabled_at": datetime.now(timezone.utc).isoformat(),
            })
            .eq("id", payer_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Payer not found.")
        self._audit(studio_id, actor_id, "billing.autopay_disabled", payer_id, {})
        return BillingPayerResponse(**result.data[0])

    async def list_invoices(self, studio_id: str) -> list[BillingInvoiceResponse]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingInvoiceResponse(**row) for row in (result.data or [])]

    async def list_subscriptions(self, studio_id: str) -> list[BillingSubscriptionResponse]:
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingSubscriptionResponse(**row) for row in (result.data or [])]

    async def list_enrollments(self, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(300)
            .execute()
        )
        return [StudentBillingEnrollmentResponse(**row) for row in (result.data or [])]

    async def list_student_billing(self, student_id: str, studio_id: str) -> list[StudentBillingEnrollmentResponse]:
        self._ensure_record_in_studio("students", student_id, studio_id, "Student not found.")
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("student_id", student_id)
            .order("created_at", desc=True)
            .execute()
        )
        return [StudentBillingEnrollmentResponse(**row) for row in (result.data or [])]

    async def add_student_billing_enrollment(
        self,
        data: StudentBillingEnrollmentCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        if not data.student_id:
            raise HTTPException(status_code=400, detail="Student is required for billing enrollment.")
        self._ensure_record_in_studio("students", data.student_id, studio_id, "Student not found.")
        self._ensure_record_in_studio("billing_plans", data.billing_plan_id, studio_id, "Billing plan not found.")
        if data.payer_id:
            self._ensure_record_in_studio("billing_payers", data.payer_id, studio_id, "Payer not found.")
        plan = self._get_row_or_404("billing_plans", data.billing_plan_id, studio_id, "Billing plan not found.")
        if data.collection_mode != "external" and plan.get("billing_interval") == "fixed_term" and not data.end_date:
            raise HTTPException(status_code=400, detail="Fixed-term billing requires an end date.")
        row = data.model_dump(exclude_none=True)
        row["studio_id"] = studio_id
        row.setdefault("billing_status", "externally_paid" if data.collection_mode == "external" else "no_payment_method")
        try:
            result = self.supabase.table("student_billing_enrollments").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This student already has an active billing enrollment for the selected plan and payer.",
                ) from exc
            raise
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student billing enrollment.")
        enrollment = result.data[0]
        if data.collection_mode != "external":
            enrollment = self._activate_stripe_enrollment(enrollment, plan, studio_id)
        else:
            self._recompute_payer_balance(studio_id, data.payer_id)
        self._audit(studio_id, actor_id, "billing.student_enrollment_created", result.data[0]["id"], {
            "student_id": data.student_id,
            "billing_plan_id": data.billing_plan_id,
            "payer_id": data.payer_id,
            "collection_mode": data.collection_mode,
        })
        return StudentBillingEnrollmentResponse(**enrollment)

    async def update_enrollment(
        self,
        enrollment_id: str,
        data: StudentBillingEnrollmentUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        current = self._get_row_or_404("student_billing_enrollments", enrollment_id, studio_id, "Billing enrollment not found.")
        update = data.model_dump(exclude_unset=True)
        if update.get("billing_plan_id"):
            self._ensure_record_in_studio("billing_plans", update["billing_plan_id"], studio_id, "Billing plan not found.")
        if update.get("payer_id"):
            self._ensure_record_in_studio("billing_payers", update["payer_id"], studio_id, "Payer not found.")
        stripe_rewire = any(key in update for key in ("billing_plan_id", "payer_id", "collection_mode"))
        if stripe_rewire and current.get("stripe_subscription_item_id"):
            self._detach_enrollment_from_subscription(current)
        if update:
            result = (
                self.supabase.table("student_billing_enrollments")
                .update(update)
                .eq("id", enrollment_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if not result.data:
                raise HTTPException(status_code=404, detail="Billing enrollment not found.")
            current = result.data[0]
        if stripe_rewire and current.get("collection_mode") != "external" and current.get("status") in {"pending", "active"}:
            plan = self._get_row_or_404("billing_plans", current["billing_plan_id"], studio_id, "Billing plan not found.")
            current = self._activate_stripe_enrollment(current, plan, studio_id)
        self._audit(studio_id, actor_id, "billing.student_enrollment_updated", enrollment_id, {"changes": update})
        return StudentBillingEnrollmentResponse(**current)

    async def set_enrollment_status(
        self,
        enrollment_id: str,
        status_value: str,
        studio_id: str,
        actor_id: str,
    ) -> StudentBillingEnrollmentResponse:
        current = self._get_row_or_404("student_billing_enrollments", enrollment_id, studio_id, "Billing enrollment not found.")
        update: dict[str, Any] = {"status": status_value}
        if status_value in {"paused", "canceled", "ended"}:
            self._detach_enrollment_from_subscription(current)
            update["stripe_subscription_item_id"] = None
            update["billing_status"] = "externally_paid" if current.get("collection_mode") == "external" else "upcoming"
        if status_value == "active" and current.get("collection_mode") != "external" and not current.get("stripe_subscription_item_id"):
            plan = self._get_row_or_404("billing_plans", current["billing_plan_id"], studio_id, "Billing plan not found.")
            current = self._activate_stripe_enrollment({**current, "status": "active"}, plan, studio_id)
        result = (
            self.supabase.table("student_billing_enrollments")
            .update(update)
            .eq("id", enrollment_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        self._audit(studio_id, actor_id, f"billing.student_enrollment_{status_value}", enrollment_id, {})
        return StudentBillingEnrollmentResponse(**result.data[0])

    async def create_invoice(
        self,
        data: BillingInvoiceCreate,
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> BillingInvoiceResponse:
        payer = self._get_row_or_404("billing_payers", data.payer_id, studio_id, "Payer not found.")
        if data.student_id:
            self._ensure_record_in_studio("students", data.student_id, studio_id, "Student not found.")
        if data.enrollment_id:
            self._ensure_record_in_studio("student_billing_enrollments", data.enrollment_id, studio_id, "Billing enrollment not found.")
        account = self._ensure_connect_ready(studio_id)
        payer = self._sync_payer_customer(payer, account)
        if data.collection_mode == "autopay" and not payer.get("default_payment_method_id"):
            raise HTTPException(status_code=409, detail="Autopay requires a saved payer payment method.")
        if data.collection_mode == "autopay" and not self._payer_autopay_authorized(payer):
            raise HTTPException(status_code=409, detail="Autopay requires accepted autopay terms before charging this payer.")

        if not data.items and not data.amount_cents:
            raise HTTPException(status_code=400, detail="Invoice needs at least one line item or amount.")
        items = [item.model_dump() for item in data.items] if data.items else [
            {
                "description": data.description or "Tuition invoice",
                "amount_cents": data.amount_cents or 0,
                "quantity": 1,
                "student_id": data.student_id,
                "enrollment_id": data.enrollment_id,
            }
        ]
        amount_due = sum(int(item["amount_cents"]) * int(item.get("quantity") or 1) for item in items)
        application_fee = self._application_fee_amount(amount_due, account)
        normalized_idempotency_key = self._normalize_idempotency_key(idempotency_key)
        request_hash = self._invoice_request_hash(data)
        invoice_row = {
            "studio_id": studio_id,
            "payer_id": data.payer_id,
            "student_id": data.student_id,
            "enrollment_id": data.enrollment_id,
            "invoice_type": data.invoice_type,
            "status": "draft",
            "amount_due_cents": amount_due,
            "amount_paid_cents": 0,
            "amount_remaining_cents": amount_due,
            "currency": data.currency,
            "due_date": data.due_date,
            "stripe_account_id": account["stripe_connected_account_id"],
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_method": "charge_automatically" if data.collection_mode == "autopay" else "send_invoice",
            "application_fee_amount_cents": application_fee,
            "external": False,
            "idempotency_key": normalized_idempotency_key,
            "request_hash": request_hash if normalized_idempotency_key else None,
        }
        local_invoice = self._claim_invoice_create_request(
            studio_id,
            normalized_idempotency_key,
            request_hash,
            invoice_row,
        )
        if local_invoice.get("stripe_invoice_id"):
            return BillingInvoiceResponse(**local_invoice)

        stripe_service = StripeService()
        stripe_invoice = stripe_service.create_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            customer_id=payer["stripe_customer_id"],
            collection_method=invoice_row["collection_method"],
            application_fee_amount=application_fee,
            default_payment_method=payer.get("default_payment_method_id") if data.collection_mode == "autopay" else None,
            due_date=self._date_to_epoch(data.due_date) if data.due_date else None,
            days_until_due=7,
            metadata={
                "studio_id": studio_id,
                "payer_id": data.payer_id,
                "invoice_id": local_invoice["id"],
                "product": "koaryu_payments",
            },
            idempotency_key=self._idempotency_key("invoice", local_invoice["id"]),
        )
        stripe_invoice_id = _stripe_id(stripe_invoice)
        for index, item in enumerate(items):
            amount = int(item["amount_cents"]) * int(item.get("quantity") or 1)
            metadata = {
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id") or "",
                "enrollment_id": item.get("enrollment_id") or "",
                "billing_plan_id": item.get("billing_plan_id") or "",
            }
            stripe_item = stripe_service.create_connected_invoice_item(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                amount=amount,
                currency=data.currency,
                description=item["description"],
                metadata=metadata,
                idempotency_key=self._idempotency_key("invoice-item", local_invoice["id"], str(index)),
                invoice_id=stripe_invoice_id,
            )
            self._insert_invoice_item_once({
                "studio_id": studio_id,
                "invoice_id": local_invoice["id"],
                "student_id": item.get("student_id"),
                "enrollment_id": item.get("enrollment_id"),
                "billing_plan_id": item.get("billing_plan_id"),
                "description": item["description"],
                "quantity": item.get("quantity") or 1,
                "unit_amount_cents": item["amount_cents"],
                "amount_cents": amount,
                "stripe_invoice_item_id": _stripe_id(stripe_item),
                "metadata": metadata,
            })

        stripe_invoice = stripe_service.retrieve_connected_invoice(
            account_id=account["stripe_connected_account_id"],
            invoice_id=stripe_invoice_id,
        )
        local_invoice = self._update_invoice_from_stripe(local_invoice["id"], studio_id, stripe_invoice, account["stripe_connected_account_id"])
        if data.send_hosted_invoice:
            local_invoice = (await self.finalize_invoice(local_invoice["id"], studio_id, actor_id)).model_dump()
        self._audit(studio_id, actor_id, "billing.invoice_created", local_invoice["id"], {
            "amount_due_cents": amount_due,
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id"),
        })
        self._recompute_payer_balance(studio_id, data.payer_id)
        return BillingInvoiceResponse(**local_invoice)

    async def finalize_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_service = StripeService()
        stripe_invoice = stripe_service.finalize_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
        )
        send_error = None
        if _object_get(stripe_invoice, "collection_method") == "send_invoice":
            try:
                stripe_invoice = stripe_service.send_connected_invoice(
                    account_id=invoice["stripe_account_id"],
                    invoice_id=invoice["stripe_invoice_id"],
                )
            except Exception as exc:
                send_error = f"Stripe finalized the hosted invoice but could not send email: {exc}"
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        if send_error:
            result = (
                self.supabase.table("billing_invoices")
                .update({"last_payment_error": send_error})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            if result.data:
                invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_finalized", invoice_id, {})
        return BillingInvoiceResponse(**invoice)

    async def retry_invoice_payment(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = StripeService().pay_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_retry_requested", invoice_id, {})
        return BillingInvoiceResponse(**invoice)

    async def void_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if invoice.get("stripe_invoice_id") and invoice.get("stripe_account_id"):
            stripe_invoice = StripeService().void_connected_invoice(
                account_id=invoice["stripe_account_id"],
                invoice_id=invoice["stripe_invoice_id"],
            )
            invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        else:
            result = (
                self.supabase.table("billing_invoices")
                .update({"status": "void", "voided_at": datetime.now(timezone.utc).isoformat()})
                .eq("id", invoice_id)
                .eq("studio_id", studio_id)
                .execute()
            )
            invoice = result.data[0]
        self._audit(studio_id, actor_id, "billing.invoice_voided", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    async def reconcile_invoice(self, invoice_id: str, studio_id: str, actor_id: str) -> BillingInvoiceResponse:
        invoice = self._get_row_or_404("billing_invoices", invoice_id, studio_id, "Invoice not found.")
        if not invoice.get("stripe_invoice_id") or not invoice.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Invoice is not linked to Stripe.")
        stripe_invoice = StripeService().retrieve_connected_invoice(
            account_id=invoice["stripe_account_id"],
            invoice_id=invoice["stripe_invoice_id"],
            expand=["payment_intent"],
        )
        invoice = self._update_invoice_from_stripe(invoice_id, studio_id, stripe_invoice, invoice["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.invoice_reconciled", invoice_id, {})
        self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        return BillingInvoiceResponse(**invoice)

    async def list_payments(self, studio_id: str) -> list[BillingPaymentResponse]:
        result = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        return [BillingPaymentResponse(**row) for row in (result.data or [])]

    async def record_external_payment(self, data: ExternalPaymentCreate, studio_id: str, actor_id: str) -> BillingPaymentResponse:
        if data.payer_id:
            self._ensure_record_in_studio("billing_payers", data.payer_id, studio_id, "Payer not found.")
        if data.invoice_id:
            self._ensure_record_in_studio("billing_invoices", data.invoice_id, studio_id, "Invoice not found.")
        row = data.model_dump()
        row.update({
            "studio_id": studio_id,
            "status": "externally_recorded",
            "payment_method_type": "external",
            "processed_at": datetime.now(timezone.utc).isoformat(),
        })
        result = self.supabase.table("billing_payments").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record external payment.")
        if data.invoice_id:
            invoice = self._get_row_or_404("billing_invoices", data.invoice_id, studio_id, "Invoice not found.")
            amount_paid = int(invoice.get("amount_paid_cents") or 0) + data.amount_cents
            amount_due = int(invoice.get("amount_due_cents") or 0)
            invoice_update = {
                "amount_paid_cents": min(amount_paid, amount_due),
                "amount_remaining_cents": max(0, amount_due - amount_paid),
                "status": "paid" if amount_paid >= amount_due else invoice.get("status", "open"),
                "paid_at": datetime.now(timezone.utc).isoformat() if amount_paid >= amount_due else invoice.get("paid_at"),
                "external": True,
            }
            if amount_paid >= amount_due:
                invoice_update["application_fee_amount_cents"] = 0
            if amount_paid >= amount_due and invoice.get("stripe_invoice_id") and invoice.get("stripe_account_id"):
                try:
                    StripeService().pay_connected_invoice(
                        account_id=invoice["stripe_account_id"],
                        invoice_id=invoice["stripe_invoice_id"],
                        paid_out_of_band=True,
                    )
                except Exception as exc:
                    invoice_update["last_payment_error"] = f"External payment recorded locally but Stripe sync failed: {exc}"
            self.supabase.table("billing_invoices").update(invoice_update).eq("id", data.invoice_id).eq("studio_id", studio_id).execute()
            self._recompute_payer_balance(studio_id, invoice.get("payer_id"))
        elif data.payer_id:
            self._recompute_payer_balance(studio_id, data.payer_id)
        self._audit(studio_id, actor_id, "billing.external_payment_recorded", result.data[0]["id"], {
            "amount_cents": data.amount_cents,
            "external_method": data.external_method,
        })
        return BillingPaymentResponse(**result.data[0])

    async def refund_payment(
        self,
        payment_id: str,
        data: BillingRefundCreate,
        studio_id: str,
        actor_id: str,
    ) -> BillingRefundResponse:
        payment = self._get_row_or_404("billing_payments", payment_id, studio_id, "Payment not found.")
        if not payment.get("stripe_charge_id") or not payment.get("stripe_account_id"):
            raise HTTPException(status_code=409, detail="Only Stripe payments can be refunded through Koaryu.")
        amount = data.amount_cents or max(0, int(payment.get("amount_cents") or 0) - int(payment.get("refunded_amount_cents") or 0))
        refund = StripeService().create_connected_refund(
            account_id=payment["stripe_account_id"],
            charge_id=payment["stripe_charge_id"],
            amount=amount,
            reason=data.reason,
            refund_application_fee=True,
            metadata={"studio_id": studio_id, "payment_id": payment_id, "product": "koaryu_payments"},
            idempotency_key=self._idempotency_key("refund", payment_id, str(amount)),
        )
        row = self._project_refund(refund, payment["stripe_account_id"])
        self._audit(studio_id, actor_id, "billing.payment_refunded", payment_id, {
            "amount_cents": amount,
            "stripe_refund_id": row.get("stripe_refund_id"),
        })
        return BillingRefundResponse(**row)

    async def create_export_job(self, data: ExportJobCreate, studio_id: str, actor_id: str) -> ExportJobResponse:
        result = self.supabase.table("export_jobs").insert({
            "studio_id": studio_id,
            "export_type": data.export_type,
            "requested_by": actor_id,
            "metadata": {"filters": data.filters, "async_required": True},
        }).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create export job.")
        self._audit(studio_id, actor_id, "billing.export_requested", result.data[0]["id"], {"export_type": data.export_type})
        return ExportJobResponse(**result.data[0])

    async def get_export_job(self, export_id: str, studio_id: str) -> ExportJobResponse:
        return ExportJobResponse(**self._get_row_or_404("export_jobs", export_id, studio_id, "Export job not found."))

    def project_connect_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type") or ""
        account_id = event.get("account")
        event_created = event.get("created")
        data_object = ((event.get("data") or {}).get("object") or {})
        if event_type == "account.application.deauthorized":
            account_id = account_id or data_object.get("id")
            self._update_payment_account_by_stripe_account(account_id, {
                "status": "deauthorized",
                "charges_enabled": False,
                "payouts_enabled": False,
            })
            return
        if event_type == "account.updated":
            account_id = account_id or data_object.get("id")
            self._update_payment_account_by_stripe_account(
                account_id,
                self._connect_account_update_from_stripe(data_object),
            )
            return
        if event_type == "checkout.session.completed":
            self._project_checkout_session(data_object, account_id)
            return
        if event_type in {
            "invoice.created",
            "invoice.finalized",
            "invoice.paid",
            "invoice.payment_failed",
            "invoice.voided",
            "invoice.marked_uncollectible",
        }:
            self._project_invoice_event(data_object, account_id, event_type, event_created)
            return
        if event_type in {
            "payment_intent.processing",
            "payment_intent.succeeded",
            "payment_intent.payment_failed",
        }:
            self._project_payment_intent(data_object, account_id, event_type)
            return
        if event_type == "charge.refunded":
            self._project_charge_refund(data_object, account_id)
            return
        if event_type.startswith("charge.dispute."):
            self._project_dispute(data_object, account_id)
            return
        if event_type.startswith("customer.subscription."):
            self._project_subscription(data_object, account_id, event_type, event_created)
            return

    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        account = self._ensure_payment_account_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Connect Stripe before using hosted payments.")
        account = self._refresh_connect_account_status(account, strict=True)
        if not account.get("charges_enabled"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Stripe Connect charges are not enabled yet.")
        return account

    def _validate_connect_account_access(self, account: dict[str, Any]) -> None:
        account_id = account.get("stripe_connected_account_id")
        if account_id:
            StripeService().retrieve_account(account_id=account_id)

    def _sync_plan_price(self, plan: dict[str, Any], account: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return plan
        stripe_service = StripeService()
        product_id = plan.get("stripe_product_id")
        product_metadata = {"studio_id": plan["studio_id"], "billing_plan_id": plan["id"], "product": "koaryu_payments"}
        if product_id:
            stripe_service.update_connected_product(
                account_id=account_id,
                product_id=product_id,
                name=plan["name"],
                description=plan.get("description"),
                metadata=product_metadata,
            )
        else:
            product = stripe_service.create_connected_product(
                account_id=account_id,
                name=plan["name"],
                description=plan.get("description"),
                metadata=product_metadata,
                idempotency_key=self._idempotency_key("plan-product", plan["id"]),
            )
            product_id = _stripe_id(product)

        recurring, interval_count = self._stripe_recurring_for_interval(plan.get("billing_interval") or "monthly")
        active_price = self._find_plan_price(
            plan["studio_id"],
            plan["id"],
            account_id,
            int(plan.get("amount_cents") or 0),
            plan.get("currency") or "usd",
            plan.get("billing_interval") or "monthly",
            bool(recurring),
        )
        if active_price:
            stripe_price_id = active_price["stripe_price_id"]
            version = active_price.get("version") or plan.get("stripe_price_version") or 1
        else:
            version = int(plan.get("stripe_price_version") or 1)
            if plan.get("stripe_price_id"):
                version += 1
            lookup_key = f"koaryu_{plan['studio_id']}_{plan['id']}_v{version}"
            price = stripe_service.create_connected_price(
                account_id=account_id,
                product_id=product_id,
                unit_amount=int(plan.get("amount_cents") or 0),
                currency=plan.get("currency") or "usd",
                recurring=recurring,
                lookup_key=lookup_key,
                metadata={**product_metadata, "version": str(version), "billing_interval": plan.get("billing_interval") or "monthly"},
                idempotency_key=self._idempotency_key("plan-price", plan["id"], str(version), str(plan.get("amount_cents") or 0)),
            )
            stripe_price_id = _stripe_id(price)
            self.supabase.table("billing_plan_prices").insert({
                "studio_id": plan["studio_id"],
                "billing_plan_id": plan["id"],
                "stripe_account_id": account_id,
                "stripe_product_id": product_id,
                "stripe_price_id": stripe_price_id,
                "amount_cents": plan.get("amount_cents") or 0,
                "currency": plan.get("currency") or "usd",
                "billing_interval": plan.get("billing_interval") or "monthly",
                "interval_count": interval_count,
                "recurring": bool(recurring),
                "active": True,
                "version": version,
            }).execute()
        update = {
            "stripe_account_id": account_id,
            "stripe_product_id": product_id,
            "stripe_price_id": stripe_price_id,
            "stripe_price_lookup_key": f"koaryu_{plan['studio_id']}_{plan['id']}_v{version}",
            "stripe_price_version": version,
            "status": "active",
        }
        result = (
            self.supabase.table("billing_plans")
            .update(update)
            .eq("id", plan["id"])
            .eq("studio_id", plan["studio_id"])
            .execute()
        )
        return result.data[0] if result.data else {**plan, **update}

    def _sync_payer_customer(self, payer: dict[str, Any], account: dict[str, Any]) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return payer
        stripe_service = StripeService()
        metadata = {"studio_id": payer["studio_id"], "payer_id": payer["id"], "product": "koaryu_payments"}
        address = {
            "line1": payer.get("address_line1"),
            "city": payer.get("address_city"),
            "state": payer.get("address_state"),
            "postal_code": payer.get("address_zip"),
        }
        customer_id = payer.get("stripe_customer_id")
        if customer_id:
            stripe_service.update_connected_customer(
                account_id=account_id,
                customer_id=customer_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
            )
        else:
            customer = stripe_service.create_connected_customer(
                account_id=account_id,
                name=payer.get("display_name") or "Koaryu payer",
                email=payer.get("email"),
                phone=payer.get("phone"),
                address=address,
                metadata=metadata,
                idempotency_key=self._idempotency_key("payer-customer", payer["id"]),
            )
            customer_id = _stripe_id(customer)
        customer = stripe_service.retrieve_connected_customer(
            account_id=account_id,
            customer_id=customer_id,
            expand=["invoice_settings.default_payment_method"],
        )
        payment_fields = self._payment_method_fields_from_customer(customer)
        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **payment_fields,
        }
        if payment_fields.get("default_payment_method_id") and payer.get("autopay_status") in {"not_configured", "pending"}:
            update["billing_status"] = "current"
        result = (
            self.supabase.table("billing_payers")
            .update(update)
            .eq("id", payer["id"])
            .eq("studio_id", payer["studio_id"])
            .execute()
        )
        return result.data[0] if result.data else {**payer, **update}

    def _activate_stripe_enrollment(self, enrollment: dict[str, Any], plan: dict[str, Any], studio_id: str) -> dict[str, Any]:
        if not enrollment.get("payer_id"):
            raise HTTPException(status_code=409, detail="Assign a payer before activating Stripe billing.")
        account = self._ensure_connect_ready(studio_id)
        plan = self._sync_plan_price(plan, account) if not plan.get("stripe_price_id") else plan
        payer = self._sync_payer_customer(
            self._get_row_or_404("billing_payers", enrollment["payer_id"], studio_id, "Payer not found."),
            account,
        )
        if enrollment.get("collection_mode") == "autopay" and not payer.get("default_payment_method_id"):
            raise HTTPException(status_code=409, detail="Autopay requires a saved payer payment method.")
        if enrollment.get("collection_mode") == "autopay" and (
            not self._payer_autopay_authorized(payer)
        ):
            raise HTTPException(status_code=409, detail="Autopay requires accepted autopay terms before enrollment.")
        if plan.get("billing_interval") == "paid_in_full":
            self._create_paid_in_full_invoice(enrollment, plan, payer, account)
            return self._update_enrollment(enrollment["id"], studio_id, {"billing_status": "upcoming"})

        group = self._find_or_create_billing_subscription(enrollment, plan, payer, account)
        stripe_service = StripeService()
        if group.get("stripe_subscription_id"):
            existing_item_id = self._subscription_item_id_for_group_plan(studio_id, group["id"], plan["id"])
            if existing_item_id:
                quantity = self._active_enrollment_count_for_subscription_item(
                    studio_id,
                    group["id"],
                    existing_item_id,
                ) + 1
                stripe_service.update_connected_subscription_item(
                    account_id=account["stripe_connected_account_id"],
                    subscription_item_id=existing_item_id,
                    quantity=quantity,
                    proration_behavior="none",
                )
                item_id = existing_item_id
            else:
                item = stripe_service.create_connected_subscription_item(
                    account_id=account["stripe_connected_account_id"],
                    subscription_id=group["stripe_subscription_id"],
                    price_id=plan["stripe_price_id"],
                    metadata={
                        "studio_id": studio_id,
                        "payer_id": payer["id"],
                        "enrollment_id": enrollment["id"],
                        "student_id": enrollment["student_id"],
                        "billing_plan_id": plan["id"],
                        "billing_subscription_id": group["id"],
                        "product": "koaryu_payments",
                    },
                    idempotency_key=self._idempotency_key("subscription-item", enrollment["id"], plan["stripe_price_id"]),
                )
                item_id = _stripe_id(item)
        else:
            subscription = stripe_service.create_connected_subscription(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                price_id=plan["stripe_price_id"],
                collection_method="charge_automatically" if enrollment.get("collection_mode") == "autopay" else "send_invoice",
                application_fee_percent=self._application_fee_percent(account),
                default_payment_method=payer.get("default_payment_method_id") if enrollment.get("collection_mode") == "autopay" else None,
                trial_days=int(plan.get("trial_days") or 0),
                days_until_due=7,
                metadata={
                    "studio_id": studio_id,
                    "payer_id": payer["id"],
                    "billing_subscription_id": group["id"],
                    "product": "koaryu_payments",
                },
                item_metadata={
                    "studio_id": studio_id,
                    "payer_id": payer["id"],
                    "enrollment_id": enrollment["id"],
                    "student_id": enrollment["student_id"],
                    "billing_plan_id": plan["id"],
                    "billing_subscription_id": group["id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("subscription", group["id"]),
            )
            group = self._project_subscription(subscription, account["stripe_connected_account_id"]) or group
            item_id = self._subscription_item_id_for_enrollment(subscription, enrollment["id"])
        update = {
            "billing_subscription_id": group["id"],
            "stripe_subscription_id": group.get("stripe_subscription_id"),
            "stripe_subscription_item_id": item_id,
            "billing_status": "upcoming" if enrollment.get("collection_mode") != "autopay" else "current",
            "status": "active",
        }
        return self._update_enrollment(enrollment["id"], studio_id, update)

    def _find_or_create_billing_subscription(
        self,
        enrollment: dict[str, Any],
        plan: dict[str, Any],
        payer: dict[str, Any],
        account: dict[str, Any],
    ) -> dict[str, Any]:
        account_id = account["stripe_connected_account_id"]
        result = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", enrollment["studio_id"])
            .eq("payer_id", payer["id"])
            .eq("collection_mode", enrollment.get("collection_mode") or "invoice_link")
            .eq("billing_interval", plan.get("billing_interval") or "monthly")
            .eq("currency", plan.get("currency") or "usd")
            .in_("status", ["pending", "trialing", "active", "incomplete", "past_due"])
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
        inserted = self.supabase.table("billing_subscriptions").insert({
            "studio_id": enrollment["studio_id"],
            "payer_id": payer["id"],
            "stripe_account_id": account_id,
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_mode": enrollment.get("collection_mode") or "invoice_link",
            "billing_interval": plan.get("billing_interval") or "monthly",
            "currency": plan.get("currency") or "usd",
            "status": "pending",
            "default_payment_method_id": payer.get("default_payment_method_id"),
            "application_fee_percent": self._application_fee_percent(account),
        })
        try:
            inserted = inserted.execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505":
                raise
            retry = (
                self.supabase.table("billing_subscriptions")
                .select("*")
                .eq("studio_id", enrollment["studio_id"])
                .eq("payer_id", payer["id"])
                .eq("collection_mode", enrollment.get("collection_mode") or "invoice_link")
                .eq("billing_interval", plan.get("billing_interval") or "monthly")
                .eq("currency", plan.get("currency") or "usd")
                .in_("status", ["pending", "trialing", "active", "incomplete", "past_due"])
                .limit(1)
                .execute()
            )
            if retry.data:
                return retry.data[0]
            raise
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create billing subscription.")
        return inserted.data[0]

    def _detach_enrollment_from_subscription(self, enrollment: dict[str, Any]) -> None:
        item_id = enrollment.get("stripe_subscription_item_id")
        subscription_id = enrollment.get("stripe_subscription_id")
        account_id = self._stripe_account_for_studio(enrollment["studio_id"]) if subscription_id else None
        remaining = []
        if enrollment.get("billing_subscription_id"):
            result = (
                self.supabase.table("student_billing_enrollments")
                .select("id")
                .eq("studio_id", enrollment["studio_id"])
                .eq("billing_subscription_id", enrollment["billing_subscription_id"])
                .neq("id", enrollment["id"])
                .in_("status", ["pending", "active"])
                .execute()
            )
            remaining = result.data or []
        if not remaining and subscription_id:
            if account_id:
                StripeService().cancel_connected_subscription(account_id=account_id, subscription_id=subscription_id)
            if enrollment.get("billing_subscription_id"):
                self.supabase.table("billing_subscriptions").update({"status": "canceled"}).eq("id", enrollment["billing_subscription_id"]).execute()
            return
        if item_id and subscription_id and account_id:
            remaining_same_item = self._active_enrollment_count_for_subscription_item(
                enrollment["studio_id"],
                enrollment.get("billing_subscription_id"),
                item_id,
                exclude_enrollment_id=enrollment["id"],
            )
            if remaining_same_item:
                StripeService().update_connected_subscription_item(
                    account_id=account_id,
                    subscription_item_id=item_id,
                    quantity=remaining_same_item,
                    proration_behavior="none",
                )
            else:
                StripeService().delete_connected_subscription_item(account_id=account_id, subscription_item_id=item_id)

    def _create_paid_in_full_invoice(self, enrollment: dict[str, Any], plan: dict[str, Any], payer: dict[str, Any], account: dict[str, Any]) -> None:
        invoice = BillingInvoiceCreate(
            payer_id=payer["id"],
            student_id=enrollment["student_id"],
            enrollment_id=enrollment["id"],
            invoice_type="paid_in_full",
            collection_mode="autopay" if enrollment.get("collection_mode") == "autopay" else "invoice_link",
            currency=plan.get("currency") or "usd",
            description=plan.get("name") or "Paid in full",
            amount_cents=int(plan.get("amount_cents") or 0) + int(plan.get("signup_fee_cents") or 0),
        )
        inserted = self.supabase.table("billing_invoices").insert({
            "studio_id": enrollment["studio_id"],
            "payer_id": payer["id"],
            "student_id": enrollment["student_id"],
            "enrollment_id": enrollment["id"],
            "invoice_type": invoice.invoice_type,
            "status": "draft",
            "amount_due_cents": invoice.amount_cents or 0,
            "amount_paid_cents": 0,
            "amount_remaining_cents": invoice.amount_cents or 0,
            "currency": invoice.currency,
            "stripe_account_id": account["stripe_connected_account_id"],
            "stripe_customer_id": payer.get("stripe_customer_id"),
            "collection_method": "charge_automatically" if invoice.collection_mode == "autopay" else "send_invoice",
            "application_fee_amount_cents": self._application_fee_amount(invoice.amount_cents or 0, account),
        }).execute()
        if inserted.data:
            local_invoice = inserted.data[0]
            stripe_service = StripeService()
            stripe_invoice = stripe_service.create_connected_invoice(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                collection_method="charge_automatically" if invoice.collection_mode == "autopay" else "send_invoice",
                application_fee_amount=self._application_fee_amount(invoice.amount_cents or 0, account),
                default_payment_method=payer.get("default_payment_method_id") if invoice.collection_mode == "autopay" else None,
                days_until_due=7,
                metadata={
                    "studio_id": enrollment["studio_id"],
                    "payer_id": payer["id"],
                    "invoice_id": local_invoice["id"],
                    "enrollment_id": enrollment["id"],
                    "student_id": enrollment["student_id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("paid-in-full-invoice", enrollment["id"]),
            )
            stripe_invoice_id = _stripe_id(stripe_invoice)
            stripe_item = stripe_service.create_connected_invoice_item(
                account_id=account["stripe_connected_account_id"],
                customer_id=payer["stripe_customer_id"],
                amount=invoice.amount_cents or 0,
                currency=invoice.currency,
                description=invoice.description or plan["name"],
                metadata={
                    "studio_id": enrollment["studio_id"],
                    "invoice_id": local_invoice["id"],
                    "enrollment_id": enrollment["id"],
                    "student_id": enrollment["student_id"],
                    "billing_plan_id": plan["id"],
                    "product": "koaryu_payments",
                },
                idempotency_key=self._idempotency_key("paid-in-full-item", enrollment["id"]),
                invoice_id=stripe_invoice_id,
            )
            self.supabase.table("billing_invoice_items").insert({
                "studio_id": enrollment["studio_id"],
                "invoice_id": local_invoice["id"],
                "student_id": enrollment["student_id"],
                "enrollment_id": enrollment["id"],
                "billing_plan_id": plan["id"],
                "description": invoice.description or plan["name"],
                "quantity": 1,
                "unit_amount_cents": invoice.amount_cents or 0,
                "amount_cents": invoice.amount_cents or 0,
                "stripe_invoice_item_id": _stripe_id(stripe_item),
            }).execute()
            stripe_invoice = stripe_service.retrieve_connected_invoice(
                account_id=account["stripe_connected_account_id"],
                invoice_id=stripe_invoice_id,
            )
            self._update_invoice_from_stripe(local_invoice["id"], enrollment["studio_id"], stripe_invoice, account["stripe_connected_account_id"])

    def _project_checkout_session(self, session: dict[str, Any], account_id: Optional[str]) -> None:
        metadata = session.get("metadata") or {}
        if metadata.get("product") != "koaryu_payments_autopay":
            return
        studio_id = metadata.get("studio_id")
        payer_id = metadata.get("payer_id")
        if not studio_id or not payer_id:
            return
        setup_intent_id = _stripe_id(session.get("setup_intent"))
        customer_id = _stripe_id(session.get("customer"))
        payer = self._get_row_or_404("billing_payers", payer_id, studio_id, "Payer not found.")
        payment_fields: dict[str, Any] = {}
        if setup_intent_id and account_id:
            try:
                setup_intent = StripeService().retrieve_connected_setup_intent(
                    account_id=account_id,
                    setup_intent_id=setup_intent_id,
                    expand=["payment_method"],
                )
                payment_method_id = _stripe_id(_object_get(setup_intent, "payment_method"))
                if payment_method_id and customer_id:
                    customer = StripeService().set_connected_customer_default_payment_method(
                        account_id=account_id,
                        customer_id=customer_id,
                        payment_method_id=payment_method_id,
                    )
                    payment_fields = self._payment_method_fields_from_customer(customer)
                else:
                    payment_fields = self._payment_method_fields_from_payment_method(_object_get(setup_intent, "payment_method"))
            except Exception:
                pass
        update = {
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **{k: v for k, v in payment_fields.items() if v is not None},
        }
        if payer.get("autopay_terms_accepted_at"):
            update["autopay_status"] = "enabled"
            update["autopay_authorized_at"] = datetime.now(timezone.utc).isoformat()
            update["billing_status"] = "current"
        else:
            update["autopay_status"] = "pending"
        self.supabase.table("billing_payers").update(update).eq("id", payer_id).eq("studio_id", studio_id).execute()

    def _project_invoice_event(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        local = self._find_invoice_for_stripe(invoice, account_id)
        metadata = self._invoice_metadata(invoice)
        studio_id = metadata.get("studio_id") or (local or {}).get("studio_id")
        if not studio_id:
            account = self._payment_account_by_stripe_account(account_id)
            studio_id = account.get("studio_id") if account else None
        if not studio_id:
            return
        if local and self._is_stale_stripe_event(local, event_created):
            return
        if local:
            local = self._update_invoice_from_stripe(local["id"], studio_id, invoice, account_id)
            if event_created is not None:
                local = self._update_invoice_last_event(local, studio_id, event_created)
        else:
            local = self._insert_invoice_from_stripe(studio_id, invoice, account_id, event_created)
        self._update_subscription_period_from_invoice(studio_id, invoice, account_id)
        if event_type == "invoice.paid":
            self._project_payment_from_invoice(invoice, account_id, local)
            self._link_orphan_payment_to_invoice(invoice, account_id, local)
        if local.get("payer_id"):
            self._recompute_payer_balance(studio_id, local.get("payer_id"))

    def _project_payment_intent(self, intent: dict[str, Any], account_id: Optional[str], event_type: str) -> None:
        metadata = intent.get("metadata") or {}
        customer_id = _stripe_id(intent.get("customer"))
        invoice_id = _stripe_id(intent.get("invoice")) or metadata.get("invoice_id")
        local_invoice = self._find_invoice_by_payment_intent_or_invoice(
            account_id,
            _stripe_id(intent),
            invoice_id,
        )
        if not local_invoice and not invoice_id:
            local_invoice = self._find_invoice_by_customer_amount(
                account_id,
                customer_id,
                int(intent.get("amount_received") or intent.get("amount") or 0),
                intent.get("currency") or "usd",
            )
            invoice_id = (local_invoice or {}).get("stripe_invoice_id")
        studio_id = metadata.get("studio_id") or (local_invoice or {}).get("studio_id")
        if not studio_id:
            account = self._payment_account_by_stripe_account(account_id)
            studio_id = account.get("studio_id") if account else None
        if not studio_id:
            return
        payer_id = metadata.get("payer_id") or (local_invoice or {}).get("payer_id") or self._payer_id_for_customer(studio_id, account_id, customer_id)
        if not payer_id and not local_invoice and metadata.get("product") != "koaryu_payments":
            return
        status_value = "processing" if event_type == "payment_intent.processing" else ("succeeded" if event_type == "payment_intent.succeeded" else "failed")
        charge = self._latest_charge(intent)
        charge_id = _stripe_id(charge)
        row = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "invoice_id": (local_invoice or {}).get("id"),
            "stripe_customer_id": customer_id,
            "stripe_invoice_id": invoice_id,
            "stripe_payment_intent_id": _stripe_id(intent),
            "stripe_charge_id": charge_id,
            "stripe_account_id": account_id,
            "stripe_payment_method_id": _stripe_id(intent.get("payment_method")),
            "status": status_value,
            "amount_cents": int(intent.get("amount_received") or intent.get("amount") or 0),
            "currency": intent.get("currency") or "usd",
            "payment_method_type": self._payment_method_type(intent, charge),
            "receipt_url": _object_get(charge, "receipt_url"),
            "failure_code": _object_get(_object_get(intent, "last_payment_error"), "code"),
            "failure_message": _object_get(_object_get(intent, "last_payment_error"), "message"),
            "application_fee_amount_cents": int(
                intent.get("application_fee_amount")
                if intent.get("application_fee_amount") is not None
                else (local_invoice or {}).get("application_fee_amount_cents") or 0
            ),
            "processed_at": datetime.now(timezone.utc).isoformat() if status_value == "succeeded" else None,
        }
        existing = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_payment_intent_id", _stripe_id(intent))
            .limit(1)
            .execute()
        )
        if existing.data:
            existing_payment = existing.data[0]
            if existing_payment.get("status") in {"disputed", "refunded"}:
                row["status"] = existing_payment["status"]
                row["processed_at"] = existing_payment.get("processed_at") or row.get("processed_at")
            elif existing_payment.get("status") == "succeeded" and status_value in {"processing", "failed"}:
                row["status"] = "succeeded"
                row["processed_at"] = existing_payment.get("processed_at") or row.get("processed_at")
            result = self.supabase.table("billing_payments").update(row).eq("id", existing_payment["id"]).execute()
        else:
            result = self.supabase.table("billing_payments").insert(row).execute()
        payment = result.data[0] if result.data else row
        payment = self._link_disputes_to_payment(payment, account_id)
        if local_invoice and status_value in {"succeeded", "failed"}:
            update = {"last_payment_error": row.get("failure_message")}
            if status_value == "succeeded":
                update.update({
                    "status": "paid",
                    "amount_paid_cents": max(int(local_invoice.get("amount_paid_cents") or 0), row["amount_cents"]),
                    "amount_remaining_cents": 0,
                    "stripe_payment_intent_id": _stripe_id(intent),
                    "application_fee_amount_cents": row["application_fee_amount_cents"],
                    "paid_at": datetime.now(timezone.utc).isoformat(),
                })
            self.supabase.table("billing_invoices").update(update).eq("id", local_invoice["id"]).execute()
        if status_value == "succeeded" and row.get("payer_id"):
            self._store_invoice_payment_method(
                studio_id,
                row["payer_id"],
                account_id,
                _stripe_id(intent.get("customer")),
                intent.get("payment_method"),
            )
        if payment.get("payer_id"):
            self._recompute_payer_balance(studio_id, payment.get("payer_id"))

    def _link_disputes_to_payment(self, payment: dict[str, Any], account_id: Optional[str]) -> dict[str, Any]:
        charge_id = payment.get("stripe_charge_id")
        payment_id = payment.get("id")
        studio_id = payment.get("studio_id")
        if not charge_id or not payment_id or not studio_id:
            return payment
        query = (
            self.supabase.table("billing_disputes")
            .select("id, status")
            .eq("studio_id", studio_id)
            .eq("stripe_charge_id", charge_id)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        disputes = query.execute()
        if not disputes.data:
            return payment

        dispute_ids = [row["id"] for row in disputes.data if row.get("id")]
        dispute_update = {"payment_id": payment_id}
        if payment.get("stripe_payment_intent_id"):
            dispute_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        if dispute_ids:
            self.supabase.table("billing_disputes").update(dispute_update).in_("id", dispute_ids).execute()

        if payment.get("status") == "disputed":
            return payment
        result = self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment_id).execute()
        return result.data[0] if result.data else {**payment, "status": "disputed"}

    def _project_charge_refund(self, charge: dict[str, Any], account_id: Optional[str]) -> None:
        refunds = ((charge.get("refunds") or {}).get("data") or [])
        for refund in refunds:
            self._project_refund(refund, account_id, charge=charge)

    def _project_refund(self, refund: Any, account_id: Optional[str], *, charge: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        refund_dict = refund if isinstance(refund, dict) else refund.to_dict_recursive() if hasattr(refund, "to_dict_recursive") else dict(refund)
        charge_id = _stripe_id(refund_dict.get("charge")) or _stripe_id(charge)
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = (payment or {}).get("studio_id") or (refund_dict.get("metadata") or {}).get("studio_id")
        if not studio_id:
            return {}
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_refund_id": _stripe_id(refund_dict),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": _stripe_id(refund_dict.get("payment_intent")) or (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(refund_dict.get("amount") or 0),
            "status": refund_dict.get("status") or "succeeded",
            "reason": refund_dict.get("reason"),
            "metadata": refund_dict.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_refunds")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_refund_id", row["stripe_refund_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            delta = row["amount_cents"] - int(existing.data[0].get("amount_cents") or 0)
            result = self.supabase.table("billing_refunds").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            delta = row["amount_cents"]
            result = self.supabase.table("billing_refunds").insert(row).execute()
        if payment and delta:
            refunded = max(0, int(payment.get("refunded_amount_cents") or 0) + delta)
            self.supabase.table("billing_payments").update({
                "status": "refunded" if refunded >= int(payment.get("amount_cents") or 0) else payment.get("status"),
                "refunded_amount_cents": refunded,
            }).eq("id", payment["id"]).execute()
        return result.data[0] if result.data else row

    def _project_dispute(self, dispute: dict[str, Any], account_id: Optional[str]) -> None:
        charge_id = _stripe_id(dispute.get("charge"))
        payment = self._find_payment_by_charge(account_id, charge_id)
        studio_id = (payment or {}).get("studio_id") or (dispute.get("metadata") or {}).get("studio_id")
        if not studio_id:
            account = self._payment_account_by_stripe_account(account_id)
            studio_id = account.get("studio_id") if account else None
        if not studio_id:
            return
        row = {
            "studio_id": studio_id,
            "payment_id": (payment or {}).get("id"),
            "stripe_dispute_id": _stripe_id(dispute),
            "stripe_charge_id": charge_id,
            "stripe_payment_intent_id": (payment or {}).get("stripe_payment_intent_id"),
            "stripe_account_id": account_id,
            "amount_cents": int(dispute.get("amount") or 0),
            "status": dispute.get("status") or "needs_response",
            "reason": dispute.get("reason"),
            "liability_owner": "studio",
            "metadata": dispute.get("metadata") or {},
        }
        existing = (
            self.supabase.table("billing_disputes")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_account_id", account_id)
            .eq("stripe_dispute_id", row["stripe_dispute_id"])
            .limit(1)
            .execute()
        )
        if existing.data:
            self.supabase.table("billing_disputes").update(row).eq("id", existing.data[0]["id"]).execute()
        else:
            self.supabase.table("billing_disputes").insert(row).execute()
        if payment:
            self.supabase.table("billing_payments").update({"status": "disputed"}).eq("id", payment["id"]).execute()

    def _project_subscription(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
        event_type: str = "",
        event_created: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local = self._find_subscription_for_stripe(subscription, account_id)
        studio_id = metadata.get("studio_id") or (local or {}).get("studio_id")
        payer_id = metadata.get("payer_id") or (local or {}).get("payer_id")
        if not studio_id or not payer_id:
            return local
        if local and self._is_stale_stripe_event(local, event_created):
            return local
        status_value = "canceled" if event_type == "customer.subscription.deleted" else subscription.get("status", "active")
        period_start, period_end = self._subscription_period_bounds(subscription)
        update = {
            "studio_id": studio_id,
            "payer_id": payer_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(subscription.get("customer")),
            "stripe_subscription_id": _stripe_id(subscription),
            "status": status_value,
            "current_period_start": self._timestamp(period_start) or (local or {}).get("current_period_start"),
            "current_period_end": self._timestamp(period_end) or (local or {}).get("current_period_end"),
            "cancel_at_period_end": bool(subscription.get("cancel_at_period_end")),
            "application_fee_percent": subscription.get("application_fee_percent"),
            "last_stripe_event_created": event_created if event_created is not None else (local or {}).get("last_stripe_event_created"),
        }
        if local:
            result = self.supabase.table("billing_subscriptions").update(update).eq("id", local["id"]).execute()
            row = result.data[0] if result.data else {**local, **update}
        else:
            update.update({
                "collection_mode": "autopay" if subscription.get("collection_method") == "charge_automatically" else "invoice_link",
                "billing_interval": "monthly",
                "currency": "usd",
            })
            result = self.supabase.table("billing_subscriptions").insert(update).execute()
            row = result.data[0] if result.data else update
        self._project_subscription_items(subscription, row)
        return row

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
    ) -> dict[str, Any]:
        update = self._invoice_projection(invoice, account_id)
        current_rows = self.supabase.table("billing_invoices").select("*").eq("id", invoice_id).eq("studio_id", studio_id).limit(1).execute()
        current = current_rows.data[0] if current_rows.data else {}
        for stable_field in ("stripe_payment_intent_id", "stripe_subscription_id"):
            if update.get(stable_field) is None and current.get(stable_field):
                update[stable_field] = current[stable_field]
        update.update(self._invoice_identity_projection(studio_id, invoice, account_id, current=current))
        result = (
            self.supabase.table("billing_invoices")
            .update(update)
            .eq("id", invoice_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        return result.data[0] if result.data else update

    def _insert_invoice_from_stripe(
        self,
        studio_id: str,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        metadata = self._invoice_metadata(invoice)
        row = {
            "studio_id": studio_id,
            "payer_id": None,
            "student_id": None,
            "enrollment_id": None,
            "invoice_type": metadata.get("invoice_type") or "manual",
            "external": False,
            "last_stripe_event_created": event_created,
            **self._invoice_projection(invoice, account_id),
        }
        row.update(self._invoice_identity_projection(studio_id, invoice, account_id))
        result = self.supabase.table("billing_invoices").insert(row).execute()
        return result.data[0] if result.data else row

    def _invoice_projection(self, invoice: Any, account_id: Optional[str]) -> dict[str, Any]:
        invoice_id = _stripe_id(invoice)
        status_value = _object_get(invoice, "status") or "draft"
        if status_value == "void":
            status_value = "void"
        payment_intent = _object_get(invoice, "payment_intent")
        last_error = _object_get(_object_get(payment_intent, "last_payment_error"), "message")
        amount_due = int(_object_get(invoice, "amount_due") or 0)
        amount_paid = int(_object_get(invoice, "amount_paid") or 0)
        amount_remaining = int(_object_get(invoice, "amount_remaining") or 0)
        application_fee_amount = _object_get(invoice, "application_fee_amount")
        if _object_get(invoice, "paid_out_of_band"):
            amount_paid = amount_due
            amount_remaining = 0
        projection = {
            "stripe_invoice_id": invoice_id,
            "stripe_account_id": account_id,
            "stripe_customer_id": _stripe_id(_object_get(invoice, "customer")),
            "stripe_subscription_id": self._invoice_subscription_id(invoice),
            "stripe_payment_intent_id": _stripe_id(payment_intent),
            "invoice_number": _object_get(invoice, "number"),
            "status": self._local_invoice_status(status_value),
            "amount_due_cents": amount_due,
            "amount_paid_cents": amount_paid,
            "amount_remaining_cents": amount_remaining,
            "currency": _object_get(invoice, "currency") or "usd",
            "hosted_invoice_url": _object_get(invoice, "hosted_invoice_url"),
            "invoice_pdf": _object_get(invoice, "invoice_pdf"),
            "due_date": self._date_from_epoch(_object_get(invoice, "due_date")),
            "paid_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "paid_at")),
            "finalized_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "finalized_at")),
            "voided_at": self._timestamp(_object_get(_object_get(invoice, "status_transitions") or {}, "voided_at")),
            "collection_method": _object_get(invoice, "collection_method"),
            "last_payment_error": last_error,
        }
        if _object_get(invoice, "paid_out_of_band"):
            projection["application_fee_amount_cents"] = 0
        elif application_fee_amount is not None:
            projection["application_fee_amount_cents"] = int(application_fee_amount)
        return projection

    def _project_payment_from_invoice(self, invoice: dict[str, Any], account_id: Optional[str], local_invoice: dict[str, Any]) -> None:
        payment_intent_id = _stripe_id(invoice.get("payment_intent"))
        if not payment_intent_id:
            return
        try:
            intent = StripeService().retrieve_connected_payment_intent(
                account_id=account_id or local_invoice["stripe_account_id"],
                payment_intent_id=payment_intent_id,
                expand=["latest_charge", "payment_method"],
            )
        except Exception:
            intent = {
                "id": payment_intent_id,
                "amount_received": invoice.get("amount_paid"),
                "currency": invoice.get("currency"),
                "customer": invoice.get("customer"),
                "invoice": invoice.get("id"),
                "status": "succeeded",
                "metadata": invoice.get("metadata") or {},
            }
        self._project_payment_intent(intent if isinstance(intent, dict) else intent.to_dict_recursive(), account_id, "payment_intent.succeeded")

    def _invoice_metadata(self, invoice: Any) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        parent_details = self._invoice_parent_subscription_details(invoice)
        merged.update(_object_get(parent_details, "metadata") or {})
        single_line = self._single_invoice_line(invoice)
        if single_line:
            merged.update(_object_get(single_line, "metadata") or {})
        merged.update(_object_get(invoice, "metadata") or {})
        return merged

    def _merge_invoice_identity_from_stored_event(self, invoice: dict[str, Any], stored_invoice: dict[str, Any]) -> dict[str, Any]:
        merged = dict(invoice)
        if not self._invoice_parent_subscription_details(merged) and self._invoice_parent_subscription_details(stored_invoice):
            merged["parent"] = stored_invoice.get("parent")
        if not self._invoice_lines(merged) and self._invoice_lines(stored_invoice):
            merged["lines"] = stored_invoice.get("lines")
        if not (merged.get("metadata") or {}) and (stored_invoice.get("metadata") or {}):
            merged["metadata"] = stored_invoice.get("metadata")
        return merged

    def _invoice_parent_subscription_details(self, invoice: Any) -> dict[str, Any]:
        parent = _object_get(invoice, "parent") or {}
        if _object_get(parent, "type") != "subscription_details":
            return {}
        return _object_get(parent, "subscription_details") or {}

    def _invoice_subscription_id(self, invoice: Any) -> Optional[str]:
        direct = _stripe_id(_object_get(invoice, "subscription"))
        if direct:
            return direct
        parent_details = self._invoice_parent_subscription_details(invoice)
        parent_subscription = _stripe_id(_object_get(parent_details, "subscription"))
        if parent_subscription:
            return parent_subscription
        line_subscriptions = {
            _stripe_id(_object_get(_object_get(_object_get(line, "parent") or {}, "subscription_item_details") or {}, "subscription"))
            or _stripe_id(_object_get(line, "subscription"))
            for line in self._invoice_lines(invoice)
        }
        line_subscriptions.discard(None)
        return next(iter(line_subscriptions)) if len(line_subscriptions) == 1 else None

    def _invoice_subscription_item_id(self, invoice: Any) -> Optional[str]:
        line_items = {
            _stripe_id(_object_get(_object_get(_object_get(line, "parent") or {}, "subscription_item_details") or {}, "subscription_item"))
            or _stripe_id(_object_get(line, "subscription_item"))
            for line in self._invoice_lines(invoice)
        }
        line_items.discard(None)
        return next(iter(line_items)) if len(line_items) == 1 else None

    def _invoice_line_period_bounds(self, invoice: Any) -> tuple[Optional[Any], Optional[Any]]:
        period_pairs: set[tuple[Any, Any]] = set()
        for line in self._invoice_lines(invoice):
            if _object_get(line, "proration"):
                continue
            period = _object_get(line, "period") or {}
            start = _object_get(period, "start")
            end = _object_get(period, "end")
            if start and end:
                period_pairs.add((start, end))
        if len(period_pairs) != 1:
            return None, None
        return next(iter(period_pairs))

    def _invoice_lines(self, invoice: Any) -> list[Any]:
        lines = _object_get(invoice, "lines") or {}
        return list(_object_get(lines, "data") or [])

    def _single_invoice_line(self, invoice: Any) -> Optional[Any]:
        lines = self._invoice_lines(invoice)
        return lines[0] if len(lines) == 1 else None

    def _subscription_period_bounds(self, subscription: dict[str, Any]) -> tuple[Optional[Any], Optional[Any]]:
        start = subscription.get("current_period_start")
        end = subscription.get("current_period_end")
        if start and end:
            return start, end
        item_starts: list[Any] = []
        item_ends: list[Any] = []
        for item in ((subscription.get("items") or {}).get("data") or []):
            item_start = item.get("current_period_start")
            item_end = item.get("current_period_end")
            if item_start:
                item_starts.append(item_start)
            if item_end:
                item_ends.append(item_end)
        return (start or (min(item_starts) if item_starts else None), end or (max(item_ends) if item_ends else None))

    def _invoice_identity_projection(
        self,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
        *,
        current: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        current = current or {}
        metadata = self._invoice_metadata(invoice)
        enrollment = self._invoice_enrollment(studio_id, invoice)
        subscription_id = self._invoice_subscription_id(invoice)
        projection: dict[str, Any] = {}
        payer_id = metadata.get("payer_id") or current.get("payer_id") or self._payer_id_for_customer(studio_id, account_id, _stripe_id(_object_get(invoice, "customer")))
        enrollment_id = metadata.get("enrollment_id") or (enrollment or {}).get("id")
        student_id = metadata.get("student_id") or (enrollment or {}).get("student_id")
        invoice_type = metadata.get("invoice_type") or ("tuition" if subscription_id else None)
        if payer_id and not current.get("payer_id"):
            projection["payer_id"] = payer_id
        if enrollment_id and not current.get("enrollment_id"):
            projection["enrollment_id"] = enrollment_id
        if student_id and not current.get("student_id"):
            projection["student_id"] = student_id
        if invoice_type and (not current.get("invoice_type") or current.get("invoice_type") == "manual"):
            projection["invoice_type"] = invoice_type
        return projection

    def _invoice_enrollment(self, studio_id: str, invoice: Any) -> Optional[dict[str, Any]]:
        item_id = self._invoice_subscription_item_id(invoice)
        if not item_id:
            return None
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id, student_id")
            .eq("studio_id", studio_id)
            .eq("stripe_subscription_item_id", item_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _update_subscription_period_from_invoice(self, studio_id: str, invoice: Any, account_id: Optional[str]) -> None:
        subscription_id = self._invoice_subscription_id(invoice)
        if not subscription_id:
            return
        period_start, period_end = self._invoice_line_period_bounds(invoice)
        if not period_start and not period_end:
            return
        query = (
            self.supabase.table("billing_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("stripe_subscription_id", subscription_id)
            .limit(1)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        if not result.data:
            return
        current = result.data[0]
        update: dict[str, Any] = {}
        current_end = self._epoch_seconds(current.get("current_period_end"))
        incoming_end = self._epoch_seconds(period_end)
        should_update = not current.get("current_period_end") or (
            incoming_end is not None and (current_end is None or incoming_end >= current_end)
        )
        if period_start and should_update:
            update["current_period_start"] = self._timestamp(period_start)
        if period_end and should_update:
            update["current_period_end"] = self._timestamp(period_end)
        if update:
            self.supabase.table("billing_subscriptions").update(update).eq("id", current["id"]).execute()

    def _link_orphan_payment_to_invoice(self, invoice: dict[str, Any], account_id: Optional[str], local_invoice: dict[str, Any]) -> None:
        if not local_invoice or not local_invoice.get("id"):
            return
        payment_intent_id = _stripe_id(invoice.get("payment_intent"))
        payment = self._find_payment_by_intent(account_id, payment_intent_id) if payment_intent_id else None
        if not payment:
            payment = self._find_unlinked_payment_by_customer_amount(
                account_id,
                _stripe_id(invoice.get("customer")),
                int(invoice.get("amount_paid") or invoice.get("amount_due") or 0),
                invoice.get("currency") or "usd",
            )
        if not payment:
            return
        payment_update = {
            "invoice_id": local_invoice["id"],
            "stripe_invoice_id": local_invoice.get("stripe_invoice_id") or _stripe_id(invoice),
        }
        if local_invoice.get("payer_id") and not payment.get("payer_id"):
            payment_update["payer_id"] = local_invoice["payer_id"]
        self.supabase.table("billing_payments").update(payment_update).eq("id", payment["id"]).execute()
        invoice_update: dict[str, Any] = {}
        if payment.get("stripe_payment_intent_id") and not local_invoice.get("stripe_payment_intent_id"):
            invoice_update["stripe_payment_intent_id"] = payment["stripe_payment_intent_id"]
        existing_fee = local_invoice.get("application_fee_amount_cents")
        payment_fee = payment.get("application_fee_amount_cents")
        if payment_fee is not None and (int(payment_fee or 0) > 0 or existing_fee is None):
            invoice_update["application_fee_amount_cents"] = int(payment.get("application_fee_amount_cents") or 0)
        if invoice_update:
            self.supabase.table("billing_invoices").update(invoice_update).eq("id", local_invoice["id"]).execute()
            local_invoice.update(invoice_update)

    def _find_invoice_for_stripe(self, invoice: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        metadata = self._invoice_metadata(invoice)
        local_id = metadata.get("invoice_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_invoices").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data:
                return result.data[0]
        stripe_invoice_id = _stripe_id(invoice)
        if not stripe_invoice_id:
            return None
        query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_invoice_by_payment_intent_or_invoice(
        self,
        account_id: Optional[str],
        payment_intent_id: Optional[str],
        stripe_invoice_id: Optional[str],
    ) -> Optional[dict[str, Any]]:
        if payment_intent_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        if stripe_invoice_id:
            query = self.supabase.table("billing_invoices").select("*").eq("stripe_invoice_id", stripe_invoice_id).limit(1)
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
            if result.data:
                return result.data[0]
        return None

    def _find_invoice_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        if not customer_id or amount_cents <= 0:
            return None
        query = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("stripe_customer_id", customer_id)
            .eq("amount_due_cents", amount_cents)
            .eq("currency", currency)
            .in_("status", ["draft", "open", "paid"])
            .order("created_at", desc=True)
            .limit(5)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        candidates = []
        for row in result.data or []:
            if row.get("stripe_payment_intent_id"):
                continue
            if int(row.get("amount_remaining_cents") or 0) in {0, amount_cents}:
                candidates.append(row)
        return candidates[0] if len(candidates) == 1 else None

    def _find_unlinked_payment_by_customer_amount(
        self,
        account_id: Optional[str],
        customer_id: Optional[str],
        amount_cents: int,
        currency: str,
    ) -> Optional[dict[str, Any]]:
        if not customer_id or amount_cents <= 0:
            return None
        query = (
            self.supabase.table("billing_payments")
            .select("*")
            .eq("stripe_customer_id", customer_id)
            .eq("amount_cents", amount_cents)
            .eq("currency", currency)
            .in_("status", ["processing", "succeeded"])
            .order("processed_at", desc=True)
            .limit(5)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        candidates = []
        for row in result.data or []:
            if row.get("invoice_id") or row.get("stripe_invoice_id"):
                continue
            candidates.append(row)
        return candidates[0] if len(candidates) == 1 else None

    def _find_payment_by_charge(self, account_id: Optional[str], charge_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not charge_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_charge_id", charge_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _find_payment_by_intent(self, account_id: Optional[str], payment_intent_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not payment_intent_id:
            return None
        query = self.supabase.table("billing_payments").select("*").eq("stripe_payment_intent_id", payment_intent_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _webhook_health(self, account_id: Optional[str]) -> BillingWebhookHealthResponse:
        try:
            query = (
                self.supabase.table("stripe_events")
                .select("type, processing_status, processed_at, created_at")
                .order("created_at", desc=True)
                .limit(50)
            )
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            rows = query.execute().data or []
        except Exception:
            return BillingWebhookHealthResponse(
                stripe_account_id=account_id,
                failed_count=1,
                stale_processing_count=0,
            )

        latest_processed = next((row for row in rows if row.get("processing_status") == "processed"), None)
        return BillingWebhookHealthResponse(
            stripe_account_id=account_id,
            latest_processed_at=_to_text((latest_processed or {}).get("processed_at")),
            latest_event_type=(latest_processed or {}).get("type"),
            failed_count=sum(1 for row in rows if row.get("processing_status") == "failed"),
            stale_processing_count=sum(1 for row in rows if self._is_stale_webhook_processing(row)),
        )

    @staticmethod
    def _is_stale_webhook_processing(row: dict[str, Any]) -> bool:
        if row.get("processing_status") != "processing":
            return False
        created_at = row.get("created_at")
        if not created_at:
            return False
        if isinstance(created_at, datetime):
            created = created_at
        elif isinstance(created_at, str):
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except ValueError:
                return False
        else:
            return False
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - created >= BILLING_WEBHOOK_PROCESSING_STALE_AFTER

    @staticmethod
    def _stripe_object_to_dict(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if hasattr(value, "to_dict_recursive"):
            return value.to_dict_recursive()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return dict(value)

    def _stored_stripe_event_object(
        self,
        account_id: Optional[str],
        object_id: str,
        event_types: list[str],
    ) -> Optional[dict[str, Any]]:
        try:
            query = (
                self.supabase.table("stripe_events")
                .select("payload, type, created_at")
                .eq("payload->data->object->>id", object_id)
                .in_("type", event_types)
                .order("created_at", desc=True)
                .limit(10)
            )
            query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
            result = query.execute()
        except Exception:
            return None
        for row in result.data or []:
            payload = row.get("payload") or {}
            data_object = ((payload.get("data") or {}).get("object") or {})
            if _stripe_id(data_object) == object_id:
                return data_object
        return None

    def _find_subscription_for_stripe(self, subscription: dict[str, Any], account_id: Optional[str]) -> Optional[dict[str, Any]]:
        metadata = subscription.get("metadata") or {}
        local_id = metadata.get("billing_subscription_id")
        studio_id = metadata.get("studio_id")
        if local_id and studio_id:
            result = self.supabase.table("billing_subscriptions").select("*").eq("id", local_id).eq("studio_id", studio_id).limit(1).execute()
            if result.data:
                return result.data[0]
        stripe_id = _stripe_id(subscription)
        if not stripe_id:
            return None
        query = self.supabase.table("billing_subscriptions").select("*").eq("stripe_subscription_id", stripe_id).limit(1)
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0] if result.data else None

    def _project_subscription_items(self, subscription: dict[str, Any], group: dict[str, Any]) -> None:
        items = (subscription.get("items") or {}).get("data") or []
        for item in items:
            metadata = item.get("metadata") or {}
            enrollment_id = metadata.get("enrollment_id")
            update = {
                "billing_subscription_id": group.get("id"),
                "stripe_subscription_id": _stripe_id(subscription),
                "stripe_subscription_item_id": _stripe_id(item),
                "billing_status": "current" if subscription.get("status") in {"active", "trialing"} else "past_due",
            }
            if enrollment_id:
                self.supabase.table("student_billing_enrollments").update(update).eq("id", enrollment_id).eq("studio_id", group["studio_id"]).in_("status", ["pending", "active"]).execute()
            self.supabase.table("student_billing_enrollments").update(update).eq("studio_id", group["studio_id"]).eq("billing_subscription_id", group.get("id")).eq("stripe_subscription_item_id", _stripe_id(item)).in_("status", ["pending", "active"]).execute()

    def _subscription_item_id_for_group_plan(self, studio_id: str, group_id: str, plan_id: str) -> Optional[str]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("stripe_subscription_item_id")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("billing_plan_id", plan_id)
            .in_("status", ["pending", "active"])
            .execute()
        )
        for row in result.data or []:
            if row.get("stripe_subscription_item_id"):
                return row["stripe_subscription_item_id"]
        return None

    def _active_enrollment_count_for_subscription_item(
        self,
        studio_id: str,
        group_id: Optional[str],
        item_id: str,
        *,
        exclude_enrollment_id: Optional[str] = None,
    ) -> int:
        if not group_id or not item_id:
            return 0
        result = (
            self.supabase.table("student_billing_enrollments")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("billing_subscription_id", group_id)
            .eq("stripe_subscription_item_id", item_id)
            .in_("status", ["pending", "active"])
            .execute()
        )
        rows = result.data or []
        if exclude_enrollment_id:
            rows = [row for row in rows if row.get("id") != exclude_enrollment_id]
        return len(rows)

    def _find_plan_price(
        self,
        studio_id: str,
        plan_id: str,
        account_id: str,
        amount: int,
        currency: str,
        billing_interval: str,
        recurring: bool,
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_plan_prices")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("billing_plan_id", plan_id)
            .eq("stripe_account_id", account_id)
            .eq("amount_cents", amount)
            .eq("currency", currency)
            .eq("billing_interval", billing_interval)
            .eq("recurring", recurring)
            .eq("active", True)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _update_enrollment(self, enrollment_id: str, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = (
            self.supabase.table("student_billing_enrollments")
            .update(update)
            .eq("id", enrollment_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Billing enrollment not found.")
        return result.data[0]

    def _payer_id_for_customer(self, studio_id: str, account_id: Optional[str], customer_id: Optional[str]) -> Optional[str]:
        if not customer_id:
            return None
        query = (
            self.supabase.table("billing_payers")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("stripe_customer_id", customer_id)
            .limit(1)
        )
        query = query.eq("stripe_account_id", account_id) if account_id else query.is_("stripe_account_id", "null")
        result = query.execute()
        return result.data[0]["id"] if result.data else None

    def _payment_account_by_stripe_account(self, account_id: Optional[str]) -> Optional[dict[str, Any]]:
        if not account_id:
            return None
        result = (
            self.supabase.table("studio_payment_accounts")
            .select("*")
            .eq("stripe_connected_account_id", account_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _stripe_account_for_studio(self, studio_id: str) -> Optional[str]:
        account = self._ensure_payment_account_row(studio_id)
        return account.get("stripe_connected_account_id")

    def _has_stripe_billing_history(self, studio_id: str) -> bool:
        checks = (
            ("billing_plans", "stripe_price_id"),
            ("billing_payers", "stripe_customer_id"),
            ("billing_subscriptions", "stripe_subscription_id"),
            ("billing_invoices", "stripe_invoice_id"),
            ("billing_payments", "stripe_payment_intent_id"),
            ("billing_refunds", "stripe_refund_id"),
            ("billing_disputes", "stripe_dispute_id"),
        )
        for table, column in checks:
            result = (
                self.supabase.table(table)
                .select("id")
                .eq("studio_id", studio_id)
                .not_.is_(column, "null")
                .limit(1)
                .execute()
            )
            if result.data:
                return True
        return False

    def _payment_method_fields_from_customer(self, customer: Any) -> dict[str, Any]:
        invoice_settings = _object_get(customer, "invoice_settings") or {}
        payment_method = _object_get(invoice_settings, "default_payment_method")
        return self._payment_method_fields_from_payment_method(payment_method)

    def _payment_method_fields_from_payment_method(self, payment_method: Any) -> dict[str, Any]:
        if not payment_method:
            return {
                "default_payment_method_id": None,
                "default_payment_method_brand": None,
                "default_payment_method_last4": None,
                "default_payment_method_exp_month": None,
                "default_payment_method_exp_year": None,
            }
        method_type = _object_get(payment_method, "type")
        card = _object_get(payment_method, "card") or {}
        return {
            "default_payment_method_id": _stripe_id(payment_method),
            "default_payment_method_brand": _object_get(card, "brand") or method_type,
            "default_payment_method_last4": _object_get(card, "last4"),
            "default_payment_method_exp_month": _object_get(card, "exp_month"),
            "default_payment_method_exp_year": _object_get(card, "exp_year"),
        }

    def _store_invoice_payment_method(
        self,
        studio_id: str,
        payer_id: str,
        account_id: Optional[str],
        customer_id: Optional[str],
        payment_method: Any,
    ) -> None:
        payment_method_id = _stripe_id(payment_method)
        if not account_id or not customer_id or not payment_method_id:
            return
        try:
            stripe_service = StripeService()
            stripe_service.set_connected_customer_default_payment_method(
                account_id=account_id,
                customer_id=customer_id,
                payment_method_id=payment_method_id,
            )
            customer = stripe_service.retrieve_connected_customer(
                account_id=account_id,
                customer_id=customer_id,
                expand=["invoice_settings.default_payment_method"],
            )
            payment_fields = self._payment_method_fields_from_customer(customer)
        except Exception:
            payment_fields = self._payment_method_fields_from_payment_method(payment_method)
        payment_fields = {key: value for key, value in payment_fields.items() if value is not None}
        if not payment_fields:
            return
        self.supabase.table("billing_payers").update({
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            **payment_fields,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()

    def _subscription_item_id_for_enrollment(self, subscription: Any, enrollment_id: str) -> Optional[str]:
        items = (_object_get(_object_get(subscription, "items") or {}, "data") or [])
        for item in items:
            if (_object_get(item, "metadata") or {}).get("enrollment_id") == enrollment_id:
                return _stripe_id(item)
        return _stripe_id(items[0]) if items else None

    def _latest_charge(self, intent: dict[str, Any]) -> Any:
        latest = intent.get("latest_charge")
        if latest:
            return latest
        charges = (intent.get("charges") or {}).get("data") or []
        return charges[0] if charges else None

    def _payment_method_type(self, intent: dict[str, Any], charge: Any) -> Optional[str]:
        payment_method_types = intent.get("payment_method_types") or []
        if payment_method_types:
            return payment_method_types[0]
        payment_method_details = _object_get(charge, "payment_method_details") or {}
        return _object_get(payment_method_details, "type")

    def _stripe_recurring_for_interval(self, billing_interval: str) -> tuple[Optional[dict[str, Any]], int]:
        if billing_interval == "paid_in_full":
            return None, 1
        if billing_interval == "annual":
            return {"interval": "year", "interval_count": 1}, 1
        if billing_interval == "weekly":
            return {"interval": "week", "interval_count": 1}, 1
        if billing_interval == "biweekly":
            return {"interval": "week", "interval_count": 2}, 2
        return {"interval": "month", "interval_count": 1}, 1

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return round((account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS) / 100, 3)

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        bps = account.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS
        return int(round(amount_cents * bps / 10000))

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return payer.get("autopay_status") == "enabled" and bool(payer.get("autopay_terms_accepted_at"))

    def _idempotency_key(self, *parts: str) -> str:
        return "koaryu:" + ":".join(str(part).replace(":", "_") for part in parts if part is not None)

    def _safe_redirect_url(self, value: Optional[str], default: str) -> str:
        url = (value or default).strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail="Billing redirect URL must be absolute.")
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self._allowed_redirect_origins():
            raise HTTPException(status_code=400, detail="Billing redirect URL is not allowed.")
        return url

    def _allowed_redirect_origins(self) -> set[str]:
        parsed = urlparse(self.settings.FRONTEND_URL.rstrip("/"))
        if not parsed.scheme or not parsed.netloc:
            return set()
        origins = {f"{parsed.scheme}://{parsed.netloc}"}
        if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port:
            alternate_host = "127.0.0.1" if parsed.hostname == "localhost" else "localhost"
            origins.add(f"http://{alternate_host}:{parsed.port}")
        return origins

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if len(normalized) > 255:
            raise HTTPException(status_code=400, detail="Idempotency-Key must be 255 characters or fewer.")
        return normalized

    def _invoice_request_hash(self, data: BillingInvoiceCreate) -> str:
        payload = data.model_dump(mode="json", exclude_none=True)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _is_stale_stripe_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row.get("last_stripe_event_created")
        return last_created is not None and int(last_created) > int(event_created)

    def _update_invoice_last_event(self, invoice: dict[str, Any], studio_id: str, event_created: int) -> dict[str, Any]:
        result = (
            self.supabase.table("billing_invoices")
            .update({"last_stripe_event_created": event_created})
            .eq("id", invoice["id"])
            .eq("studio_id", studio_id)
            .execute()
        )
        return result.data[0] if result.data else {**invoice, "last_stripe_event_created": event_created}

    def _claim_invoice_create_request(
        self,
        studio_id: str,
        idempotency_key: Optional[str],
        request_hash: str,
        invoice_row: dict[str, Any],
    ) -> dict[str, Any]:
        if idempotency_key:
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if existing:
                if existing.get("request_hash") != request_hash:
                    raise HTTPException(
                        status_code=409,
                        detail="This idempotency key is already in use for a different invoice request.",
                    )
                return existing
        try:
            inserted = self.supabase.table("billing_invoices").insert(invoice_row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505" or not idempotency_key:
                raise
            existing = self._find_invoice_by_idempotency_key(studio_id, idempotency_key)
            if not existing:
                raise
            if existing.get("request_hash") != request_hash:
                raise HTTPException(
                    status_code=409,
                    detail="This idempotency key is already in use for a different invoice request.",
                ) from exc
            return existing
        if not inserted.data:
            raise HTTPException(status_code=500, detail="Failed to create invoice.")
        return inserted.data[0]

    def _find_invoice_by_idempotency_key(self, studio_id: str, idempotency_key: str) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("billing_invoices")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("idempotency_key", idempotency_key)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _insert_invoice_item_once(self, row: dict[str, Any]) -> None:
        try:
            self.supabase.table("billing_invoice_items").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "23505":
                raise

    def _timestamp(self, value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    def _epoch_seconds(self, value: Any) -> Optional[float]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, datetime):
            parsed = value
        else:
            try:
                parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except ValueError:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()

    def _date_from_epoch(self, value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).date().isoformat()
        return str(value)

    def _date_to_epoch(self, value: str) -> int:
        parsed = date.fromisoformat(value)
        return int(datetime.combine(parsed, time.min, tzinfo=timezone.utc).timestamp())

    def _local_invoice_status(self, stripe_status: str) -> str:
        if stripe_status == "void":
            return "void"
        if stripe_status == "uncollectible":
            return "uncollectible"
        if stripe_status in {"draft", "open", "paid"}:
            return stripe_status
        return "open"

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        if not payer_id:
            return
        result = (
            self.supabase.table("billing_invoices")
            .select("amount_due_cents, amount_paid_cents, amount_remaining_cents, status, external")
            .eq("studio_id", studio_id)
            .eq("payer_id", payer_id)
            .in_("status", ["draft", "open", "uncollectible"])
            .execute()
        )
        balance = 0
        for row in result.data or []:
            remaining = row.get("amount_remaining_cents")
            if remaining is None:
                remaining = max(0, int(row.get("amount_due_cents") or 0) - int(row.get("amount_paid_cents") or 0))
            balance += max(0, int(remaining or 0))
        billing_status = "current" if balance == 0 else "past_due"
        self.supabase.table("billing_payers").update({
            "balance_cents": balance,
            "billing_status": billing_status,
        }).eq("id", payer_id).eq("studio_id", studio_id).execute()


    def _ensure_payment_account_row(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studio_payment_accounts")
            .select("*")
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
        insert_result = self.supabase.table("studio_payment_accounts").insert({"studio_id": studio_id}).execute()
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to initialize payment account.")
        return insert_result.data[0]

    def _update_payment_account(self, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = self.supabase.table("studio_payment_accounts").update(update).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payment account not found.")
        return result.data[0]

    def _update_payment_account_by_stripe_account(self, account_id: Optional[str], update: dict[str, Any]) -> None:
        if not account_id:
            return
        self.supabase.table("studio_payment_accounts").update(update).eq("stripe_connected_account_id", account_id).execute()

    def _refresh_connect_account_status(self, account: dict[str, Any], *, strict: bool) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return account
        try:
            stripe_account = StripeService().retrieve_account(account_id=account_id)
        except HTTPException:
            if strict:
                raise
            return account
        update = self._connect_account_update_from_stripe(stripe_account)
        return self._update_payment_account(account["studio_id"], update)

    def _should_refresh_connect_account(self, account: dict[str, Any]) -> bool:
        if not account.get("stripe_connected_account_id"):
            return False
        if not account.get("charges_enabled") or account.get("requirements_due"):
            return True
        updated_at = account.get("updated_at")
        if isinstance(updated_at, datetime):
            updated = updated_at
        elif isinstance(updated_at, str):
            try:
                updated = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            except ValueError:
                return True
        else:
            return True
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - updated >= CONNECT_STATUS_STALE_AFTER

    def _connect_account_update_from_stripe(self, stripe_account: Any) -> dict[str, Any]:
        requirements = _object_get(stripe_account, "requirements") or {}
        due = _object_get(requirements, "currently_due") or []
        charges_enabled = bool(_object_get(stripe_account, "charges_enabled"))
        details_submitted = bool(_object_get(stripe_account, "details_submitted"))
        status_value = "charges_enabled" if charges_enabled else ("action_required" if due else "onboarding_incomplete")
        return {
            "status": status_value,
            "charges_enabled": charges_enabled,
            "payouts_enabled": bool(_object_get(stripe_account, "payouts_enabled")),
            "details_submitted": details_submitted,
            "requirements_due": list(due),
        }

    def _payment_account_response(self, row: dict[str, Any]) -> StudioPaymentAccountResponse:
        return StudioPaymentAccountResponse(
            studio_id=row["studio_id"],
            stripe_connected_account_id=row.get("stripe_connected_account_id"),
            status=row.get("status") or "not_connected",
            charges_enabled=bool(row.get("charges_enabled")),
            payouts_enabled=bool(row.get("payouts_enabled")),
            details_submitted=bool(row.get("details_submitted")),
            requirements_due=row.get("requirements_due") or [],
            platform_fee_bps=row.get("platform_fee_bps") or self.settings.BILLING_PLATFORM_FEE_BPS,
            created_at=_to_text(row.get("created_at")),
            updated_at=_to_text(row.get("updated_at")),
        )

    def _plan_response(self, row: dict[str, Any], account: dict[str, Any]) -> BillingPlanResponse:
        programs = self._programs_for_plan(row["studio_id"], row["id"])
        can_accept = bool(account.get("charges_enabled")) and row.get("status") == "active" and bool(row.get("stripe_price_id"))
        pending_reason = None
        if not account.get("charges_enabled"):
            pending_reason = "Stripe Connect charges are not enabled yet."
        elif not row.get("stripe_price_id"):
            pending_reason = "Plan needs a Stripe price before hosted payments can start."
        elif row.get("status") == "pending":
            pending_reason = "Plan is waiting for payment setup before it can accept payments."
        return BillingPlanResponse(
            **row,
            programs=programs,
            can_accept_payments=can_accept,
            pending_reason=pending_reason,
        )

    def _programs_for_plan(self, studio_id: str, plan_id: str) -> list[BillingPlanProgramResponse]:
        result = (
            self.supabase.table("billing_plan_programs")
            .select("program_id, programs(name, color_hex)")
            .eq("studio_id", studio_id)
            .eq("billing_plan_id", plan_id)
            .execute()
        )
        programs: list[BillingPlanProgramResponse] = []
        for row in result.data or []:
            program = row.get("programs") or {}
            if isinstance(program, list):
                program = program[0] if program else {}
            programs.append(BillingPlanProgramResponse(
                program_id=row["program_id"],
                program_name=program.get("name"),
                program_color_hex=program.get("color_hex"),
            ))
        return programs

    def _replace_plan_programs(self, studio_id: str, plan_id: str, program_ids: list[str]) -> None:
        self.supabase.table("billing_plan_programs").delete().eq("studio_id", studio_id).eq("billing_plan_id", plan_id).execute()
        rows = [
            {"studio_id": studio_id, "billing_plan_id": plan_id, "program_id": program_id}
            for program_id in dict.fromkeys(program_ids)
        ]
        if rows:
            self.supabase.table("billing_plan_programs").insert(rows).execute()

    def _ensure_programs_in_studio(self, studio_id: str, program_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(program_ids))
        if not unique_ids:
            return
        result = self.supabase.table("programs").select("id").eq("studio_id", studio_id).in_("id", unique_ids).execute()
        found = {row["id"] for row in (result.data or [])}
        if found != set(unique_ids):
            raise HTTPException(status_code=404, detail="One or more programs were not found in this studio.")

    def _ensure_record_in_studio(self, table: str, record_id: str, studio_id: str, detail: str) -> None:
        result = self.supabase.table(table).select("id").eq("id", record_id).eq("studio_id", studio_id).limit(1).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)

    def _get_row_or_404(self, table: str, record_id: str, studio_id: str, detail: str) -> dict[str, Any]:
        result = self.supabase.table(table).select("*").eq("id", record_id).eq("studio_id", studio_id).maybe_single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = self.supabase.table("studios").select("id, name, owner_id").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _get_user_email(self, user_id: Optional[str]) -> Optional[str]:
        if not user_id:
            return None
        try:
            result = self.supabase.auth.admin.get_user_by_id(user_id)
        except Exception:
            return None
        user = getattr(result, "user", None)
        return getattr(user, "email", None)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()

    def _audit_best_effort(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        try:
            self._audit(studio_id, actor_id, action, entity_id, metadata)
        except Exception:
            return
