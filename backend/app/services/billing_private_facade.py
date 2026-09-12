from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException

from app.services.billing_audit import record_billing_audit
from app.services.billing_autopay import payer_autopay_authorized
from app.services.billing_fees import application_fee_percent
from app.services.billing_payers import recompute_payer_balance
from app.services.platform_billing_helpers import build_idempotency_key


class BillingPrivateFacadeMixin:
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

    def _application_fee_percent(self, account: dict[str, Any]) -> float:
        return application_fee_percent(
            account.get("platform_fee_bps"), self.settings.BILLING_PLATFORM_FEE_BPS
        )

    def _payer_autopay_authorized(self, payer: dict[str, Any]) -> bool:
        return payer_autopay_authorized(self.supabase, self._connect_accounts(), payer)

    def _idempotency_key(self, *parts: str) -> str:
        return build_idempotency_key(*parts)

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

    def _audit(
        self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]
    ) -> None:
        record_billing_audit(
            self.supabase,
            studio_id,
            actor_id,
            action,
            entity_id,
            metadata,
        )
