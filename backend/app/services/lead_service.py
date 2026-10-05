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
from app.services.program_service import ProgramService
from app.services.program_records import program_error
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row
from app.services.lead_reads import fetch_lead_rows


CONVERSION_NAMESPACE = uuid.UUID("27c8322f-a4e4-46d7-bfae-018f6b638858")
_CREATE_UNAVAILABLE_DETAIL = (
    "Lead creation could not be confirmed. Check the lead list before trying again."
)
_CREATE_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (
        403,
        "Only studio admins and front desk staff can manage leads.",
    ),
    ("P0002", "AUTOMATION_NOT_FOUND"): (
        404,
        "Lead or related record not found in this studio",
    ),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid lead request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "This lead changed. Reload it before saving.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This lead operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "This lead cannot be changed in its current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (
        409,
        "The studio is busy. Try the lead request again shortly.",
    ),
}


def _parse_create_lead_result(
    result: object, studio_id: str, operation_id: uuid.UUID
) -> LeadResponse:
    if not isinstance(result, dict) or set(result) != {"payload", "operation_id", "replayed"}:
        raise ValueError("Invalid lead creation receipt.")
    if (
        type(result["replayed"]) is not bool
        or not isinstance(result["operation_id"], str)
        or uuid.UUID(result["operation_id"]) != operation_id
    ):
        raise ValueError("Invalid lead creation operation identity.")
    payload = result["payload"]
    # The public response still supports legacy rows; command receipts must carry
    # every fact explicitly, including nulls, without adding response fields.
    if not isinstance(payload, dict) or set(payload) != set(LeadResponse.model_fields):
        raise ValueError("Incomplete lead creation payload.")
    lead = LeadResponse.model_validate(payload, strict=True)
    uuid.UUID(lead.id)
    if uuid.UUID(lead.studio_id) != uuid.UUID(studio_id):
        raise ValueError("Invalid lead creation studio identity.")
    return lead


def _create_lead_error(exc: PostgrestAPIError, requested_program_id: str | None) -> HTTPException:
    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None)
    if isinstance(code, str) and isinstance(message, str):
        if code == "P0001" and message == "PROGRAM_INACTIVE":
            details = getattr(exc, "details", None)
            if isinstance(details, str) and isinstance(requested_program_id, str):
                try:
                    program_id = uuid.UUID(requested_program_id)
                    if uuid.UUID(details) == program_id:
                        return program_error(
                            409,
                            "PROGRAM_INACTIVE",
                            "Archived programs cannot be used for new records.",
                            program_id=str(program_id),
                        )
                except ValueError:
                    pass
        else:
            mapped = _CREATE_ERRORS.get((code, message))
            if mapped is not None:
                return HTTPException(*mapped)
    return HTTPException(503, _CREATE_UNAVAILABLE_DETAIL)


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
        operation_id = data.operation_id or uuid.uuid4()
        try:
            result = self.supabase.rpc(
                "create_lead_atomic_v1",
                {
                    "p_studio_id": studio_id,
                    "p_actor_id": actor_id,
                    "p_operation_id": str(operation_id),
                    "p_request": data.model_dump(mode="json", exclude={"operation_id"}),
                },
            ).execute()
            return _parse_create_lead_result(result.data, studio_id, operation_id)
        except PostgrestAPIError as exc:
            raise _create_lead_error(exc, data.program_id) from None
        except Exception:  # noqa: BLE001 - Provider failures may contain private record data.
            raise HTTPException(503, _CREATE_UNAVAILABLE_DETAIL) from None

    async def get_lead(self, lead_id: str, studio_id: str) -> LeadResponse:
        result = (
            self.supabase.table("leads")
            .select("*")
            .eq("id", lead_id)
            .eq("studio_id", studio_id)
            .limit(2)
            .execute()
        )
        rows = result.data
        if not isinstance(rows, list):
            raise RuntimeError("Lead lookup returned an invalid result")
        if not rows:
            raise HTTPException(status_code=404, detail="Lead not found")
        if len(rows) != 1:
            raise RuntimeError("Lead lookup returned multiple rows")
        return LeadResponse(**rows[0])

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
            if exc.code == "P0001" and exc.message == "LEAD_STUDIO_BUSY":
                raise HTTPException(
                    status_code=409,
                    detail="The studio is being updated. Please retry this lead action.",
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
        if lead.converted_student_id:
            # Restore the pipeline stage under the database row lock. This is not
            # a new enrollment: do not validate/create a program or change the
            # existing student's membership, even if its program was archived.
            return self._execute_lead_command(
                "convert_lead_to_student_atomic",
                {
                    "p_studio_id": studio_id,
                    "p_actor_id": actor_id,
                    "p_lead_id": lead_id,
                    "p_student_id": lead.converted_student_id,
                    "p_program_id": lead.program_id,
                    "p_status": data.status,
                    "p_membership_start_date": data.membership_start_date,
                    "p_guardian_id": None,
                    "p_student_guardian_id": None,
                },
            )
        program_service = ProgramService(self.supabase)
        program_id = (
            data.program_id
            or lead.program_id
            or program_service.get_unassigned_program_id(studio_id)
        )
        program_service.ensure_program_active(studio_id, program_id)
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
