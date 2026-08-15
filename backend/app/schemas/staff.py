import re
from typing import Literal, Optional

from pydantic import BaseModel, field_validator


StaffRoleName = Literal["admin", "instructor", "front_desk"]
StaffStatus = Literal["pending", "active"]

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class StaffMemberResponse(BaseModel):
    id: str
    studio_id: str
    user_id: Optional[str] = None
    email: str
    full_name: Optional[str] = None
    legal_first_name: Optional[str] = None
    legal_last_name: Optional[str] = None
    role: StaffRoleName
    status: StaffStatus
    invited_by: Optional[str] = None
    created_at: str
    updated_at: str
    last_sign_in_at: Optional[str] = None


class StaffInviteCreate(BaseModel):
    email: str
    role: StaffRoleName
    full_name: str
    legal_first_name: str
    legal_last_name: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("Email is required")
        if not EMAIL_PATTERN.match(normalized):
            raise ValueError("Enter a valid email")
        return normalized

    @field_validator("full_name", "legal_first_name", "legal_last_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _normalize_legal_name(value)


class StaffRoleUpdate(BaseModel):
    role: StaffRoleName


def _normalize_legal_name(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if not normalized:
        raise ValueError("Name is required")
    return normalized


class StaffLegalNameUpdate(BaseModel):
    legal_first_name: str
    legal_last_name: str

    @field_validator("legal_first_name", "legal_last_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return _normalize_legal_name(value)


class StaffLegalNameResponse(BaseModel):
    user_id: str
    legal_first_name: str
    legal_last_name: str
