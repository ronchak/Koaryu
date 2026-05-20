from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.schemas.support import SupportTicketCreate, SupportTicketTriageUpdate, SupportTriageFilters
from app.services.support_service import SupportService


class Result:
    def __init__(self, data):
        self.data = data


class FakeUserResponse:
    def __init__(self, user):
        self.user = user


class FakeAuthAdmin:
    def get_user_by_id(self, user_id):
        return FakeUserResponse(type("User", (), {
            "id": user_id,
            "email": f"{user_id}@example.com",
            "user_metadata": {"full_name": "Test User"},
        })())


class FakeAuth:
    admin = FakeAuthAdmin()


class FakeSupabase:
    def __init__(self):
        self.auth = FakeAuth()
        self.tables = {
            "support_tickets": [],
            "support_ticket_events": [],
        }

    def table(self, name):
        return FakeTable(self, name)

    def rpc(self, name, params):
        return FakeRpc(self, name, params)


class FakeTable:
    def __init__(self, supabase, name):
        self.supabase = supabase
        self.name = name
        self.filters = []
        self.insert_payload = None
        self.order_args = None
        self.limit_value = None

    def select(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.filters.append((key, ("in", set(values))))
        return self

    def order(self, *args, **kwargs):
        self.order_args = (args, kwargs)
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def execute(self):
        rows = self.supabase.tables[self.name]
        if self.insert_payload is not None:
            row = {
                "id": f"{self.name}_1",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
                **self.insert_payload,
            }
            rows.append(row)
            return Result([dict(row)])

        matched = [
            row for row in rows
            if all(
                (row.get(key) in value[1] if isinstance(value, tuple) and value[0] == "in" else row.get(key) == value)
                for key, value in self.filters
            )
        ]
        return Result([dict(row) for row in matched])


class FakeRpc:
    def __init__(self, supabase, name, params):
        self.supabase = supabase
        self.name = name
        self.params = params

    def execute(self):
        if self.name == "support_triage_list_tickets":
            return self._list_triage_tickets()
        if self.name == "support_triage_update_ticket":
            return self._update_triage_ticket()
        raise AssertionError(f"Unexpected RPC {self.name}")

    def _list_triage_tickets(self):
        statuses = set(self.params.get("p_statuses") or ["open", "triaging", "waiting_on_customer"])
        severities = set(self.params.get("p_severities") or ["urgent", "high", "normal", "low"])
        topics = set(self.params.get("p_topics") or [
            "billing",
            "account_access",
            "student_records",
            "bug_report",
            "product_question",
            "other",
        ])
        limit = self.params.get("p_limit") or 50
        severity_rank = {"urgent": 0, "high": 1, "normal": 2, "low": 3}
        rows = [
            row
            for row in self.supabase.tables["support_tickets"]
            if row.get("status") in statuses
            and row.get("severity") in severities
            and row.get("topic") in topics
        ]
        rows.sort(key=lambda row: (severity_rank.get(row.get("severity"), 4), row.get("created_at", ""), row.get("id", "")))
        return Result([dict(row) for row in rows[:limit]])

    def _update_triage_ticket(self):
        ticket_id = self.params.get("p_ticket_id")
        status = self.params.get("p_status")
        note = self.params.get("p_note")
        metadata = self.params.get("p_metadata") or {}
        for row in self.supabase.tables["support_tickets"]:
            if row.get("id") == ticket_id:
                previous_status = row.get("status")
                if status:
                    row["status"] = status
                    row["resolved_at"] = "2026-05-20T01:00:00+00:00" if status in {"resolved", "closed"} else None
                row["updated_at"] = "2026-05-20T01:00:00+00:00"
                event_type = "ticket.triaged" if status and note else "ticket.status_changed" if status else "ticket.note_added"
                self.supabase.tables["support_ticket_events"].append({
                    "id": "event_1",
                    "ticket_id": ticket_id,
                    "studio_id": row.get("studio_id"),
                    "actor_id": None,
                    "event_type": event_type,
                    "message": note,
                    "metadata": {
                        **metadata,
                        "actor": "internal_support_triage",
                        "previous_status": previous_status,
                        "next_status": row.get("status"),
                    },
                    "created_at": "2026-05-20T01:00:00+00:00",
                })
                return Result([dict(row)])
        return Result([])


class SupportServiceTest(unittest.TestCase):
    def test_create_ticket_persists_ticket_and_event(self):
        supabase = FakeSupabase()
        service = SupportService(supabase)
        data = SupportTicketCreate(
            topic="bug_report",
            severity="high",
            subject="Import failure",
            details="The CSV import stalled after upload.",
            page_url="https://koaryu.test/students/import",
            user_agent="test-agent",
            browser_context={"viewport": "1280x720"},
        )

        ticket = asyncio.run(service.create_ticket(data, "studio_1", "user_1"))

        self.assertEqual(ticket.topic, "bug_report")
        self.assertEqual(ticket.requester_email, "user_1@example.com")
        self.assertEqual(ticket.status, "open")
        self.assertEqual(len(supabase.tables["support_ticket_events"]), 1)
        self.assertEqual(supabase.tables["support_ticket_events"][0]["event_type"], "ticket.created")

    def test_non_admin_lists_only_own_tickets(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [
            {
                "id": "ticket_1",
                "studio_id": "studio_1",
                "created_by": "user_1",
                "requester_email": "user_1@example.com",
                "topic": "billing",
                "severity": "normal",
                "subject": "Billing question",
                "details": "How does billing work?",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
            {
                "id": "ticket_2",
                "studio_id": "studio_1",
                "created_by": "user_2",
                "requester_email": "user_2@example.com",
                "topic": "bug_report",
                "severity": "normal",
                "subject": "Bug",
                "details": "Something happened.",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
        ]
        service = SupportService(supabase)

        with patch("app.services.support_service.resolve_admin_staff_role_for_user", side_effect=HTTPException(403, "not admin")):
            tickets = asyncio.run(service.list_tickets("studio_1", "user_1", "studio_1"))

        self.assertEqual([ticket.id for ticket in tickets], ["ticket_1"])

    def test_admin_lists_studio_tickets(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [
            {
                "id": "ticket_1",
                "studio_id": "studio_1",
                "created_by": "user_1",
                "requester_email": "user_1@example.com",
                "topic": "billing",
                "severity": "normal",
                "subject": "Billing question",
                "details": "How does billing work?",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
            {
                "id": "ticket_2",
                "studio_id": "studio_1",
                "created_by": "user_2",
                "requester_email": "user_2@example.com",
                "topic": "bug_report",
                "severity": "normal",
                "subject": "Bug",
                "details": "Something happened.",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
        ]
        service = SupportService(supabase)

        with patch("app.services.support_service.resolve_admin_staff_role_for_user", return_value={"studio_id": "studio_1", "role": "admin"}):
            tickets = asyncio.run(service.list_tickets("studio_1", "admin_1", "studio_1"))

        self.assertEqual([ticket.id for ticket in tickets], ["ticket_1", "ticket_2"])

    def test_triage_lists_open_operational_tickets_by_priority_before_limit(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [
            {
                "id": "ticket_1",
                "studio_id": "studio_1",
                "created_by": "user_1",
                "requester_email": "user_1@example.com",
                "topic": "billing",
                "severity": "normal",
                "subject": "Billing question",
                "details": "How does billing work?",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:02:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
            {
                "id": "ticket_2",
                "studio_id": "studio_1",
                "created_by": "user_2",
                "requester_email": "user_2@example.com",
                "topic": "bug_report",
                "severity": "normal",
                "subject": "Closed bug",
                "details": "Something happened.",
                "browser_context": {},
                "status": "closed",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
            {
                "id": "ticket_3",
                "studio_id": "studio_1",
                "created_by": "user_3",
                "requester_email": "user_3@example.com",
                "topic": "bug_report",
                "severity": "urgent",
                "subject": "Urgent bug",
                "details": "Checkout is not loading.",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:01:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
        ]
        service = SupportService(supabase)

        tickets = asyncio.run(service.list_triage_tickets(SupportTriageFilters(limit=2)))

        self.assertEqual([ticket.id for ticket in tickets], ["ticket_3", "ticket_1"])

    def test_triage_filters_by_status_severity_and_topic(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [
            {
                "id": "ticket_1",
                "studio_id": "studio_1",
                "created_by": "user_1",
                "requester_email": "user_1@example.com",
                "topic": "billing",
                "severity": "urgent",
                "subject": "Billing question",
                "details": "How does billing work?",
                "browser_context": {},
                "status": "waiting_on_customer",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
            {
                "id": "ticket_2",
                "studio_id": "studio_1",
                "created_by": "user_2",
                "requester_email": "user_2@example.com",
                "topic": "bug_report",
                "severity": "urgent",
                "subject": "Bug",
                "details": "Something happened.",
                "browser_context": {},
                "status": "open",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
        ]
        service = SupportService(supabase)

        tickets = asyncio.run(service.list_triage_tickets(SupportTriageFilters(
            statuses=["waiting_on_customer"],
            severities=["urgent"],
            topics=["billing"],
        )))

        self.assertEqual([ticket.id for ticket in tickets], ["ticket_1"])

    def test_triage_update_changes_status_and_inserts_event_atomically(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [{
            "id": "ticket_1",
            "studio_id": "studio_1",
            "created_by": "user_1",
            "requester_email": "user_1@example.com",
            "topic": "billing",
            "severity": "urgent",
            "subject": "Billing question",
            "details": "How does billing work?",
            "browser_context": {},
            "status": "open",
            "created_at": "2026-05-20T00:00:00+00:00",
            "updated_at": "2026-05-20T00:00:00+00:00",
        }]
        service = SupportService(supabase)

        ticket = asyncio.run(service.triage_ticket(
            "ticket_1",
            SupportTicketTriageUpdate(status="triaging", note="Looking into this.", metadata={"source": "test"}),
        ))

        self.assertEqual(ticket.status, "triaging")
        self.assertIsNone(ticket.resolved_at)
        self.assertEqual(len(supabase.tables["support_ticket_events"]), 1)
        self.assertEqual(supabase.tables["support_ticket_events"][0]["event_type"], "ticket.triaged")
        self.assertEqual(supabase.tables["support_ticket_events"][0]["metadata"]["previous_status"], "open")

    def test_triage_update_sets_and_clears_resolved_at(self):
        supabase = FakeSupabase()
        supabase.tables["support_tickets"] = [{
            "id": "ticket_1",
            "studio_id": "studio_1",
            "created_by": "user_1",
            "requester_email": "user_1@example.com",
            "topic": "billing",
            "severity": "normal",
            "subject": "Billing question",
            "details": "How does billing work?",
            "browser_context": {},
            "status": "open",
            "created_at": "2026-05-20T00:00:00+00:00",
            "updated_at": "2026-05-20T00:00:00+00:00",
        }]
        service = SupportService(supabase)

        resolved = asyncio.run(service.triage_ticket("ticket_1", SupportTicketTriageUpdate(status="resolved")))
        reopened = asyncio.run(service.triage_ticket("ticket_1", SupportTicketTriageUpdate(status="open")))

        self.assertEqual(resolved.status, "resolved")
        self.assertIsNotNone(resolved.resolved_at)
        self.assertEqual(reopened.status, "open")
        self.assertIsNone(reopened.resolved_at)


if __name__ == "__main__":
    unittest.main()
