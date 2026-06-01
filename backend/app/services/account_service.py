import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.schemas.account import (
    AccountDeletionProcessFailure,
    AccountDeletionProcessResponse,
    AccountDeletionRequestCreate,
    AccountDeletionRequestResponse,
)
from app.services.studio_scope import resolve_staff_role_for_user
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row, rpc_rows


DELETION_DELAY_DAYS = 30
ACCOUNT_DELETION_PROCESSING_STALE_AFTER = timedelta(minutes=30)


def _to_text(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if text else None


class AccountService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def get_deletion_request(self, user_id: str) -> Optional[AccountDeletionRequestResponse]:
        row = self._get_scheduled_deletion_row(user_id)
        return self._to_response(row) if row else None

    async def schedule_deletion(
        self,
        data: AccountDeletionRequestCreate,
        user_id: str,
        requested_studio_id: Optional[str],
    ) -> AccountDeletionRequestResponse:
        existing = self._get_scheduled_deletion_row(user_id)
        if existing:
            return self._to_response(existing)

        studio_id = self._resolve_requested_studio_id(user_id, requested_studio_id)
        self._ensure_deletion_will_not_orphan_studios(user_id)

        user = self._get_auth_user(user_id)
        requester_email = getattr(user, "email", None)
        if not requester_email:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not verify your account email. Please try again.",
            )

        now = datetime.now(timezone.utc)
        scheduled_for = now + timedelta(days=DELETION_DELAY_DAYS)
        try:
            result = (
                self.supabase.table("account_deletion_requests")
                .insert({
                    "user_id": user_id,
                    "studio_id": studio_id,
                    "requested_by": user_id,
                    "requester_email": requester_email,
                    "status": "scheduled",
                    "requested_at": now.isoformat(),
                    "scheduled_for": scheduled_for.isoformat(),
                    "reason": data.reason,
                    "metadata": {"delay_days": DELETION_DELAY_DAYS},
                })
                .execute()
            )
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                existing = self._get_scheduled_deletion_row(user_id)
                if existing:
                    return self._to_response(existing)
            if exc.code in {"23514", "P0001"}:
                detail = (
                    getattr(exc, "message", None)
                    or "Account deletion would leave a studio without an active admin."
                )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=detail,
                ) from exc
            raise

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to schedule account deletion.",
            )

        self._audit(studio_id, user_id, "account.deletion_scheduled", result.data[0]["id"], {
            "scheduled_for": scheduled_for.isoformat(),
        })
        return self._to_response(result.data[0])

    async def cancel_deletion(
        self,
        user_id: str,
        requested_studio_id: Optional[str],
    ) -> Optional[AccountDeletionRequestResponse]:
        existing = self._get_scheduled_deletion_row(user_id)
        if not existing:
            return None

        now = datetime.now(timezone.utc).isoformat()
        result = (
            self.supabase.table("account_deletion_requests")
            .update({
                "status": "canceled",
                "canceled_at": now,
                "canceled_by": user_id,
            })
            .eq("id", existing["id"])
            .eq("user_id", user_id)
            .eq("status", "scheduled")
            .is_("processing_token", "null")
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Account deletion request could not be canceled. Refresh and try again.",
            )

        studio_id = self._resolve_requested_studio_id(user_id, requested_studio_id)
        self._audit(studio_id, user_id, "account.deletion_canceled", result.data[0]["id"], {})
        return self._to_response(result.data[0])

    async def process_due_deletions(self, *, limit: int = 50) -> AccountDeletionProcessResponse:
        response = AccountDeletionProcessResponse()

        for claimed_row, claim_token in self._claim_due_deletion_requests(limit=limit):
            response.processed += 1
            request_id = str(claimed_row["id"])
            user_id = _optional_text(claimed_row.get("user_id"))
            if not user_id:
                if self._mark_deletion_completed(request_id, processing_token=claim_token):
                    response.completed += 1
                else:
                    response.failed += 1
                    response.failures.append(AccountDeletionProcessFailure(
                        request_id=request_id,
                        user_id=None,
                        detail="Account deletion claim was lost before completion.",
                    ))
                continue

            try:
                self._ensure_deletion_will_not_orphan_studios(user_id)
            except HTTPException as exc:
                if self._mark_deletion_canceled(
                    request_id,
                    f"Processing blocked: {exc.detail}",
                    processing_token=claim_token,
                ):
                    response.blocked += 1
                else:
                    response.failed += 1
                    response.failures.append(AccountDeletionProcessFailure(
                        request_id=request_id,
                        user_id=user_id,
                        detail="Account deletion claim was lost before cancellation.",
                    ))
                continue

            try:
                self.supabase.auth.admin.delete_user(user_id)
                if self._mark_deletion_completed(request_id, processing_token=claim_token):
                    response.completed += 1
                else:
                    response.failed += 1
                    response.failures.append(AccountDeletionProcessFailure(
                        request_id=request_id,
                        user_id=user_id,
                        detail="Account deletion claim was lost after Auth deletion.",
                    ))
            except Exception as exc:
                response.failed += 1
                response.failures.append(AccountDeletionProcessFailure(
                    request_id=request_id,
                    user_id=user_id,
                    detail=str(exc) or exc.__class__.__name__,
                ))

        return response

    def _claim_due_deletion_requests(self, *, limit: int) -> list[tuple[dict[str, Any], str]]:
        claim_token = uuid.uuid4().hex
        result = execute_required_rpc(self.supabase, "claim_due_account_deletion_requests", {
            "p_limit": limit,
            "p_processing_token": claim_token,
            "p_stale_after_seconds": int(ACCOUNT_DELETION_PROCESSING_STALE_AFTER.total_seconds()),
        })
        return [(row, claim_token) for row in rpc_rows(result)]

    def _get_scheduled_deletion_row(self, user_id: str) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("account_deletion_requests")
            .select("*")
            .eq("user_id", user_id)
            .eq("status", "scheduled")
            .limit(1)
            .execute()
        )
        return (result.data or [None])[0]

    def _mark_deletion_completed(self, request_id: str, *, processing_token: str) -> bool:
        result = execute_required_rpc(self.supabase, "finish_account_deletion_request", {
            "p_request_id": request_id,
            "p_processing_token": processing_token,
            "p_status": "completed",
            "p_reason": None,
        })
        row = first_rpc_row(result) or {}
        return bool(row.get("updated"))

    def _mark_deletion_canceled(
        self,
        request_id: str,
        reason: str,
        *,
        processing_token: str,
    ) -> bool:
        result = execute_required_rpc(self.supabase, "finish_account_deletion_request", {
            "p_request_id": request_id,
            "p_processing_token": processing_token,
            "p_status": "canceled",
            "p_reason": reason[:500],
        })
        row = first_rpc_row(result) or {}
        return bool(row.get("updated"))

    def _resolve_requested_studio_id(self, user_id: str, requested_studio_id: Optional[str]) -> Optional[str]:
        try:
            return resolve_staff_role_for_user(self.supabase, user_id, requested_studio_id)["studio_id"]
        except HTTPException:
            return None

    def _ensure_deletion_will_not_orphan_studios(self, user_id: str) -> None:
        owned_studios = (
            self.supabase.table("studios")
            .select("id")
            .eq("owner_id", user_id)
            .execute()
        )
        if owned_studios.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Transfer studio ownership before deleting this account.",
            )

        admin_roles = (
            self.supabase.table("staff_roles")
            .select("studio_id")
            .eq("user_id", user_id)
            .eq("role", "admin")
            .execute()
        )
        for role in admin_roles.data or []:
            studio_id = role["studio_id"]
            admins = (
                self.supabase.table("staff_roles")
                .select("user_id")
                .eq("studio_id", studio_id)
                .eq("role", "admin")
                .execute()
            )
            surviving_admins = [
                admin["user_id"]
                for admin in (admins.data or [])
                if (
                    admin.get("user_id") != user_id
                    and not self._get_scheduled_deletion_row(admin.get("user_id"))
                    and self._auth_user_is_active(admin.get("user_id"))
                )
            ]
            if not surviving_admins:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Add another active admin before deleting this account.",
                )


    def _get_auth_user(self, user_id: str) -> Any:
        try:
            response = self.supabase.auth.admin.get_user_by_id(user_id)
            return response.user
        except Exception:
            return None

    def _auth_user_is_active(self, user_id: Optional[str]) -> bool:
        if not user_id:
            return False
        user = self._get_auth_user(user_id)
        return bool(
            getattr(user, "last_sign_in_at", None)
            or getattr(user, "confirmed_at", None)
            or getattr(user, "email_confirmed_at", None)
        )

    def _audit(
        self,
        studio_id: Optional[str],
        actor_id: str,
        action: str,
        entity_id: str,
        metadata: dict[str, Any],
    ) -> None:
        if not studio_id:
            return
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "account_deletion_request",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()

    def _to_response(self, row: dict[str, Any]) -> AccountDeletionRequestResponse:
        return AccountDeletionRequestResponse(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            studio_id=_optional_text(row.get("studio_id")),
            requester_email=str(row.get("requester_email") or ""),
            status=row["status"],
            requested_at=_to_text(row.get("requested_at")),
            scheduled_for=_to_text(row.get("scheduled_for")),
            canceled_at=_optional_text(row.get("canceled_at")),
            completed_at=_optional_text(row.get("completed_at")),
            reason=_optional_text(row.get("reason")),
        )
