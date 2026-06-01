from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException

from app.schemas.billing import StudioPaymentAccountResponse
from app.services.billing_invoice_projection import _object_get, _to_text
from app.services.billing_webhook_event_state import (
    ACCOUNT_STATUS_ORDER,
    add_stripe_event_created_guard,
    is_same_second_status_regression,
)
from app.services.stripe_service import StripeService


CONNECT_STATUS_STALE_AFTER = timedelta(minutes=15)


class BillingConnectAccountStore:
    def __init__(self, supabase, *, settings, stripe_service_cls=StripeService):
        self.supabase = supabase
        self.settings = settings
        self.stripe_service_cls = stripe_service_cls

    def ensure_row(self, studio_id: str) -> dict[str, Any]:
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

    def update(self, studio_id: str, update: dict[str, Any]) -> dict[str, Any]:
        result = self.supabase.table("studio_payment_accounts").update(update).eq("studio_id", studio_id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Payment account not found.")
        return result.data[0]

    def update_by_stripe_account(
        self,
        account_id: Optional[str],
        update: dict[str, Any],
        *,
        event_created: Optional[int] = None,
    ) -> None:
        if not account_id:
            return
        update_payload = dict(update)
        current = self.by_stripe_account(account_id)
        if current and is_same_second_status_regression(
            current.get("last_stripe_event_created"),
            event_created,
            current_status=current.get("status"),
            incoming_status=update_payload.get("status"),
            status_order=ACCOUNT_STATUS_ORDER,
        ):
            return
        if event_created is not None:
            update_payload["last_stripe_event_created"] = event_created
        query = (
            self.supabase.table("studio_payment_accounts")
            .update(update_payload)
            .eq("stripe_connected_account_id", account_id)
        )
        if update_payload.get("status") != "deauthorized":
            query = query.neq("status", "deauthorized")
        query = add_stripe_event_created_guard(query, event_created)
        query.execute()

    def by_stripe_account(self, account_id: Optional[str]) -> Optional[dict[str, Any]]:
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

    def refresh_status(self, account: dict[str, Any], *, strict: bool) -> dict[str, Any]:
        account_id = account.get("stripe_connected_account_id")
        if not account_id:
            return account
        try:
            stripe_account = self.stripe_service_cls().retrieve_account(account_id=account_id)
        except HTTPException:
            if strict:
                raise
            return account
        update = self.update_from_stripe(stripe_account)
        return self.update(account["studio_id"], update)

    def should_refresh(self, account: dict[str, Any]) -> bool:
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

    def update_from_stripe(self, stripe_account: Any) -> dict[str, Any]:
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

    def response(self, row: dict[str, Any]) -> StudioPaymentAccountResponse:
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
