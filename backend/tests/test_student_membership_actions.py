from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

from app.services.student_membership_actions import StudentMembershipActions
from tests.fakes.supabase import TableBackedSupabase


class FakeMembershipStore:
    pass


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

    def test_active_program_ids_fetches_memberships_with_student_studio_scope(self):
        response_builder = RecordingResponseBuilder()
        actions = StudentMembershipActions(
            TableBackedSupabase(),
            FakeMembershipStore(),
            response_builder,
        )

        active_ids = actions._active_program_ids("student_1", "studio_1")

        self.assertEqual(active_ids, ["program_1"])
        self.assertEqual(response_builder.calls, [("student_1", "studio_1")])


if __name__ == "__main__":
    unittest.main()
