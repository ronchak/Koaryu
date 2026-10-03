from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal, Optional, get_args
from datetime import date
from uuid import UUID

from app.core.error_handlers import ErrorMeta

StudentStatus = Literal["active", "trialing", "inactive", "paused", "canceled"]
STUDENT_STATUSES = set(get_args(StudentStatus))
StudentListSortKey = Literal["name", "status", "membership_start_date", "created_at"]
StudentListSortDir = Literal["asc", "desc"]
StudentProgramMembershipStatus = Literal["active", "paused", "ended"]


# ---- Guardian ----


class GuardianCreate(BaseModel):
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    relation: Optional[str] = None
    is_primary_contact: bool = False


class GuardianWrite(BaseModel):
    """Add a guardian or patch an already-linked shared contact. No link removal."""

    model_config = ConfigDict(extra="forbid")
    id: Optional[UUID] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    relation: Optional[str] = None
    is_primary_contact: Optional[bool] = None

    @model_validator(mode="after")
    def validate_guardian_write(self):
        if "id" in self.model_fields_set and self.id is None:
            raise ValueError("Guardian id cannot be null")
        for name in ("first_name", "last_name"):
            if self.id is None or name in self.model_fields_set:
                value = getattr(self, name)
                if value is None or (not value.strip() and name == "first_name"):
                    raise ValueError("Guardian first name is required; last name must be a string")
                setattr(self, name, value.strip())
        if "is_primary_contact" in self.model_fields_set and self.is_primary_contact is None:
            raise ValueError("Guardian primary contact flag cannot be null")
        if self.id is not None and self.model_fields_set == {"id"}:
            raise ValueError("Provide guardian fields to update")
        return self


class GuardianResponse(BaseModel):
    id: str
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    relation: Optional[str] = None
    is_primary_contact: bool


class StudentProgramMembershipResponse(BaseModel):
    id: str
    studio_id: str
    student_id: str
    program_id: str
    program_name: Optional[str] = None
    program_color_hex: Optional[str] = None
    status: StudentProgramMembershipStatus
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    current_belt_rank_id: Optional[str] = None
    current_belt_rank_name: Optional[str] = None
    current_belt_rank_color: Optional[str] = None
    created_at: str
    updated_at: str


class StudentProgramMembershipCreate(BaseModel):
    program_id: str
    status: StudentProgramMembershipStatus = "active"
    started_at: Optional[date] = None
    ended_at: Optional[date] = None
    current_belt_rank_id: Optional[str] = None


class StudentProgramMembershipUpdate(BaseModel):
    status: Optional[StudentProgramMembershipStatus] = None
    started_at: Optional[date] = None
    ended_at: Optional[date] = None
    current_belt_rank_id: Optional[str] = None


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
    status: StudentStatus = "active"
    membership_start_date: Optional[date] = None
    program_id: Optional[str] = None
    program_ids: list[str] = Field(default_factory=list)
    current_belt_rank_id: Optional[str] = None
    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    # Guardians supplied at creation time (for minors)
    guardians: list[GuardianCreate] = Field(default_factory=list)


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
    status: Optional[StudentStatus] = None
    membership_start_date: Optional[date] = None
    program_id: Optional[str] = None
    program_ids: Optional[list[str]] = None
    current_belt_rank_id: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[list[str]] = None

    guardians: Optional[list[GuardianWrite]] = Field(
        default=None,
        description="Add or patch linked shared guardian contacts. Omission or an empty array preserves all contacts and links; null is invalid.",
    )

    @model_validator(mode="after")
    def validate_guardians(self):
        if "guardians" in self.model_fields_set and self.guardians is None:
            raise ValueError("Guardians must be an array; omit it to preserve existing guardians")
        ids = [guardian.id for guardian in self.guardians or [] if guardian.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate guardian id in student write")
        return self


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
    status: StudentStatus
    membership_start_date: Optional[str] = None
    program_id: Optional[str] = None
    current_belt_rank_id: Optional[str] = None
    photo_path: Optional[str] = None
    photo_url: Optional[str] = None
    photo_updated_at: Optional[str] = None
    notes: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    guardians: list[GuardianResponse] = Field(default_factory=list)
    program_memberships: list[StudentProgramMembershipResponse] = Field(default_factory=list)
    created_at: str
    updated_at: str


class StudentListResponse(BaseModel):
    items: list[StudentResponse]
    total: int
    page: int
    page_size: int


class StudentRosterRowResponse(StudentResponse):
    """Complete row projection for the interactive roster and quick view.

    The roster RPC supplies these derived values in the same response.  They
    are nullable when the source fact is not applicable or unavailable; the
    adapter must not manufacture a zero for missing attendance data.
    """

    guardian_email: Optional[str] = None
    last_attendance_date: Optional[str] = None
    inactivity_days: Optional[int] = None
    reference_date: Optional[str] = None


class StudentRosterPageResponse(BaseModel):
    items: list[StudentRosterRowResponse]
    total: int
    page_size: int
    page_ordinal: int
    has_next: bool
    next_cursor: Optional[str] = None
    has_previous: bool
    previous_cursor: Optional[str] = None


class StudentRosterCursorErrorDetail(BaseModel):
    code: str
    message: str
    recover_to: Literal["first", "nearest_prior"]


class StudentRosterCursorErrorResponse(BaseModel):
    detail: StudentRosterCursorErrorDetail
    error: ErrorMeta


class StudentListQueryContract(BaseModel):
    search: Optional[str] = None
    status: Optional[StudentStatus] = None
    program_id: Optional[str] = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=200)
    sort_by: StudentListSortKey = "name"
    sort_dir: StudentListSortDir = "asc"
    cursor: Optional[str] = None
    full_roster: bool = False
    inactivity_days: Optional[int] = None
    new_students: Optional[Literal["14", "30", "90", "ytd"]] = None
    today: Optional[date] = None


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


class CsvMappingSuggestion(BaseModel):
    field: str
    confidence: Optional[float] = None
    reason: Optional[str] = None
    sample_values: list[str] = Field(default_factory=list)


class CsvParseResponse(BaseModel):
    headers: list[str]
    auto_mapping: dict[str, str]
    preview_rows: list[dict[str, str]] = Field(default_factory=list)
    total_rows: int
    mapping_suggestions: dict[str, CsvMappingSuggestion] = Field(default_factory=dict)
    warnings: list[CsvImportIssue] = Field(default_factory=list)
    required_fields: list[str] = Field(default_factory=list)


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
    status: StudentStatus


class BulkStudentArchiveRequest(BaseModel):
    student_ids: list[UUID] = Field(min_length=1, max_length=200)


class BulkStudentUpdateResponse(BaseModel):
    updated: int
