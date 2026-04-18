from pydantic import BaseModel
from typing import Optional


class UserProfile(BaseModel):
    id: str
    email: str
    full_name: Optional[str] = None


class AuthResponse(BaseModel):
    user: UserProfile
    studio_id: Optional[str] = None
    role: Optional[str] = None
