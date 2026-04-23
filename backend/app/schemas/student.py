from pydantic import BaseModel, EmailStr, Field, model_validator
from typing import Literal, Optional
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
    issues: list["CsvImportIssue"] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    is_valid: bool = True


class CsvImportIssue(BaseModel):
    code: str
    severity: Literal["error", "warning"] = "error"
    field: Optional[str] = None
    value: Optional[str] = None
    message: str
    suggested_action: Optional[str] = None


class CsvImportWarning(BaseModel):
    code: str
    message: str
    severity: Literal["warning"] = "warning"
    row_numbers: list[int] = Field(default_factory=list)
    field: Optional[str] = None
    values: list[str] = Field(default_factory=list)
    suggested_action: Optional[str] = None


class CsvImportSetupIssue(BaseModel):
    code: str
    severity: Literal["error", "warning"] = "warning"
    message: str
    row_numbers: list[int] = Field(default_factory=list)
    values: list[str] = Field(default_factory=list)
    suggested_action: Optional[str] = None


class CsvImportActionOptions(BaseModel):
    can_create_missing_programs: bool = False
    can_create_missing_belts: bool = False
    can_import_without_unresolved_belt: bool = False
    belt_tracker_href: Optional[str] = None


class CsvImportOptions(BaseModel):
    create_missing_programs: bool = False
    create_missing_belts: bool = False
    import_without_unresolved_belt: bool = True
    status_alias_mode: Literal["strict", "normalize"] = "normalize"


class CsvImportRequest(BaseModel):
    mapping: dict[str, str]
    options: CsvImportOptions = Field(default_factory=CsvImportOptions)
    idempotency_key: Optional[str] = None


class CsvImportResult(BaseModel):
    total_rows: int
    valid_rows: int
    error_rows: int
    rows: list[CsvImportRow] = Field(default_factory=list)
    errors: list[CsvImportRow] = Field(default_factory=list)
    warnings: list[CsvImportWarning] = Field(default_factory=list)
    setup_issues: list[CsvImportSetupIssue] = Field(default_factory=list)
    actions_available: CsvImportActionOptions = Field(default_factory=CsvImportActionOptions)
    created_programs: list[str] = Field(default_factory=list)
    created_ladders: list[str] = Field(default_factory=list)
    created_belts: list[str] = Field(default_factory=list)
    imported_without_belt_count: int = 0
    normalized_status_count: int = 0
    imported_count: int = 0
    idempotency_key: Optional[str] = None
    reused_result: bool = False
    execution_status: Literal["completed", "completed_with_warnings", "reused"] = "completed"
    non_critical_errors: list[str] = Field(default_factory=list)


CsvImportRow.model_rebuild()


# ---- Bulk Actions ----

class BulkTagUpdate(BaseModel):
    student_ids: list[str] = Field(min_length=1)
    tags_to_add: list[str] = []
    tags_to_remove: list[str] = []

    @model_validator(mode="after")
    def validate_tag_changes(self):
        if not self.tags_to_add and not self.tags_to_remove:
            raise ValueError("Provide at least one tag to add or remove")
        return self


class BulkStatusUpdate(BaseModel):
    student_ids: list[str] = Field(min_length=1)
    status: str
