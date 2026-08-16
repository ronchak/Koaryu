import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, status
from gotrue.errors import AuthApiError
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.core.config import get_settings
from app.schemas.account import (
    AccountDeletionRequestCreate,
    AccountDeletionRequestResponse,
)
from app.schemas.staff import (
    StaffDeletionRequestCreate,
    StaffInviteCreate,
    StaffLegalNameResponse,
    StaffLegalNameUpdate,
    StaffMemberResponse,
    StaffRoleUpdate,
)
from app.services.account_service import AccountService

BASE_STAFF_ROLE_COLUMNS = "id, studio_id, user_id, role, archived_at, created_at"
EXTENDED_STAFF_ROLE_COLUMNS = (
    "id, studio_id, user_id, role, archived_at, invited_by, invited_email, created_at, updated_at"
)
OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}
SINGLE_STUDIO_MEMBERSHIP_DETAIL = (
    "This account cannot be added to another studio. Contact Koaryu support."
)
STAFF_PROFILE_COLUMNS = "user_id, legal_first_name, legal_last_name"
STAFF_PROFILE_NOT_FOUND_DETAIL = "Staff member not found."
STAFF_PROFILE_UPDATE_FORBIDDEN_DETAIL = "Only studio admins can update staff profiles."
STAFF_PROFILE_ALREADY_EXISTS_DETAIL = "Staff profile already exists."
STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL = {
    "code": "STAFF_DELETE_REQUIRES_ARCHIVE",
    "message": "Archive this staff membership before using the archived-delete flow.",
}
STAFF_DELETE_REQUIRES_LINKED_DETAIL = {
    "code": "STAFF_DELETE_REQUIRES_LINKED",
    "message": "Only a linked archived staff account can be scheduled for deletion.",
}
STAFF_DELETE_CONFIRMATION_MISMATCH_DETAIL = {
    "code": "STAFF_DELETE_CONFIRMATION_MISMATCH",
    "message": "Type the staff member's displayed identity exactly to confirm deletion.",
}
STAFF_OWNER_ARCHIVE_CONFLICT_DETAIL = (
    "Transfer studio ownership before archiving this staff member."
)
STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL = (
    "At least one active admin not scheduled for deletion must remain in the studio."
)


def _to_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _user_full_name(user: Any) -> Optional[str]:
    metadata = getattr(user, "user_metadata", None) or {}
    return _normalize_identity_text(metadata.get("full_name")) or _normalize_identity_text(
        metadata.get("name")
    )


def _normalize_identity_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    normalized = re.sub(r"\s+", " ", str(value)).strip()
    return normalized or None


def _deletion_confirmation_name(row: dict, user: Any, email: str) -> str:
    return (
        _user_full_name(user)
        or _normalize_identity_text(email)
        or f"staff role {row['id']}"
    )


def _staff_status(user: Any, archived_at: Any = None) -> str:
    if archived_at is not None:
        return "archived"
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

    async def list_staff(
        self,
        studio_id: str,
        *,
        include_archived: bool = False,
    ) -> list[StaffMemberResponse]:
        result = self._list_staff_role_rows(studio_id, include_archived=include_archived)
        rows = result.data or []
        profile_map = self._get_staff_profiles_for_user_ids(
            list(dict.fromkeys(
                row.get("user_id")
                for row in rows
                if row.get("user_id")
            ))
        )

        return [
            self._hydrate_staff_member(row, profile=profile_map.get(row.get("user_id")))
            for row in rows
        ]

    async def invite_staff(
        self,
        data: StaffInviteCreate,
        studio_id: str,
        actor_id: str,
    ) -> StaffMemberResponse:
        frontend_origin = get_settings().validated_frontend_origin()
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
        try:
            invite_response = self.supabase.auth.admin.invite_user_by_email(
                data.email,
                {
                    "redirect_to": f"{frontend_origin}/auth/callback",
                    "data": {"full_name": data.full_name},
                },
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

        user_id = user.id
        role_ids = [pending_role["id"]]
        try:
            profile_result = (
                self.supabase.table("staff_profiles")
                .insert({
                    "user_id": user_id,
                    "legal_first_name": data.legal_first_name,
                    "legal_last_name": data.legal_last_name,
                })
                .execute()
            )
            if not profile_result.data:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create staff profile.",
                )
            profile = profile_result.data[0]
        except Exception:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            raise

        try:
            result = self._link_pending_staff_role(pending_role["id"], studio_id, user_id)
        except PostgrestAPIError as exc:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            if exc.code == "23505" or self._is_single_studio_membership_conflict(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        SINGLE_STUDIO_MEMBERSHIP_DETAIL
                        if self._is_single_studio_membership_conflict(exc)
                        else "That user is already a staff member in this studio."
                    ),
                ) from exc
            raise
        except Exception:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            raise

        if not result.data:
            try:
                result = self._recover_missing_pending_staff_role(
                    data,
                    studio_id,
                    actor_id,
                    user_id,
                    role_ids,
                )
            except Exception:
                self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
                raise

        if not result.data:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to link staff invite.",
            )

        try:
            self._audit(
                studio_id,
                actor_id,
                "staff.invited",
                result.data[0]["id"],
                {
                    "email": data.email,
                    "role": data.role,
                    "target_user_id": user_id,
                },
            )
        except Exception:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            raise

        try:
            return self._hydrate_staff_member(result.data[0], user, profile)
        except Exception:
            self._cleanup_failed_invite_resources(role_ids, studio_id, user_id)
            raise

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
        if (
            previous_role == "admin"
            and data.role != "admin"
            and staff_role.get("archived_at") is None
        ):
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

    async def archive_staff(
        self,
        staff_role_id: str,
        studio_id: str,
        actor_id: str,
    ) -> StaffMemberResponse:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        if staff_role.get("archived_at") is not None:
            return self._hydrate_staff_member(staff_role)

        self._ensure_owner_not_archived(studio_id, staff_role.get("user_id"))
        if staff_role.get("role") == "admin":
            self._ensure_more_than_one_admin(studio_id, staff_role.get("user_id"))

        archived_at = datetime.now(timezone.utc).isoformat()
        try:
            result = (
                self.supabase.table("staff_roles")
                .update({"archived_at": archived_at})
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .is_("archived_at", None)
                .execute()
            )
        except PostgrestAPIError as exc:
            self._raise_admin_integrity_conflict(exc)

        if not result.data:
            current = self._get_staff_role_or_404(staff_role_id, studio_id)
            if current.get("archived_at") is not None:
                return self._hydrate_staff_member(current)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Staff member could not be archived. Refresh and try again.",
            )

        row = result.data[0]
        self._audit(
            studio_id,
            actor_id,
            "staff.archived",
            staff_role_id,
            {
                "target_user_id": staff_role.get("user_id"),
                "role": staff_role.get("role"),
            },
        )
        return self._hydrate_staff_member(row)

    async def unarchive_staff(
        self,
        staff_role_id: str,
        studio_id: str,
        actor_id: str,
    ) -> StaffMemberResponse:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        if staff_role.get("archived_at") is None:
            return self._hydrate_staff_member(staff_role)

        try:
            result = (
                self.supabase.table("staff_roles")
                .update({"archived_at": None})
                .eq("id", staff_role_id)
                .eq("studio_id", studio_id)
                .not_.is_("archived_at", None)
                .execute()
            )
        except PostgrestAPIError as exc:
            self._raise_admin_integrity_conflict(exc)

        if not result.data:
            current = self._get_staff_role_or_404(staff_role_id, studio_id)
            if current.get("archived_at") is None:
                return self._hydrate_staff_member(current)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Staff member could not be unarchived. Refresh and try again.",
            )

        row = result.data[0]
        self._audit(
            studio_id,
            actor_id,
            "staff.unarchived",
            staff_role_id,
            {
                "target_user_id": staff_role.get("user_id"),
                "role": staff_role.get("role"),
            },
        )
        return self._hydrate_staff_member(row)

    async def schedule_staff_deletion(
        self,
        staff_role_id: str,
        data: StaffDeletionRequestCreate,
        studio_id: str,
        actor_id: str,
    ) -> AccountDeletionRequestResponse:
        staff_role = self._get_staff_role_or_404(staff_role_id, studio_id)
        target_user_id = staff_role.get("user_id")
        if not target_user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=STAFF_DELETE_REQUIRES_LINKED_DETAIL,
            )
        if staff_role.get("archived_at") is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL,
            )

        target = self._hydrate_staff_member(staff_role)
        if data.confirmation_name != target.deletion_confirmation_name:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=STAFF_DELETE_CONFIRMATION_MISMATCH_DETAIL,
            )

        return await AccountService(self.supabase).schedule_deletion_for_admin(
            AccountDeletionRequestCreate(reason=data.reason),
            target_user_id,
            studio_id,
            actor_id,
        )

    async def update_staff_legal_name(
        self,
        target_user_id: str,
        data: StaffLegalNameUpdate,
        studio_id: str,
        actor_id: str,
        actor_role: str,
    ) -> StaffLegalNameResponse:
        self._ensure_target_staff_membership(target_user_id, studio_id)

        is_admin = actor_role == "admin"
        if not is_admin and target_user_id != actor_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=STAFF_PROFILE_UPDATE_FORBIDDEN_DETAIL,
            )

        existing_profile = self._get_staff_profile(target_user_id)
        if existing_profile:
            if not is_admin:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=STAFF_PROFILE_UPDATE_FORBIDDEN_DETAIL,
                )

            result = (
                self.supabase.table("staff_profiles")
                .update({
                    "legal_first_name": data.legal_first_name,
                    "legal_last_name": data.legal_last_name,
                })
                .eq("user_id", target_user_id)
                .execute()
            )
            if not result.data:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=STAFF_PROFILE_NOT_FOUND_DETAIL,
                )

            operation = "updated"
            row = result.data[0]
        else:
            try:
                result = (
                    self.supabase.table("staff_profiles")
                    .insert({
                        "user_id": target_user_id,
                        "legal_first_name": data.legal_first_name,
                        "legal_last_name": data.legal_last_name,
                    })
                    .execute()
                )
            except PostgrestAPIError as exc:
                if exc.code == "23505":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=STAFF_PROFILE_ALREADY_EXISTS_DETAIL,
                    ) from exc
                raise

            if not result.data:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create staff profile.",
                )

            operation = "created"
            row = result.data[0]

        self._audit(
            studio_id,
            actor_id,
            f"staff.profile_{operation}",
            target_user_id,
            {
                "target_user_id": target_user_id,
                "operation": operation,
            },
            entity_type="staff_profile",
        )

        return StaffLegalNameResponse(
            user_id=row["user_id"],
            legal_first_name=row["legal_first_name"],
            legal_last_name=row["legal_last_name"],
        )

    def _ensure_target_staff_membership(self, target_user_id: str, studio_id: str) -> None:
        result = (
            self.supabase.table("staff_roles")
            .select("user_id")
            .eq("studio_id", studio_id)
            .eq("user_id", target_user_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=STAFF_PROFILE_NOT_FOUND_DETAIL,
            )

    def _get_staff_profile(self, target_user_id: str) -> Optional[dict]:
        result = (
            self.supabase.table("staff_profiles")
            .select(STAFF_PROFILE_COLUMNS)
            .eq("user_id", target_user_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def _get_staff_profiles_for_user_ids(self, user_ids: list[str]) -> dict[str, dict]:
        if not user_ids:
            return {}

        try:
            result = (
                self.supabase.table("staff_profiles")
                .select(STAFF_PROFILE_COLUMNS)
                .in_("user_id", user_ids)
                .execute()
            )
        except PostgrestAPIError as exc:
            if exc.code in OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES:
                return {}
            raise

        rows = result.data
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise RuntimeError("Invalid staff_profiles response")

        profiles = {}
        for row in rows:
            if not isinstance(row, dict):
                raise RuntimeError("Invalid staff_profiles row")
            user_id = row.get("user_id")
            if user_id in user_ids:
                profiles[user_id] = row
        return profiles

    def _list_staff_role_rows(self, studio_id: str, *, include_archived: bool = False):
        try:
            query = (
                self.supabase.table("staff_roles")
                .select(EXTENDED_STAFF_ROLE_COLUMNS)
                .eq("studio_id", studio_id)
            )
            if not include_archived:
                query = query.is_("archived_at", None)
            return query.order("created_at").execute()
        except PostgrestAPIError as exc:
            if exc.code != "42703":
                raise
            query = (
                self.supabase.table("staff_roles")
                .select(BASE_STAFF_ROLE_COLUMNS)
                .eq("studio_id", studio_id)
            )
            if not include_archived:
                query = query.is_("archived_at", None)
            # archived_at is part of the required release schema. If this
            # fallback also fails, propagate the schema error instead of
            # silently returning an archive-blind roster.
            return query.order("created_at").execute()

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
        self._ensure_single_studio_membership_candidate(user_id, studio_id)
        return (
            self.supabase.table("staff_roles")
            .update({"user_id": user_id})
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .execute()
        )

    def _ensure_single_studio_membership_candidate(self, user_id: str, studio_id: str) -> None:
        result = (
            self.supabase.table("staff_roles")
            .select("studio_id")
            .eq("user_id", user_id)
            .execute()
        )
        if any(row.get("studio_id") != studio_id for row in (result.data or [])):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=SINGLE_STUDIO_MEMBERSHIP_DETAIL,
            )

    def _recover_missing_pending_staff_role(
        self,
        data: StaffInviteCreate,
        studio_id: str,
        actor_id: str,
        user_id: str,
        role_ids: Optional[list[str]] = None,
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
        if role_ids is not None:
            role_ids.append(recovered_role_id)
        try:
            result = self._link_pending_staff_role(recovered_role_id, studio_id, user_id)
        except PostgrestAPIError as exc:
            if exc.code == "23505" or self._is_single_studio_membership_conflict(exc):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        SINGLE_STUDIO_MEMBERSHIP_DETAIL
                        if self._is_single_studio_membership_conflict(exc)
                        else "That user is already a staff member in this studio."
                    ),
                ) from exc
            raise
        return result

    @staticmethod
    def _is_single_studio_membership_conflict(exc: PostgrestAPIError) -> bool:
        error_text = " ".join(
            str(value)
            for value in (
                getattr(exc, "message", ""),
                getattr(exc, "details", ""),
                exc,
            )
        ).lower()
        return exc.code == "P0001" and "one studio" in error_text

    def _delete_pending_staff_role(
        self,
        staff_role_id: str,
        studio_id: str,
        *,
        require_unlinked: bool = True,
    ):
        query = (
            self.supabase.table("staff_roles")
            .delete()
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
        )
        if require_unlinked:
            query = query.is_("user_id", None)
        return query.is_("archived_at", None).execute()

    def _delete_invite_created_staff_role(self, staff_role_id: str, studio_id: str) -> None:
        (
            self.supabase.table("staff_roles")
            .delete()
            .eq("id", staff_role_id)
            .eq("studio_id", studio_id)
            .execute()
        )

    def _delete_invited_staff_profile(self, user_id: Optional[str]) -> None:
        if not user_id:
            return
        (
            self.supabase.table("staff_profiles")
            .delete()
            .eq("user_id", user_id)
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
        self._cleanup_failed_invite_resources([staff_role_id], studio_id, user_id)

    def _cleanup_failed_invite_resources(
        self,
        staff_role_ids: list[str],
        studio_id: str,
        user_id: Optional[str],
    ) -> None:
        for staff_role_id in dict.fromkeys(staff_role_ids):
            try:
                self._delete_invite_created_staff_role(staff_role_id, studio_id)
            except Exception:
                pass
        try:
            self._delete_invited_staff_profile(user_id)
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
        if staff_role.get("archived_at") is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL,
            )

        target_user_id = staff_role.get("user_id")
        if target_user_id is not None:
            try:
                user = self._get_auth_user(target_user_id)
            except Exception:
                user = None
            if user is None or _staff_status(user) != "pending":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=STAFF_DELETE_REQUIRES_ARCHIVE_DETAIL,
                )

        try:
            result = self._delete_pending_staff_role(
                staff_role_id,
                studio_id,
                require_unlinked=target_user_id is None,
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
                "email": staff_role.get("invited_email") or "",
            },
        )

    def _hydrate_staff_member(
        self,
        row: dict,
        user: Any = None,
        profile: Optional[dict] = None,
    ) -> StaffMemberResponse:
        user_id = row.get("user_id")
        if user is None:
            user = self._get_auth_user(user_id)

        email = (
            _normalize_identity_text(getattr(user, "email", None))
            or _normalize_identity_text(row.get("invited_email"))
            or ""
        )

        return StaffMemberResponse(
            id=row["id"],
            studio_id=row["studio_id"],
            user_id=user_id,
            email=email,
            full_name=_user_full_name(user),
            deletion_confirmation_name=_deletion_confirmation_name(row, user, email),
            legal_first_name=profile.get("legal_first_name") if profile else None,
            legal_last_name=profile.get("legal_last_name") if profile else None,
            role=row["role"],
            status=_staff_status(user, row.get("archived_at")),
            archived_at=_to_text(row.get("archived_at")),
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

    def _ensure_owner_not_archived(
        self,
        studio_id: str,
        target_user_id: Optional[str],
    ) -> None:
        result = (
            self.supabase.table("studios")
            .select("owner_id")
            .eq("id", studio_id)
            .limit(1)
            .execute()
        )
        owner_id = result.data[0]["owner_id"] if result.data else None
        if owner_id == target_user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=STAFF_OWNER_ARCHIVE_CONFLICT_DETAIL,
            )

    def _ensure_more_than_one_admin(self, studio_id: str, departing_user_id: Optional[str] = None) -> None:
        result = (
            self.supabase.table("staff_roles")
            .select("user_id")
            .eq("studio_id", studio_id)
            .eq("role", "admin")
            .is_("archived_at", None)
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
                detail=STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL,
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
                detail=getattr(exc, "message", None) or STAFF_ACTIVE_ADMIN_SURVIVOR_DETAIL,
            ) from exc
        raise exc

    def _audit(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        entity_id: str,
        metadata: dict,
        entity_type: str = "staff_role",
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
