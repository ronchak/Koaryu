import re
from typing import Literal, Optional

from pydantic import BaseModel, field_validator


StaffRoleName = Literal["admin", "instructor", "front_desk"]
StaffStatus = Literal["pending", "active"]

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class StaffMemberResponse(BaseModel):
    id: str
    studio_id: str
    user_id: str
    email: str
    full_name: Optional[str] = None
    role: StaffRoleName
    status: StaffStatus
    invited_by: Optional[str] = None
    created_at: str
    updated_at: str
    last_sign_in_at: Optional[str] = None


class StaffInviteCreate(BaseModel):
    email: str
    role: StaffRoleName

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("Email is required")
        if not EMAIL_PATTERN.match(normalized):
            raise ValueError("Enter a valid email")
        return normalized


class StaffRoleUpdate(BaseModel):
    role: StaffRoleName
