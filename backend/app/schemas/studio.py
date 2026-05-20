from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class StudioCreate(BaseModel):
    name: str
    timezone: str = "America/New_York"


class StudioUpdate(BaseModel):
    name: Optional[str] = None
    timezone: Optional[str] = None
    logo_url: Optional[str] = None
    owner_id: Optional[str] = None


class StudioResponse(BaseModel):
    id: str
    name: str
    slug: str
    owner_id: str
    logo_url: Optional[str] = None
    timezone: str
    created_at: str
    updated_at: str
