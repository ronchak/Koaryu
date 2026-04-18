from supabase import Client
from app.schemas.auth import UserProfile, AuthResponse


class AuthService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def get_user_profile(self, user_id: str) -> AuthResponse:
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
        staff_result = (
            self.supabase.table("staff_roles")
            .select("studio_id, role")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )

        studio_id = None
        role = None
        if staff_result.data:
            studio_id = staff_result.data[0]["studio_id"]
            role = staff_result.data[0]["role"]

        return AuthResponse(
            user=user_profile,
            studio_id=studio_id,
            role=role,
        )
