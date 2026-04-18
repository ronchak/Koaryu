from typing import Optional
from supabase import Client
from fastapi import HTTPException
from app.schemas.lead import (
    LeadCreate, LeadUpdate, LeadResponse,
    LeadActivityCreate, LeadActivityResponse,
    LeadConvert,
)


VALID_STAGES = {"inquiry", "trial_scheduled", "trial_completed", "offer_sent", "enrolled", "closed_lost"}
VALID_SOURCES = {"walk_in", "referral", "social", "search", "website", "other"}


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
        row["studio_id"] = studio_id
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
        update_dict = data.model_dump(exclude_none=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")

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
        if lead.stage == "enrolled":
            raise HTTPException(status_code=409, detail="Lead already enrolled")

        # Create student from lead data
        student_data = {
            "studio_id": studio_id,
            "legal_first_name": lead.first_name,
            "legal_last_name": lead.last_name,
            "email": lead.email,
            "phone": lead.phone,
            "status": data.status,
            "membership_start_date": data.membership_start_date,
            "program_id": data.program_id,
            "tags": ["converted-lead"],
        }
        student_result = self.supabase.table("students").insert(student_data).execute()
        if not student_result.data:
            raise HTTPException(status_code=500, detail="Failed to create student from lead")

        student_id = student_result.data[0]["id"]

        # If minor, create guardian from lead data
        if lead.is_minor and lead.guardian_name:
            parts = lead.guardian_name.split(" ", 1)
            g_first = parts[0]
            g_last = parts[1] if len(parts) > 1 else ""
            g_result = self.supabase.table("guardians").insert({
                "studio_id": studio_id,
                "first_name": g_first,
                "last_name": g_last,
                "email": lead.guardian_email,
                "phone": lead.guardian_phone,
                "is_primary_contact": True,
            }).execute()
            if g_result.data:
                self.supabase.table("student_guardians").insert({
                    "student_id": student_id,
                    "guardian_id": g_result.data[0]["id"],
                }).execute()

        # Update lead
        self.supabase.table("leads").update({
            "stage": "enrolled",
            "converted_student_id": student_id,
        }).eq("id", lead_id).execute()

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
