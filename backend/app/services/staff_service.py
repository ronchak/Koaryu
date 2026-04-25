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
        settings = get_settings()
        try:
            invite_response = self.supabase.auth.admin.invite_user_by_email(
                data.email,
                {"redirect_to": f"{settings.FRONTEND_URL}/auth/callback"},
            )
        except AuthApiError as exc:
            if exc.code in {"email_exists", "user_already_exists", "conflict"}:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="That email already has an account. Existing-account linking is not supported yet.",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=exc.message or "Failed to send staff invite.",
            ) from exc

        user = invite_response.user
        if not user or not getattr(user, "id", None):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Supabase did not return an invited user.",
            )

        existing_member = (
            self.supabase.table("staff_roles")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("user_id", user.id)
            .limit(1)
            .execute()
        )
        if existing_member.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That user is already a staff member in this studio.",
            )

        try:
            result = self._insert_staff_role_with_metadata(
                {
                    "studio_id": studio_id,
                    "user_id": user.id,
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

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create staff role.",
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
            self._ensure_more_than_one_admin(studio_id)

        result = (
            self.supabase.table("staff_roles")
            .update({"role": data.role})
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .execute()
        )

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

    async def remove_staff(
        self,
        staff_role_id: str,
        studio_id: str,
        actor_id: str,
    ) -> None:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        self._ensure_owner_not_demoted_or_removed(studio_id, staff_role["user_id"], None)
        if staff_role["role"] == "admin":
            self._ensure_more_than_one_admin(studio_id)

        staff_member = self._hydrate_staff_member(staff_role)
        result = (
            self.supabase.table("staff_roles")
            .delete()
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .execute()
        )

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
        if user is None:
            user = self._get_auth_user(row["user_id"])

        return StaffMemberResponse(
            id=row["id"],
            studio_id=row["studio_id"],
            user_id=row["user_id"],
            email=(getattr(user, "email", None) or row.get("invited_email") or ""),
            full_name=_user_full_name(user),
            role=row["role"],
            status=_staff_status(user),
            invited_by=row.get("invited_by"),
            created_at=_to_text(row.get("created_at")) or "",
            updated_at=_to_text(row.get("updated_at")) or _to_text(row.get("created_at")) or "",
            last_sign_in_at=_to_text(getattr(user, "last_sign_in_at", None)),
        )

    def _get_auth_user(self, user_id: str) -> Any:
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
        target_user_id: str,
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

    def _ensure_more_than_one_admin(self, studio_id: str) -> None:
        result = (
            self.supabase.table("staff_roles")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("role", "admin")
            .execute()
        )
        if len(result.data or []) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="At least one admin must remain in the studio.",
            )

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
