from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.studio import StudioCreate, StudioUpdate, StudioResponse


class StudioService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def create_studio(
        self,
        data: StudioCreate,
        user_id: str,
        idempotency_key: Optional[str] = None,
    ) -> StudioResponse:
        """Create a new studio and assign the user as admin."""
        try:
            result = self.supabase.rpc(
                "create_studio_onboarding",
                {
                    "p_user_id": user_id,
                    "p_name": data.name,
                    "p_timezone": data.timezone,
                    "p_idempotency_key": idempotency_key,
                },
            ).execute()
        except Exception as exc:
            self._raise_create_studio_error(exc)

        studio = self._first_rpc_row(result.data)
        if not studio:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create studio",
            )

        return StudioResponse(**studio)

    async def get_studio(self, studio_id: str) -> StudioResponse:
        """Get studio by ID."""
        result = (
            self.supabase.table("studios")
            .select("*")
            .eq("id", studio_id)
            .single()
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Studio not found",
            )

        return StudioResponse(**result.data)

    async def update_studio(
        self, studio_id: str, data: StudioUpdate, user_id: str
    ) -> StudioResponse:
        """Update studio settings."""
        update_data = data.model_dump(exclude_none=True)

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update",
            )

        if "owner_id" in update_data:
            self._validate_owner_transfer(studio_id, user_id, update_data["owner_id"])

        result = (
            self.supabase.table("studios")
            .update(update_data)
            .eq("id", studio_id)
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Studio not found",
            )

        # Audit log
        self.supabase.table("audit_logs").insert(
            {
                "studio_id": studio_id,
                "actor_id": user_id,
                "action": "studio.updated",
                "entity_type": "studio",
                "entity_id": studio_id,
                "metadata": update_data,
            }
        ).execute()

        return StudioResponse(**result.data[0])

    def _validate_owner_transfer(self, studio_id: str, actor_id: str, next_owner_id: str) -> None:
        studio = (
            self.supabase.table("studios")
            .select("owner_id")
            .eq("id", studio_id)
            .limit(1)
            .execute()
        )
        if not studio.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Studio not found")

        if studio.data[0]["owner_id"] != actor_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the current studio owner can transfer ownership.",
            )

        staff = (
            self.supabase.table("staff_roles")
            .select("id, role")
            .eq("studio_id", studio_id)
            .eq("user_id", next_owner_id)
            .eq("role", "admin")
            .limit(1)
            .execute()
        )
        if not staff.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ownership can only be transferred to another studio admin.",
            )

        user = self._get_auth_user(next_owner_id)
        if not (
            getattr(user, "last_sign_in_at", None)
            or getattr(user, "confirmed_at", None)
            or getattr(user, "email_confirmed_at", None)
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Ownership can only be transferred to an active admin.",
            )

    def _get_auth_user(self, user_id: str):
        try:
            return self.supabase.auth.admin.get_user_by_id(user_id).user
        except Exception:
            return None

    def _first_rpc_row(self, data: Any) -> Optional[dict[str, Any]]:
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict):
            return data
        return None

    def _raise_create_studio_error(self, exc: Exception) -> None:
        detail = getattr(exc, "message", None) or str(exc) or exc.__class__.__name__
        normalized_detail = detail.lower()

        if "idempotency key was already used" in normalized_detail:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This studio creation request was already used with different details.",
            ) from exc

        if (
            "you already have a studio" in normalized_detail
            or "duplicate key value" in normalized_detail
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have a studio. Only one studio per account in v1.",
            ) from exc

        if (
            "studio name is required" in normalized_detail
            or "timezone is required" in normalized_detail
            or "choose a valid timezone" in normalized_detail
            or "idempotency key is too long" in normalized_detail
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail,
            ) from exc

        if "violates foreign key constraint" in normalized_detail:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authenticated user was not found.",
            ) from exc

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create studio",
        ) from exc
