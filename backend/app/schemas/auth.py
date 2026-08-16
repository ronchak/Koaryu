from pydantic import BaseModel
from typing import Optional

from app.schemas.staff import StaffRoleName


class UserProfile(BaseModel):
    id: str
    email: str
    full_name: Optional[str] = None
    legal_first_name: Optional[str] = None
    legal_last_name: Optional[str] = None


class AuthResponse(BaseModel):
    user: UserProfile
    staff_profiles_available: bool
    studio_id: Optional[str] = None
    role: Optional[StaffRoleName] = None
