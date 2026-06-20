import asyncio
from typing import Optional

from supabase import Client
from app.schemas.auth import UserProfile, AuthResponse
from app.services.studio_scope import resolve_optional_staff_role_for_user


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

        user_profile = UserProfile(
            id=str(user.id),
            email=user.email or "",
            full_name=user.user_metadata.get("full_name") if user.user_metadata else None,
        )

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

        return AuthResponse(
            user=user_profile,
            studio_id=studio_id,
            role=role,
        )
