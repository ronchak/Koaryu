from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import date


# ---- Guardian ----

class GuardianCreate(BaseModel):
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    relation: Optional[str] = None
    is_primary_contact: bool = False


class GuardianResponse(BaseModel):
    id: str
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    relation: Optional[str] = None
    is_primary_contact: bool


# ---- Student ----

class StudentCreate(BaseModel):
    legal_first_name: str
    legal_last_name: str
    preferred_name: Optional[str] = None
    date_of_birth: Optional[date] = None
    hold_start_date: Optional[date] = None
    hold_end_date: Optional[date] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    emergency_contact_relation: Optional[str] = None
    status: str = "active"
    membership_start_date: Optional[date] = None
    program_id: Optional[str] = None
    notes: Optional[str] = None
    tags: list[str] = []
    # Guardians supplied at creation time (for minors)
    guardians: list[GuardianCreate] = []


class StudentUpdate(BaseModel):
    legal_first_name: Optional[str] = None
    legal_last_name: Optional[str] = None
    preferred_name: Optional[str] = None
    date_of_birth: Optional[date] = None
    hold_start_date: Optional[date] = None
    hold_end_date: Optional[date] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    emergency_contact_relation: Optional[str] = None
    status: Optional[str] = None
    membership_start_date: Optional[date] = None
    program_id: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[list[str]] = None


class StudentResponse(BaseModel):
    id: str
    studio_id: str
    legal_first_name: str
    legal_last_name: str
    preferred_name: Optional[str] = None
    date_of_birth: Optional[str] = None
    is_minor: Optional[bool] = None
    hold_start_date: Optional[str] = None
    hold_end_date: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    address_city: Optional[str] = None
    address_state: Optional[str] = None
    address_zip: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    emergency_contact_relation: Optional[str] = None
    status: str
    membership_start_date: Optional[str] = None
    program_id: Optional[str] = None
    current_belt_rank_id: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    notes: Optional[str] = None
    tags: list[str] = []
    guardians: list[GuardianResponse] = []
    created_at: str
    updated_at: str


class StudentListResponse(BaseModel):
    items: list[StudentResponse]
    total: int
    page: int
    page_size: int


# ---- CSV Import ----

class CsvImportRow(BaseModel):
    """A single parsed row from a CSV import attempt."""
    row_number: int
    data: dict
    errors: list[str] = []
    is_valid: bool = True


class CsvImportResult(BaseModel):
    total_rows: int
    valid_rows: int
    error_rows: int
    errors: list[CsvImportRow] = []
    imported_count: int = 0


# ---- Bulk Actions ----

class BulkTagUpdate(BaseModel):
    student_ids: list[str]
    tags_to_add: list[str] = []
    tags_to_remove: list[str] = []


class BulkStatusUpdate(BaseModel):
    student_ids: list[str]
    status: str
