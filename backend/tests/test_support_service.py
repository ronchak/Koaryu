from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.schemas.support import SupportTicketCreate
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

    def test_triage_lists_open_operational_tickets(self):
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
                "subject": "Closed bug",
                "details": "Something happened.",
                "browser_context": {},
                "status": "closed",
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            },
        ]
        service = SupportService(supabase)

        tickets = asyncio.run(service.list_triage_tickets())

        self.assertEqual([ticket.id for ticket in tickets], ["ticket_1"])


if __name__ == "__main__":
    unittest.main()
