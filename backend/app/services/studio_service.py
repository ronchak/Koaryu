import re
import uuid
from supabase import Client
from app.schemas.studio import StudioCreate, StudioUpdate, StudioResponse
from fastapi import HTTPException, status


def slugify(name: str) -> str:
    """Convert a studio name to a URL-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    slug = slug.strip("-")
    # Add a short random suffix to ensure uniqueness
    suffix = uuid.uuid4().hex[:6]
    return f"{slug}-{suffix}"


class StudioService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def create_studio(self, data: StudioCreate, user_id: str) -> StudioResponse:
        """Create a new studio and assign the user as admin."""

        # Check if user already has a studio
        existing = (
            self.supabase.table("staff_roles")
            .select("studio_id")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )

        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have a studio. Only one studio per account in v1.",
            )

        slug = slugify(data.name)

        # Create studio
        studio_result = (
            self.supabase.table("studios")
            .insert(
                {
                    "name": data.name,
                    "slug": slug,
                    "owner_id": user_id,
                    "timezone": data.timezone,
                }
            )
            .execute()
        )

        if not studio_result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create studio",
            )

        studio = studio_result.data[0]

        # Create admin staff role
        self.supabase.table("staff_roles").insert(
            {
                "studio_id": studio["id"],
                "user_id": user_id,
                "role": "admin",
            }
        ).execute()

        # Log the action
        self.supabase.table("audit_logs").insert(
            {
                "studio_id": studio["id"],
                "actor_id": user_id,
                "action": "studio.created",
                "entity_type": "studio",
                "entity_id": studio["id"],
                "metadata": {"name": data.name},
            }
        ).execute()

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
