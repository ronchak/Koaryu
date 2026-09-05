from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.student import StudentProgramMembershipCreate
from app.services.student_membership_actions import StudentMembershipActions
from tests.fakes.supabase import TableBackedSupabase


class FakeMembershipStore:
    @staticmethod
    def membership_write_payload(payload):
        return payload


class RecordingResponseBuilder:
    def __init__(self):
        self.calls = []

    def fetch_memberships_for_student(self, student_id, studio_id=None):
        self.calls.append((student_id, studio_id))
        return [
            SimpleNamespace(program_id="program_1", status="active", ended_at=None),
            SimpleNamespace(program_id="program_2", status="ended", ended_at="2026-05-01"),
        ]


class StudentMembershipActionsTenantScopeTest(unittest.TestCase):
    def test_list_fetches_memberships_with_student_studio_scope(self):
        supabase = TableBackedSupabase({
            "students": [{"id": "student_1", "studio_id": "studio_1", "deleted_at": None}],
        })
        response_builder = RecordingResponseBuilder()
        actions = StudentMembershipActions(supabase, FakeMembershipStore(), response_builder)

        asyncio.run(actions.list("student_1", "studio_1"))

        self.assertEqual(response_builder.calls, [("student_1", "studio_1")])

    def test_add_maps_concurrent_student_deletion_to_not_found(self):
        actions = StudentMembershipActions(
            TableBackedSupabase(),
            FakeMembershipStore(),
            RecordingResponseBuilder(),
        )
        actions._ensure_student_exists = lambda *_args: None
        missing_student = PostgrestAPIError({
            "code": "P0002",
            "message": "Student not found.",
            "details": "",
            "hint": "",
        })

        with (
            patch("app.services.student_membership_actions.ProgramService.ensure_program_active"),
            patch(
                "app.services.student_membership_actions.execute_required_rpc",
                side_effect=missing_student,
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            asyncio.run(actions.add(
                "student_1",
                StudentProgramMembershipCreate(program_id="program_1"),
                "studio_1",
                "actor_1",
            ))

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "Student not found")


if __name__ == "__main__":
    unittest.main()
