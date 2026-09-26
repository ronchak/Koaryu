import uuid
from app.services.studio_business_date import studio_today
from typing import Optional
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client
from fastapi import HTTPException
from app.schemas.lead import (
    LeadCreate,
    LeadUpdate,
    LeadResponse,
    LeadActivityCreate,
    LeadActivityResponse,
    LeadConvert,
    LeadFollowUpRequest,
)
from app.services.studio_scope import ensure_staff_user_in_studio
from app.services.program_service import ProgramService
from app.services.program_records import program_error
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row
from app.services.lead_reads import fetch_lead_rows


CONVERSION_NAMESPACE = uuid.UUID("27c8322f-a4e4-46d7-bfae-018f6b638858")
OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


class LeadService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def list_leads(
        self, studio_id: str, stage: Optional[str] = None, source: Optional[str] = None
    ) -> list[LeadResponse]:
        return [
            LeadResponse(**row) for row in fetch_lead_rows(self.supabase, studio_id, stage, source)
        ]

    async def create_lead(self, data: LeadCreate, studio_id: str, actor_id: str) -> LeadResponse:
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
        self.supabase.table("lead_activities").insert(
            {
                "studio_id": studio_id,
                "lead_id": result.data[0]["id"],
                "activity_type": "note",
                "description": "Lead created",
                "created_by": actor_id,
            }
        ).execute()

        self.supabase.table("audit_logs").insert(
            {
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "lead.created",
                "entity_type": "lead",
                "entity_id": result.data[0]["id"],
                "metadata": {"name": f"{data.first_name} {data.last_name}"},
            }
        ).execute()

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
        return self._execute_lead_command(
            "update_lead_atomic",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_lead_id": lead_id,
                "p_patch": update_dict,
            },
        )

    async def follow_up_lead(
        self, lead_id: str, data: LeadFollowUpRequest, studio_id: str, actor_id: str
    ) -> LeadResponse:
        # SQL resolves defaults under the row lock and replays the original result.
        # Pre-reading the lead here would race a concurrent update or command retry.
        return self._execute_lead_command(
            "follow_up_lead_atomic",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_lead_id": lead_id,
                "p_operation_id": str(data.operation_id),
                "p_request": {"next_stage": data.next_stage},
            },
        )

    def _execute_lead_command(self, name: str, params: dict) -> LeadResponse:
        try:
            result = execute_required_rpc(self.supabase, name, params)
        except PostgrestAPIError as exc:
            if exc.code == "P0001" and exc.message == "PROGRAM_INACTIVE":
                try:
                    program_id = str(uuid.UUID(exc.details))
                except (ValueError, TypeError, AttributeError):
                    raise exc
                raise program_error(
                    409,
                    "PROGRAM_INACTIVE",
                    "Archived programs cannot be used for new records.",
                    program_id=program_id,
                ) from exc
            if exc.code == "P0001" and exc.message == "LEAD_ALREADY_CONVERTED":
                raise HTTPException(
                    status_code=409, detail="This lead has already been converted."
                ) from exc
            error = {
                "22023": (400, "Invalid lead command"),
                "42501": (403, "Not authorized to perform this lead command"),
                "P0002": (404, "Lead or related record not found in this studio"),
            }.get(exc.code)
            if exc.code == "23505" and exc.message == "Follow-up operation identity conflict.":
                error = (409, "This operation conflicts with a recorded lead command")
            if error is None:
                raise
            # Database/provider details can contain private record values.
            raise HTTPException(status_code=error[0], detail=error[1]) from exc
        row = first_rpc_row(result)
        if row is None:
            raise HTTPException(status_code=500, detail="Failed to complete lead command")
        return LeadResponse(**row)

    async def get_activities(self, lead_id: str, studio_id: str) -> list[LeadActivityResponse]:
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
        program_id = (
            data.program_id
            or lead.program_id
            or program_service.get_unassigned_program_id(studio_id)
        )
        program_service.ensure_program_active(studio_id, program_id)
        if lead.converted_student_id:
            return lead

        student_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{studio_id}:{lead_id}:student"))
        guardian_id = None
        link_id = None
        if lead.is_minor and lead.guardian_name:
            guardian_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{studio_id}:{lead_id}:guardian"))
            link_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{student_id}:{guardian_id}:link"))

        membership_start_date = data.membership_start_date
        if not membership_start_date:
            studio = (
                self.supabase.table("studios")
                .select("timezone")
                .eq("id", studio_id)
                .single()
                .execute()
            )
            membership_start_date = studio_today((studio.data or {}).get("timezone"))[0].isoformat()

        result = execute_required_rpc(
            self.supabase,
            "convert_lead_to_student_atomic",
            {
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_lead_id": lead_id,
                "p_student_id": student_id,
                "p_program_id": program_id,
                "p_status": data.status,
                "p_membership_start_date": membership_start_date,
                "p_guardian_id": guardian_id,
                "p_student_guardian_id": link_id,
            },
        )
        converted = first_rpc_row(result)
        if not converted:
            raise HTTPException(
                status_code=500,
                detail="Failed to convert lead to student",
            )
        return LeadResponse(**converted)
