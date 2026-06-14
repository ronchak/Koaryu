from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, status
from gotrue.errors import AuthApiError
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.staff import StaffInviteCreate, StaffMemberResponse, StaffRoleUpdate

BASE_STAFF_ROLE_COLUMNS = "id, studio_id, user_id, role, created_at"
EXTENDED_STAFF_ROLE_COLUMNS = (
    "id, studio_id, user_id, role, invited_by, invited_email, created_at, updated_at"
)


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _user_full_name(user: Any) -> Optional[str]:
    metadata = getattr(user, "user_metadata", None) or {}
    value = metadata.get("full_name") or metadata.get("name")
    return str(value) if value else None


def _staff_status(user: Any) -> str:
    if not user:
        return "pending"
    if (
        getattr(user, "last_sign_in_at", None)
        or getattr(user, "confirmed_at", None)
        or getattr(user, "email_confirmed_at", None)
    ):
        return "active"
    return "pending"


class StaffService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def list_staff(self, studio_id: str) -> list[StaffMemberResponse]:
        result = self._list_staff_role_rows(studio_id)

        return [self._hydrate_staff_member(row) for row in (result.data or [])]

    async def invite_staff(
        self,
        data: StaffInviteCreate,
        studio_id: str,
        actor_id: str,
    ) -> StaffMemberResponse:
        try:
            pending_result = self._insert_staff_role_with_metadata(
                {
                    "studio_id": studio_id,
                    "user_id": None,
                    "role": data.role,
                    "invited_by": actor_id,
                    "invited_email": data.email,
                }
            )
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That user is already a staff member in this studio.",
                ) from exc
            raise

        if not pending_result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create staff invite.",
            )

        pending_role = pending_result.data[0]
        settings = get_settings()
        try:
            invite_response = self.supabase.auth.admin.invite_user_by_email(
                data.email,
                {"redirect_to": f"{settings.FRONTEND_URL}/auth/callback"},
            )
        except AuthApiError as exc:
            self._delete_pending_staff_role(pending_role["id"], studio_id)
            if exc.code in {"email_exists", "user_already_exists", "conflict"}:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That email already has an account. Existing-account linking is not supported yet.",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=exc.message or "Failed to send staff invite.",
            ) from exc
        except Exception:
            self._delete_pending_staff_role(pending_role["id"], studio_id)
            raise

        user = invite_response.user
        if not user or not getattr(user, "id", None):
            self._delete_pending_staff_role(pending_role["id"], studio_id)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Supabase did not return an invited user.",
            )

        try:
            result = self._link_pending_staff_role(pending_role["id"], studio_id, user.id)
        except PostgrestAPIError as exc:
            self._cleanup_failed_invite_link(pending_role["id"], studio_id, user.id)
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That user is already a staff member in this studio.",
                ) from exc
            raise
        except Exception:
            self._cleanup_failed_invite_link(pending_role["id"], studio_id, user.id)
            raise

        if not result.data:
            try:
                result = self._recover_missing_pending_staff_role(data, studio_id, actor_id, user.id)
            except Exception:
                self._delete_invited_auth_user(user.id)
                raise

        if not result.data:
            self._delete_invited_auth_user(user.id)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to link staff invite.",
            )

        self._audit(
            studio_id,
            actor_id,
            "staff.invited",
            result.data[0]["id"],
            {
                "email": data.email,
                "role": data.role,
                "target_user_id": user.id,
            },
        )

        return self._hydrate_staff_member(result.data[0], user)

    async def update_staff_role(
        self,
        staff_role_id: str,
        data: StaffRoleUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StaffMemberResponse:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        previous_role = staff_role["role"]

        if previous_role == data.role:
            return self._hydrate_staff_member(staff_role)

        self._ensure_owner_not_demoted_or_removed(studio_id, staff_role["user_id"], data.role)
        if previous_role == "admin" and data.role != "admin":
            self._ensure_more_than_one_admin(studio_id, staff_role["user_id"])

        try:
            result = (
                self.supabase.table("staff_roles")
                .update({"role": data.role})
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            self._raise_admin_integrity_conflict(exc)

        if not result.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Staff member not found.")

        self._audit(
            studio_id,
            actor_id,
            "staff.role_updated",
            staff_role_id,
            {
                "target_user_id": staff_role["user_id"],
                "previous_role": previous_role,
                "new_role": data.role,
            },
        )

        return self._hydrate_staff_member(result.data[0])

    def _list_staff_role_rows(self, studio_id: str):
        try:
            return (
                self.supabase.table("staff_roles")
                .select(EXTENDED_STAFF_ROLE_COLUMNS)
                .eq("studio_id", studio_id)
                .order("created_at")
                .execute()
            )
        except PostgrestAPIError as exc:
            if exc.code != "42703":
                raise
            return (
                self.supabase.table("staff_roles")
                .select(BASE_STAFF_ROLE_COLUMNS)
                .eq("studio_id", studio_id)
                .order("created_at")
                .execute()
            )

    def _insert_staff_role_with_metadata(self, row: dict):
        try:
            return self.supabase.table("staff_roles").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code != "42703":
                raise
            base_row = {
                "studio_id": row["studio_id"],
                "user_id": row["user_id"],
                "role": row["role"],
            }
            return self.supabase.table("staff_roles").insert(base_row).execute()

    def _link_pending_staff_role(self, staff_role_id: str, studio_id: str, user_id: str):
        return (
            self.supabase.table("staff_roles")
            .update({"user_id": user_id})
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .execute()
        )

    def _recover_missing_pending_staff_role(
        self,
        data: StaffInviteCreate,
        studio_id: str,
        actor_id: str,
        user_id: str,
    ):
        try:
            recovered = self._insert_staff_role_with_metadata(
                {
                    "studio_id": studio_id,
                    "user_id": None,
                    "role": data.role,
                    "invited_by": actor_id,
                    "invited_email": data.email,
                }
            )
        except PostgrestAPIError as exc:
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That user is already a staff member in this studio.",
                ) from exc
            raise

        if not recovered.data:
            return recovered

        recovered_role_id = recovered.data[0]["id"]
        try:
            result = self._link_pending_staff_role(recovered_role_id, studio_id, user_id)
        except PostgrestAPIError as exc:
            self._delete_pending_staff_role(recovered_role_id, studio_id)
            if exc.code == "23505":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That user is already a staff member in this studio.",
                ) from exc
            raise
        except Exception:
            self._delete_pending_staff_role(recovered_role_id, studio_id)
            raise

        if not result.data:
            self._delete_pending_staff_role(recovered_role_id, studio_id)
        return result

    def _delete_pending_staff_role(self, staff_role_id: str, studio_id: str) -> None:
        (
            self.supabase.table("staff_roles")
            .delete()
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .is_("user_id", None)
            .execute()
        )

    def _delete_invited_auth_user(self, user_id: Optional[str]) -> None:
        if not user_id:
            return
        try:
            self.supabase.auth.admin.delete_user(user_id)
        except Exception:
            return

    def _cleanup_failed_invite_link(
        self,
        staff_role_id: str,
        studio_id: str,
        user_id: Optional[str],
    ) -> None:
        try:
            self._delete_pending_staff_role(staff_role_id, studio_id)
        except Exception:
            pass
        self._delete_invited_auth_user(user_id)

    async def remove_staff(
        self,
        staff_role_id: str,
        studio_id: str,
        actor_id: str,
    ) -> None:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        self._ensure_owner_not_demoted_or_removed(studio_id, staff_role["user_id"], None)
        if staff_role["role"] == "admin":
            self._ensure_more_than_one_admin(studio_id, staff_role["user_id"])

        staff_member = self._hydrate_staff_member(staff_role)
        try:
            result = (
                self.supabase.table("staff_roles")
                .delete()
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            self._raise_admin_integrity_conflict(exc)

        if not result.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Staff member not found.")

        self._audit(
            studio_id,
            actor_id,
            "staff.removed",
            staff_role_id,
            {
                "target_user_id": staff_role["user_id"],
                "previous_role": staff_role["role"],
                "email": staff_member.email,
            },
        )

    def _hydrate_staff_member(self, row: dict, user: Any = None) -> StaffMemberResponse:
        user_id = row.get("user_id")
        if user is None:
            user = self._get_auth_user(user_id)

        return StaffMemberResponse(
            id=row["id"],
            studio_id=row["studio_id"],
            user_id=user_id,
            email=(getattr(user, "email", None) or row.get("invited_email") or ""),
            full_name=_user_full_name(user),
            role=row["role"],
            status=_staff_status(user),
            invited_by=row.get("invited_by"),
            created_at=_to_text(row.get("created_at")) or "",
            updated_at=_to_text(row.get("updated_at")) or _to_text(row.get("created_at")) or "",
            last_sign_in_at=_to_text(getattr(user, "last_sign_in_at", None)),
        )

    def _get_auth_user(self, user_id: Optional[str]) -> Any:
        if not user_id:
            return None
        try:
            user_response = self.supabase.auth.admin.get_user_by_id(user_id)
            return user_response.user
        except Exception:
            return None

    def _get_staff_role_or_404(self, staff_role_id: str, studio_id: str) -> dict:
        try:
            result = (
                self.supabase.table("staff_roles")
                .select(EXTENDED_STAFF_ROLE_COLUMNS)
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .limit(1)
                .execute()
            )
        except PostgrestAPIError as exc:
            if exc.code != "42703":
                raise
            result = (
                self.supabase.table("staff_roles")
                .select(BASE_STAFF_ROLE_COLUMNS)
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .limit(1)
                .execute()
            )
        if not result.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Staff member not found.")
        return result.data[0]

    def _ensure_owner_not_demoted_or_removed(
        self,
        studio_id: str,
        target_user_id: Optional[str],
        next_role: Optional[str],
    ) -> None:
        result = (
            self.supabase.table("studios")
            .select("owner_id")
            .eq("id", studio_id)
            .limit(1)
            .execute()
        )
        owner_id = result.data[0]["owner_id"] if result.data else None
        if owner_id == target_user_id and next_role != "admin":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The studio owner must remain an admin.",
            )

    def _ensure_more_than_one_admin(self, studio_id: str, departing_user_id: Optional[str] = None) -> None:
        result = (
            self.supabase.table("staff_roles")
            .select("user_id")
            .eq("studio_id", studio_id)
            .eq("role", "admin")
            .execute()
        )
        active_admins = [
            row for row in (result.data or [])
            if (
                row.get("user_id") != departing_user_id
                and not self._has_scheduled_account_deletion(row.get("user_id"))
                and self._auth_user_is_active(row.get("user_id"))
            )
        ]
        if len(active_admins) < 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="At least one active admin not scheduled for deletion must remain in the studio.",
            )

    def _has_scheduled_account_deletion(self, user_id: Optional[str]) -> bool:
        if not user_id:
            return False

        result = (
            self.supabase.table("account_deletion_requests")
            .select("id")
            .eq("user_id", user_id)
            .eq("status", "scheduled")
            .limit(1)
            .execute()
        )
        return bool(result.data)

    def _auth_user_is_active(self, user_id: Optional[str]) -> bool:
        user = self._get_auth_user(user_id) if user_id else None
        return _staff_status(user) == "active"

    def _raise_admin_integrity_conflict(self, exc: PostgrestAPIError) -> None:
        if exc.code in {"23514", "P0001"}:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=getattr(exc, "message", None) or "At least one active admin not scheduled for deletion must remain in the studio.",
            ) from exc
        raise exc

    def _audit(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        entity_id: str,
        metadata: dict,
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "staff_role",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
