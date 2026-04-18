from fastapi import APIRouter, Depends, Query, UploadFile, File, HTTPException
from typing import Optional
from supabase import Client
from app.core.deps import get_current_user_id, get_current_studio_id, get_supabase
from app.schemas.student import (
    StudentCreate, StudentUpdate, StudentResponse, StudentListResponse,
    CsvImportResult, BulkTagUpdate, BulkStatusUpdate,
)
from app.services.student_service import StudentService
import json

router = APIRouter(prefix="/students", tags=["students"])


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
    mapping: str = Query(..., description="JSON string of {csv_col: koaryu_field}"),
    supabase: Client = Depends(get_supabase),
    studio_id: str = Depends(get_current_studio_id),
):
    """Validate a CSV file against a confirmed column mapping. Returns errors per row."""
    content = await file.read()
    service = StudentService(supabase)
    _, rows = service.parse_csv(content)
    try:
        col_mapping: dict = json.loads(mapping)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid mapping JSON")
    return service.validate_import_rows(rows, col_mapping)


@router.post("/import/execute", response_model=CsvImportResult)
async def execute_csv_import(
    file: UploadFile = File(...),
    mapping: str = Query(..., description="JSON string of {csv_col: koaryu_field}"),
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    """Execute the import for all valid rows. Skips invalid rows and returns summary."""
    content = await file.read()
    service = StudentService(supabase)
    _, rows = service.parse_csv(content)
    try:
        col_mapping: dict = json.loads(mapping)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid mapping JSON")
    return await service.execute_import(rows, col_mapping, studio_id, user_id)
