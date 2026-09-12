from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, status

from app.services.billing_fees import application_fee_amount, application_fee_percent
from app.services.billing_provider_operations import (
    AUTOPAY_TERMS_VERSION,
    BillingProviderOperationCoordinator,
)
from app.services.billing_payers import recompute_payer_balance
from app.services.platform_billing_helpers import build_idempotency_key


class BillingPrivateFacadeMixin:
    def _ensure_connect_ready(self, studio_id: str) -> dict[str, Any]:
        account = self._connect_accounts().ensure_row(studio_id)
        if not account.get("stripe_connected_account_id"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Connect Stripe before using hosted payments.",
            )
        account = self._connect_accounts().refresh_status(account, strict=True)
        if not account.get("charges_enabled"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stripe Connect charges are not enabled yet.",
            )
        return account

    def _project_invoice_event(
        self,
        invoice: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        self._webhook_projector()._project_invoice_event(
            invoice, account_id, event_type, event_created
        )

    def _project_payment_intent(
        self,
        intent: dict[str, Any],
        account_id: Optional[str],
        event_type: str,
        event_created: Optional[int] = None,
    ) -> None:
        self._webhook_projector()._project_payment_intent(
            intent, account_id, event_type, event_created
        )

    def _project_refund(
        self,
        refund: Any,
        account_id: Optional[str],
        *,
        charge: Optional[dict[str, Any]] = None,
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        return self._webhook_projector()._project_refund(
            refund,
            account_id,
            charge=charge,
            event_created=event_created,
        )

    def _project_subscription(
        self,
        subscription: dict[str, Any],
        account_id: Optional[str],
        event_type: str = "",
        event_created: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._project_subscription(
            subscription, account_id, event_type, event_created
        )

    def _update_invoice_from_stripe(
        self,
        invoice_id: str,
        studio_id: str,
        invoice: Any,
        account_id: Optional[str],
        *,
        event_created: Optional[int] = None,
    ) -> dict[str, Any]:
        return self._webhook_projector()._update_invoice_from_stripe(
            invoice_id,
            studio_id,
            invoice,
            account_id,
            event_created=event_created,
        )

    def _find_invoice_for_stripe(
        self, invoice: dict[str, Any], account_id: Optional[str]
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_invoice_for_stripe(invoice, account_id)

    def _find_payment_by_intent(
        self, account_id: Optional[str], payment_intent_id: Optional[str]
    ) -> Optional[dict[str, Any]]:
        return self._webhook_projector()._find_payment_by_intent(account_id, payment_intent_id)

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
        return self._webhook_projector()._stored_stripe_event_object(
            account_id, object_id, event_types
        )

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

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return application_fee_percent(
            account.get("platform_fee_bps"), self.settings.BILLING_PLATFORM_FEE_BPS
        )

    def _application_fee_amount(self, amount_cents: int, account: dict[str, Any]) -> int:
        return application_fee_amount(
            amount_cents, account.get("platform_fee_bps"), self.settings.BILLING_PLATFORM_FEE_BPS
        )

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        if (
            payer.get("autopay_status") != "enabled"
            or not payer.get("autopay_terms_accepted_at")
            or not payer.get("default_payment_method_id")
            or not payer.get("stripe_account_id")
            or not payer.get("studio_id")
            or not payer.get("id")
        ):
            return False
        account = self._connect_accounts().by_stripe_account(payer["stripe_account_id"])
        if not account or account.get("studio_id") != payer.get("studio_id"):
            return False
        raw_generation = (account.get("metadata") or {}).get("connect_account_generation") or 1
        try:
            generation = int(raw_generation)
        except (TypeError, ValueError):
            return False
        if generation <= 0:
            return False
        try:
            consent = BillingProviderOperationCoordinator(self.supabase).read_active_payer_consent(
                studio_id=payer["studio_id"],
                payer_id=payer["id"],
                terms_version=AUTOPAY_TERMS_VERSION,
                stripe_connected_account_id=payer["stripe_account_id"],
                connect_account_generation=generation,
            )
        except Exception:
            return False
        return bool(
            consent.get("completed_at")
            and not consent.get("revoked_at")
            and not consent.get("superseded_at")
            and consent.get("accepted_at") == payer.get("autopay_terms_accepted_at")
        )

    def _idempotency_key(self, *parts: str) -> str:
        return build_idempotency_key(*parts)

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
        if (
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1"}
            and parsed.port
        ):
            alternate_host = "127.0.0.1" if parsed.hostname == "localhost" else "localhost"
            origins.add(f"http://{alternate_host}:{parsed.port}")
        return origins

    def _recompute_payer_balance(self, studio_id: str, payer_id: Optional[str]) -> None:
        recompute_payer_balance(self.supabase, studio_id, payer_id)

    def _ensure_record_in_studio(
        self, table: str, record_id: str, studio_id: str, detail: str
    ) -> None:
        result = (
            self.supabase.table(table)
            .select("id")
            .eq("id", record_id)
            .eq("studio_id", studio_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)

    def _get_row_or_404(
        self, table: str, record_id: str, studio_id: str, detail: str
    ) -> dict[str, Any]:
        result = (
            self.supabase.table(table)
            .select("*")
            .eq("id", record_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail=detail)
        return result.data

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studios")
            .select("id, name, owner_id")
            .eq("id", studio_id)
            .single()
            .execute()
        )
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

    def _audit(
        self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]
    ) -> None:
        self.supabase.table("audit_logs").insert(
            {
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": action,
                "entity_type": "billing",
                "entity_id": entity_id,
                "metadata": metadata,
            }
        ).execute()

    def _audit_best_effort(
        self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]
    ) -> None:
        try:
            self._audit(studio_id, actor_id, action, entity_id, metadata)
        except Exception:
            return
