from pydantic import BaseModel, field_validator
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def normalize_studio_name(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None

    normalized = value.strip()
    if not normalized:
        raise ValueError("Studio name is required.")

    return normalized


def normalize_timezone(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None

    normalized = value.strip()
    if not normalized:
        raise ValueError("Timezone is required.")

    try:
        ZoneInfo(normalized)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Choose a valid timezone.") from exc

    return normalized


class StudioCreate(BaseModel):
    name: str
    timezone: str = "America/New_York"

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_studio_name(value) or ""

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        return normalize_timezone(value) or ""


class StudioUpdate(BaseModel):
    name: Optional[str] = None
    timezone: Optional[str] = None
    logo_url: Optional[str] = None
    owner_id: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: Optional[str]) -> Optional[str]:
        return normalize_studio_name(value)

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: Optional[str]) -> Optional[str]:
        return normalize_timezone(value)


class StudioResponse(BaseModel):
    id: str
    name: str
    slug: str
    owner_id: str
    logo_url: Optional[str] = None
    timezone: str
    created_at: str
    updated_at: str
