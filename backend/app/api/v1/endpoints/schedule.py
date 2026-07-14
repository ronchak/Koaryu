from fastapi import APIRouter, Depends, Query
from typing import Optional
from supabase import Client
from app.core.deps import (
    get_current_studio_id,
    get_current_user_id,
    get_current_write_studio_id,
    get_roster_schedule_manager_studio_id,
    get_supabase,
)
from app.schemas.schedule import (
    ClassTemplateCreate, ClassTemplateUpdate, ClassTemplateResponse,
    ClassSessionCreate, ClassSessionResponse,
    ClassSessionDeleteScopeValue,
    AttendanceCheckIn, AttendanceResponse, AttendanceBulkCheckIn,
)
from app.services.schedule_service import (
    SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS,
    SCHEDULE_SESSION_MATERIALIZATION_RANGE_MAX_DAYS,
    ScheduleService,
)

router = APIRouter(prefix="/schedule", tags=["schedule"])


# ---- Templates ----

@router.get("/templates", response_model=list[ClassTemplateResponse])
async def list_templates(
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).list_templates(studio_id)


@router.post("/templates", response_model=ClassTemplateResponse, status_code=201)
async def create_template(
    data: ClassTemplateCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).create_template(data, studio_id, user_id)


@router.patch("/templates/{template_id}", response_model=ClassTemplateResponse)
async def update_template(
    template_id: str,
    data: ClassTemplateUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).update_template(template_id, data, studio_id, user_id)


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(
    template_id: str,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    await ScheduleService(supabase).delete_template(template_id, studio_id, user_id)


# ---- Sessions ----

@router.get("/sessions", response_model=list[ClassSessionResponse])
async def list_sessions(
    start_date: str = Query(
        ...,
        description=f"YYYY-MM-DD inclusive start date. Maximum range is {SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS} days.",
    ),
    end_date: str = Query(
        ...,
        description=f"YYYY-MM-DD inclusive end date. Maximum range is {SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS} days.",
    ),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).list_sessions(studio_id, start_date, end_date)


@router.post("/sessions/materialize", response_model=list[ClassSessionResponse])
async def materialize_session_range(
    start_date: str = Query(
        ...,
        description=(
            "YYYY-MM-DD inclusive start date. Maximum range is "
            f"{SCHEDULE_SESSION_MATERIALIZATION_RANGE_MAX_DAYS} days."
        ),
    ),
    end_date: str = Query(
        ...,
        description=(
            "YYYY-MM-DD inclusive end date. Maximum range is "
            f"{SCHEDULE_SESSION_MATERIALIZATION_RANGE_MAX_DAYS} days."
        ),
    ),
    studio_id: str = Depends(get_current_write_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).materialize_session_range(
        studio_id,
        start_date,
        end_date,
    )


@router.post("/sessions", response_model=ClassSessionResponse, status_code=201)
async def create_session(
    data: ClassSessionCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).create_session(data, studio_id, user_id)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    scope: ClassSessionDeleteScopeValue = Query("session"),
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    await ScheduleService(supabase).delete_session(session_id, studio_id, user_id, scope)


@router.post("/sessions/generate-week", response_model=list[ClassSessionResponse])
async def generate_week(
    week_start: str = Query(..., description="Monday date YYYY-MM-DD"),
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_roster_schedule_manager_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).generate_sessions_for_week(studio_id, week_start, user_id)


# ---- Attendance ----

@router.get("/sessions/{session_id}/attendance", response_model=list[AttendanceResponse])
async def get_attendance(
    session_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).get_session_attendance(session_id, studio_id)


@router.get("/attendance", response_model=list[AttendanceResponse])
async def list_attendance(
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    session_ids: Optional[list[str]] = Query(default=None),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).list_attendance(
        studio_id,
        start_date=start_date,
        end_date=end_date,
        session_ids=session_ids,
    )


@router.post("/attendance", response_model=AttendanceResponse, status_code=201)
async def check_in(
    data: AttendanceCheckIn,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_write_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).check_in(data, studio_id, user_id)


@router.delete("/attendance", status_code=204)
async def clear_attendance(
    session_id: str = Query(...),
    student_id: str = Query(...),
    studio_id: str = Depends(get_current_write_studio_id),
    supabase: Client = Depends(get_supabase),
):
    await ScheduleService(supabase).clear_attendance(session_id, student_id, studio_id)


@router.post("/attendance/bulk", response_model=list[AttendanceResponse])
async def bulk_check_in(
    data: AttendanceBulkCheckIn,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_current_write_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ScheduleService(supabase).bulk_check_in(data, studio_id, user_id)
