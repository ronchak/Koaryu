import uuid
from datetime import date
from typing import Optional
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client
from fastapi import HTTPException
from app.schemas.lead import (
    LeadCreate, LeadUpdate, LeadResponse,
    LeadActivityCreate, LeadActivityResponse,
    LeadConvert,
)
from app.services.studio_scope import ensure_optional_studio_record, ensure_staff_user_in_studio
from app.services.program_service import ProgramService


VALID_STAGES = {"inquiry", "trial_scheduled", "trial_completed", "offer_sent", "enrolled", "closed_lost"}
VALID_SOURCES = {"walk_in", "referral", "social", "search", "website", "other"}
CONVERSION_NAMESPACE = uuid.UUID("27c8322f-a4e4-46d7-bfae-018f6b638858")
OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


class LeadService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def list_leads(
        self, studio_id: str, stage: Optional[str] = None, source: Optional[str] = None
    ) -> list[LeadResponse]:
        query = (
            self.supabase.table("leads")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
        )
        if stage:
            query = query.eq("stage", stage)
        if source:
            query = query.eq("source", source)
        result = query.execute()
        return [LeadResponse(**r) for r in (result.data or [])]

    async def create_lead(
        self, data: LeadCreate, studio_id: str, actor_id: str
    ) -> LeadResponse:
        row = data.model_dump()
        ensure_staff_user_in_studio(
            self.supabase,
            row.get("assigned_staff_id"),
            studio_id,
            "Assigned staff member not found in this studio",
        )
        ProgramService(self.supabase).ensure_program_active(studio_id, row.get("program_id"))
        row["studio_id"] = studio_id
        try:
            result = self.supabase.table("leads").insert(row).execute()
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES or "program_id" not in row:
                raise
            row.pop("program_id", None)
            result = self.supabase.table("leads").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create lead")

        # Log activity
        self.supabase.table("lead_activities").insert({
            "studio_id": studio_id,
            "lead_id": result.data[0]["id"],
            "activity_type": "note",
            "description": "Lead created",
            "created_by": actor_id,
        }).execute()

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "lead.created",
            "entity_type": "lead",
            "entity_id": result.data[0]["id"],
            "metadata": {"name": f"{data.first_name} {data.last_name}"},
        }).execute()

        return LeadResponse(**result.data[0])

    async def get_lead(self, lead_id: str, studio_id: str) -> LeadResponse:
        result = (
            self.supabase.table("leads")
            .select("*")
            .eq("id", lead_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Lead not found")
        return LeadResponse(**result.data)

    async def update_lead(
        self, lead_id: str, data: LeadUpdate, studio_id: str, actor_id: str
    ) -> LeadResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        ensure_staff_user_in_studio(
            self.supabase,
            update_dict.get("assigned_staff_id"),
            studio_id,
            "Assigned staff member not found in this studio",
        )
        ProgramService(self.supabase).ensure_program_active(studio_id, update_dict.get("program_id"))

        # Log stage change
        if "stage" in update_dict:
            old_lead = await self.get_lead(lead_id, studio_id)
            if old_lead.stage != update_dict["stage"]:
                self.supabase.table("lead_activities").insert({
                    "studio_id": studio_id,
                    "lead_id": lead_id,
                    "activity_type": "stage_change",
                    "description": f"Stage changed from {old_lead.stage} to {update_dict['stage']}",
                    "created_by": actor_id,
                }).execute()

        try:
            result = (
                self.supabase.table("leads")
                .update(update_dict)
                .eq("id", lead_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        except PostgrestAPIError as exc:
            if exc.code not in OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES or "program_id" not in update_dict:
                raise
            update_dict.pop("program_id", None)
            if not update_dict:
                return await self.get_lead(lead_id, studio_id)
            result = (
                self.supabase.table("leads")
                .update(update_dict)
                .eq("id", lead_id)
                .eq("studio_id", studio_id)
                .execute()
            )
        if not result.data:
            raise HTTPException(status_code=404, detail="Lead not found")
        return LeadResponse(**result.data[0])

    async def get_activities(
        self, lead_id: str, studio_id: str
    ) -> list[LeadActivityResponse]:
        result = (
            self.supabase.table("lead_activities")
            .select("*")
            .eq("lead_id", lead_id)
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .execute()
        )
        return [LeadActivityResponse(**r) for r in (result.data or [])]

    async def add_activity(
        self, lead_id: str, data: LeadActivityCreate, studio_id: str, actor_id: str
    ) -> LeadActivityResponse:
        await self.get_lead(lead_id, studio_id)
        row = data.model_dump()
        row["studio_id"] = studio_id
        row["lead_id"] = lead_id
        row["created_by"] = actor_id
        result = self.supabase.table("lead_activities").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to log activity")
        return LeadActivityResponse(**result.data[0])

    async def convert_to_student(
        self, lead_id: str, data: LeadConvert, studio_id: str, actor_id: str
    ) -> LeadResponse:
        """Convert a lead into a student record."""
        lead = await self.get_lead(lead_id, studio_id)
        program_service = ProgramService(self.supabase)
        program_id = data.program_id or lead.program_id or program_service.get_unassigned_program_id(studio_id)
        program_service.ensure_program_active(studio_id, program_id)
        if lead.converted_student_id:
            return lead

        # Create student from lead data
        student_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{studio_id}:{lead_id}:student"))
        student_data = {
            "id": student_id,
            "studio_id": studio_id,
            "legal_first_name": lead.first_name,
            "legal_last_name": lead.last_name,
            "email": lead.email,
            "phone": lead.phone,
            "status": data.status,
            "membership_start_date": data.membership_start_date or str(date.today()),
            "program_id": program_id,
            "notes": lead.notes,
            "tags": ["converted-lead"],
        }
        existing_student = (
            self.supabase.table("students")
            .select("id")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not existing_student.data:
            student_result = self.supabase.table("students").insert(student_data).execute()
            if not student_result.data:
                raise HTTPException(status_code=500, detail="Failed to create student from lead")
            if program_id:
                try:
                    self.supabase.table("student_program_memberships").insert({
                        "studio_id": studio_id,
                        "student_id": student_id,
                        "program_id": program_id,
                        "status": "active",
                        "started_at": student_data["membership_start_date"],
                    }).execute()
                except PostgrestAPIError as exc:
                    if exc.code not in OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES:
                        raise

        # If minor, create guardian from lead data
        if lead.is_minor and lead.guardian_name:
            parts = lead.guardian_name.split(" ", 1)
            g_first = parts[0]
            g_last = parts[1] if len(parts) > 1 else ""
            guardian_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{studio_id}:{lead_id}:guardian"))
            existing_guardian = (
                self.supabase.table("guardians")
                .select("id")
                .eq("id", guardian_id)
                .eq("studio_id", studio_id)
                .maybe_single()
                .execute()
            )
            if not existing_guardian.data:
                self.supabase.table("guardians").insert({
                    "id": guardian_id,
                    "studio_id": studio_id,
                    "first_name": g_first,
                    "last_name": g_last,
                    "email": lead.guardian_email,
                    "phone": lead.guardian_phone,
                    "is_primary_contact": True,
                }).execute()

            link_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{student_id}:{guardian_id}:link"))
            existing_link = (
                self.supabase.table("student_guardians")
                .select("id")
                .eq("id", link_id)
                .maybe_single()
                .execute()
            )
            if not existing_link.data:
                self.supabase.table("student_guardians").insert({
                    "id": link_id,
                    "student_id": student_id,
                    "guardian_id": guardian_id,
                }).execute()

        # Update lead
        lead_update_result = self.supabase.table("leads").update({
            "stage": "enrolled",
            "converted_student_id": student_id,
            "follow_up_date": None,
        }).eq("id", lead_id).eq("studio_id", studio_id).execute()
        if not lead_update_result.data:
            raise HTTPException(
                status_code=500,
                detail="Student was created but the lead could not be marked enrolled",
            )

        # Activity log
        self.supabase.table("lead_activities").insert({
            "studio_id": studio_id,
            "lead_id": lead_id,
            "activity_type": "stage_change",
            "description": f"Converted to student (ID: {student_id})",
            "created_by": actor_id,
        }).execute()

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "lead.converted",
            "entity_type": "lead",
            "entity_id": lead_id,
            "metadata": {"student_id": student_id},
        }).execute()

        return await self.get_lead(lead_id, studio_id)
