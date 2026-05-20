from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.support import SupportTicketCreate, SupportTicketResponse
from app.services.studio_scope import resolve_admin_staff_role_for_user


def _to_text(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


def _optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if text else None


class SupportService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    async def create_ticket(
        self,
        data: SupportTicketCreate,
        studio_id: str,
        user_id: str,
    ) -> SupportTicketResponse:
        user = self._get_auth_user(user_id)
        metadata = getattr(user, "user_metadata", None) or {}
        requester_name = metadata.get("full_name") or metadata.get("name")
        requester_email = getattr(user, "email", None)
        if not requester_email:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Could not verify your support contact email. Please try again.",
            )

        result = (
            self.supabase.table("support_tickets")
            .insert({
                "studio_id": studio_id,
                "created_by": user_id,
                "requester_email": requester_email,
                "requester_name": requester_name,
                "topic": data.topic,
                "severity": data.severity,
                "subject": data.subject,
                "details": data.details,
                "page_url": data.page_url,
                "user_agent": data.user_agent,
                "browser_context": data.browser_context,
                "status": "open",
            })
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create support ticket.",
            )

        ticket = result.data[0]
        self._insert_event(ticket["id"], studio_id, user_id, "ticket.created", "Support ticket created.", {
            "topic": data.topic,
            "severity": data.severity,
        })
        return self._to_response(ticket)

    async def list_tickets(
        self,
        studio_id: str,
        user_id: str,
        requested_studio_id: Optional[str],
    ) -> list[SupportTicketResponse]:
        is_admin = self._is_admin(user_id, requested_studio_id)
        query = (
            self.supabase.table("support_tickets")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .limit(50)
        )
        if not is_admin:
            query = query.eq("created_by", user_id)

        result = query.execute()
        return [self._to_response(row) for row in (result.data or [])]

    async def list_triage_tickets(self, *, limit: int = 100) -> list[SupportTicketResponse]:
        result = (
            self.supabase.table("support_tickets")
            .select("*")
            .in_("status", ["open", "triaging", "waiting_on_customer"])
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [self._to_response(row) for row in (result.data or [])]

    def _is_admin(self, user_id: str, requested_studio_id: Optional[str]) -> bool:
        try:
            resolve_admin_staff_role_for_user(self.supabase, user_id, requested_studio_id)
            return True
        except HTTPException:
            return False

    def _get_auth_user(self, user_id: str) -> Any:
        try:
            response = self.supabase.auth.admin.get_user_by_id(user_id)
            return response.user
        except Exception:
            return None

    def _insert_event(
        self,
        ticket_id: str,
        studio_id: str,
        actor_id: str,
        event_type: str,
        message: str,
        metadata: dict[str, Any],
    ) -> None:
        self.supabase.table("support_ticket_events").insert({
            "ticket_id": ticket_id,
            "studio_id": studio_id,
            "actor_id": actor_id,
            "event_type": event_type,
            "message": message,
            "metadata": metadata,
        }).execute()

    def _to_response(self, row: dict[str, Any]) -> SupportTicketResponse:
        return SupportTicketResponse(
            id=str(row["id"]),
            studio_id=str(row["studio_id"]),
            created_by=_optional_text(row.get("created_by")),
            requester_email=str(row.get("requester_email") or ""),
            requester_name=_optional_text(row.get("requester_name")),
            topic=row["topic"],
            severity=row["severity"],
            subject=row["subject"],
            details=row["details"],
            page_url=_optional_text(row.get("page_url")),
            user_agent=_optional_text(row.get("user_agent")),
            browser_context=row.get("browser_context") or {},
            status=row["status"],
            created_at=_to_text(row.get("created_at")),
            updated_at=_to_text(row.get("updated_at")),
            resolved_at=_optional_text(row.get("resolved_at")),
        )
