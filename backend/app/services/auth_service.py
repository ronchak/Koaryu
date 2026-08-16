import asyncio
from typing import Optional

from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client
from app.schemas.auth import UserProfile, AuthResponse
from app.services.studio_scope import resolve_optional_staff_role_for_user


OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def _is_optional_staff_profile_schema_error(exc: PostgrestAPIError) -> bool:
    return exc.code in OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES


class AuthService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def get_user_profile(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> AuthResponse:
        return await asyncio.to_thread(
            self._get_user_profile_sync,
            user_id,
            requested_studio_id,
        )

    def _get_user_profile_sync(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> AuthResponse:
        """Get user profile with studio association."""

        # Get user from Supabase Auth
        user_response = self.supabase.auth.admin.get_user_by_id(user_id)
        user = user_response.user

        if not user:
            raise ValueError("User not found")

        full_name = user.user_metadata.get("full_name") if user.user_metadata else None

        # The active studio cookie/header is only a selector. studio_scope
        # returns the server-verified membership that is safe to expose/use.
        membership = resolve_optional_staff_role_for_user(
            self.supabase,
            user_id,
            requested_studio_id,
            user_email=user.email,
        )

        studio_id = None
        role = None
        if membership:
            studio_id = membership["studio_id"]
            role = membership["role"]

        staff_profiles_available = False
        legal_first_name = None
        legal_last_name = None
        try:
            staff_profile_response = (
                self.supabase.table("staff_profiles")
                .select("legal_first_name, legal_last_name")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
        except PostgrestAPIError as exc:
            if not _is_optional_staff_profile_schema_error(exc):
                raise
        else:
            staff_profiles_available = True
            staff_profile_rows = staff_profile_response.data
            if not isinstance(staff_profile_rows, list):
                raise RuntimeError("Invalid staff_profiles response")
            if staff_profile_rows:
                staff_profile = staff_profile_rows[0]
                if not isinstance(staff_profile, dict):
                    raise RuntimeError("Invalid staff_profiles row")
                legal_first_name = staff_profile.get("legal_first_name")
                legal_last_name = staff_profile.get("legal_last_name")

        user_profile = UserProfile(
            id=str(user.id),
            email=user.email or "",
            full_name=full_name,
            legal_first_name=legal_first_name,
            legal_last_name=legal_last_name,
        )

        return AuthResponse(
            user=user_profile,
            staff_profiles_available=staff_profiles_available,
            studio_id=studio_id,
            role=role,
        )
