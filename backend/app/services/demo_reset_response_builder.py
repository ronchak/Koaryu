from collections.abc import Callable

from supabase import Client

from app.schemas.demo import DemoResetCounts, DemoResetResponse
from app.schemas.schedule import AttendanceResponse
from app.services.belt_service import BeltService
from app.services.demo_seed_common import DEMO_STUDIO_NAME
from app.services.lead_service import LeadService
from app.services.program_service import ProgramService
from app.services.schedule_service import ScheduleService
from app.services.student_service import StudentService


class DemoResetResponseBuilder:
    def __init__(self, supabase: Client, date_for: Callable[[int], str]):
        self.supabase = supabase
        self.date_for = date_for

    async def build(self, studio_id: str) -> DemoResetResponse:
        students_page = await StudentService(self.supabase).list_students(
            studio_id=studio_id,
            search=None,
            status_filter=None,
            program_id=None,
            page=1,
            page_size=200,
        )
        programs = await ProgramService(self.supabase).list_programs(studio_id, include_archived=True)
        leads = await LeadService(self.supabase).list_leads(studio_id)
        belt_ladders = await BeltService(self.supabase).list_ladders(studio_id)
        primary_belt_ladder = belt_ladders[0] if belt_ladders else None
        eligibility = (
            await BeltService(self.supabase).get_eligibility(studio_id, primary_belt_ladder.id)
            if primary_belt_ladder
            else []
        )
        templates = await ScheduleService(self.supabase).list_templates(studio_id)
        sessions = await ScheduleService(self.supabase).list_sessions(
            studio_id,
            self.date_for(-30),
            self.date_for(60),
        )
        attendance_groups = [
            await ScheduleService(self.supabase).get_session_attendance(session.id, studio_id)
            for session in sessions
        ]
        attendance = [
            AttendanceResponse(**record.model_dump())
            for group in attendance_groups
            for record in group
        ]

        return DemoResetResponse(
            studio_name=DEMO_STUDIO_NAME,
            programs=programs,
            students=students_page.items,
            leads=leads,
            lead_activities=[],
            belt_ladders=belt_ladders,
            primary_belt_ladder=primary_belt_ladder,
            eligibility=eligibility,
            templates=templates,
            sessions=sessions,
            attendance=attendance,
            counts=DemoResetCounts(
                students=len(students_page.items),
                leads=len(leads),
                belt_ranks=sum(len(ladder.ranks) for ladder in belt_ladders),
                class_sessions=len(sessions),
                attendance_records=len(attendance),
            ),
        )
