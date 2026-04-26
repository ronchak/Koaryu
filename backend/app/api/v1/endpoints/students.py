from fastapi import APIRouter, Depends, Query, UploadFile, File, Form, HTTPException, Header
from typing import Optional
from supabase import Client
from app.core.deps import get_current_user_id, get_current_studio_id, get_requested_studio_id, get_supabase
from app.schemas.billing import StudentBillingEnrollmentCreate, StudentBillingEnrollmentResponse
from app.schemas.student import (
    StudentCreate, StudentUpdate, StudentResponse, StudentListResponse,
    CsvImportRequest, CsvImportResult, BulkTagUpdate, BulkStatusUpdate,
    StudentProgramMembershipCreate, StudentProgramMembershipResponse,
    StudentProgramMembershipUpdate,
)
from app.services.billing_service import BillingService
from app.services.studio_scope import resolve_billing_manager_staff_role_for_user
from app.services.student_service import StudentService
import json

router = APIRouter(prefix="/students", tags=["students"])


def parse_import_request(
    *,
    payload: Optional[str],
    mapping: Optional[str],
    options: Optional[str],
) -> CsvImportRequest:
    if payload:
        return CsvImportRequest.model_validate(json.loads(payload))

    if mapping:
        request_payload = {
            "mapping": json.loads(mapping),
        }
        if options:
            request_payload["options"] = json.loads(options)
        return CsvImportRequest.model_validate(request_payload)

    raise HTTPException(status_code=400, detail="Missing import payload")


@router.get("", response_model=StudentListResponse)
async def list_students(
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.list_students(studio_id, search, status, program_id, page, page_size)


@router.post("", response_model=StudentResponse, status_code=201)
async def create_student(
    data: StudentCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.create_student(data, studio_id, user_id)


@router.get("/{student_id}", response_model=StudentResponse)
async def get_student(
    student_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.get_student(student_id, studio_id)


@router.patch("/{student_id}", response_model=StudentResponse)
async def update_student(
    student_id: str,
    data: StudentUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.update_student(student_id, data, studio_id, user_id)


@router.delete("/{student_id}", status_code=204)
async def delete_student(
    student_id: str,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    await service.soft_delete_student(student_id, studio_id, user_id)


@router.get("/{student_id}/programs", response_model=list[StudentProgramMembershipResponse])
async def list_student_programs(
    student_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.list_program_memberships(student_id, studio_id)


@router.post("/{student_id}/programs", response_model=StudentProgramMembershipResponse, status_code=201)
async def add_student_program(
    student_id: str,
    data: StudentProgramMembershipCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.add_program_membership(student_id, data, studio_id, user_id)


@router.patch("/{student_id}/programs/{membership_id}", response_model=StudentProgramMembershipResponse)
async def update_student_program(
    student_id: str,
    membership_id: str,
    data: StudentProgramMembershipUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    return await service.update_program_membership(student_id, membership_id, data, studio_id, user_id)


@router.delete("/{student_id}/programs/{membership_id}", status_code=204)
async def remove_student_program(
    student_id: str,
    membership_id: str,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    await service.remove_program_membership(student_id, membership_id, studio_id, user_id)


@router.get("/{student_id}/billing", response_model=list[StudentBillingEnrollmentResponse])
async def list_student_billing(
    student_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = resolve_billing_manager_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]
    return await BillingService(supabase).list_student_billing(student_id, studio_id)


@router.post("/{student_id}/billing/enrollments", response_model=StudentBillingEnrollmentResponse, status_code=201)
async def add_student_billing_enrollment(
    student_id: str,
    data: StudentBillingEnrollmentCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = resolve_billing_manager_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]
    payload = data.model_copy(update={"student_id": student_id})
    return await BillingService(supabase).add_student_billing_enrollment(payload, studio_id, user_id)


@router.post("/bulk/tags", status_code=200)
async def bulk_update_tags(
    data: BulkTagUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    count = await service.bulk_update_tags(data, studio_id, user_id)
    return {"updated": count}


@router.post("/bulk/status", status_code=200)
async def bulk_update_status(
    data: BulkStatusUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    service = StudentService(supabase)
    count = await service.bulk_update_status(data, studio_id, user_id)
    return {"updated": count}


@router.post("/import/parse", response_model=dict)
async def parse_csv_headers(
    file: UploadFile = File(...),
    supabase: Client = Depends(get_supabase),
    studio_id: str = Depends(get_current_studio_id),
):
    """
    Upload a CSV file. Returns headers and auto-suggested column mapping.
    The client uses this to display the mapping UI.
    """
    content = await file.read()
    service = StudentService(supabase)
    headers, rows = service.parse_csv(content)
    auto_mapping = service.auto_map_headers(headers)
    return {
        "headers": headers,
        "auto_mapping": auto_mapping,
        "preview_rows": rows[:3],  # First 3 rows for preview
        "total_rows": len(rows),
    }


@router.post("/import/validate", response_model=CsvImportResult)
async def validate_csv_import(
    file: UploadFile = File(...),
    payload: Optional[str] = Form(None, description="JSON string containing mapping and import options"),
    mapping: Optional[str] = Query(None, description="Legacy JSON string of {csv_col: koaryu_field}"),
    options: Optional[str] = Query(None, description="Legacy JSON string of import options"),
    supabase: Client = Depends(get_supabase),
    studio_id: str = Depends(get_current_studio_id),
):
    """Validate a CSV file against a confirmed column mapping. Returns errors per row."""
    content = await file.read()
    service = StudentService(supabase)
    _, rows = service.parse_csv(content)
    try:
        request = parse_import_request(payload=payload, mapping=mapping, options=options)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid import payload")
    return service.validate_import_rows(rows, request.mapping, request.options, studio_id)


@router.post("/import/execute", response_model=CsvImportResult)
async def execute_csv_import(
    file: UploadFile = File(...),
    payload: Optional[str] = Form(None, description="JSON string containing mapping and import options"),
    mapping: Optional[str] = Query(None, description="Legacy JSON string of {csv_col: koaryu_field}"),
    options: Optional[str] = Query(None, description="Legacy JSON string of import options"),
    request_idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    """Execute the import for all valid rows. Skips invalid rows and returns summary."""
    content = await file.read()
    service = StudentService(supabase)
    _, rows = service.parse_csv(content)
    try:
        request = parse_import_request(payload=payload, mapping=mapping, options=options)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid import payload")
    return await service.execute_import(
        rows,
        request.mapping,
        request.options,
        studio_id,
        user_id,
        request.idempotency_key or request_idempotency_key,
    )
