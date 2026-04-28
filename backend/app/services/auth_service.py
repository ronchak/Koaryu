import asyncio
from typing import Optional

from fastapi import HTTPException, status
from supabase import Client
from app.schemas.auth import UserProfile, AuthResponse
from app.services.studio_scope import list_staff_roles_for_user


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

        # Get staff role (studio association)
        studio_id = None
        role = None
        memberships = list_staff_roles_for_user(self.supabase, user_id)
        membership = None

        if requested_studio_id:
            membership = next(
                (item for item in memberships if item["studio_id"] == requested_studio_id),
                None,
            )
            if membership is None:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You do not have access to the requested studio.",
                )

        if membership is None and memberships:
            membership = memberships[0]

        if membership:
            studio_id = membership["studio_id"]
            role = membership["role"]

        return AuthResponse(
            user=user_profile,
            studio_id=studio_id,
            role=role,
        )
