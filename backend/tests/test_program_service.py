import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import programs
from app.core.deps import get_current_studio_id, get_supabase
from app.services.program_service import ProgramService
from tests.fakes.supabase import TableBackedSupabase

USAGE_TABLES = ["student_program_memberships", "class_sessions", "leads", "belt_ladders"]


def _program_row(program_id, studio_id="studio-1", archived_at=None):
    return {
        "id": program_id,
        "studio_id": studio_id,
        "name": program_id,
        "description": None,
        "color_hex": "#64748B",
        "sort_order": 10,
        "is_system": False,
        "archived_at": archived_at,
        "created_at": "2026-05-01T00:00:00Z",
        "updated_at": "2026-05-01T00:00:00Z",
    }


def _program_list_supabase():
    usage_row = {"studio_id": "studio-1", "program_id": "p1"}
    return TableBackedSupabase(
        {
            "programs": [
                _program_row("p1"),
                _program_row("p2", archived_at="2026-06-01T00:00:00Z"),
                _program_row("other", studio_id="studio-2"),
            ],
            "student_program_memberships": [{**usage_row, "status": "active", "ended_at": None}],
            "class_sessions": [{**usage_row, "status": "scheduled"}],
            "leads": [usage_row],
            "belt_ladders": [usage_row],
        }
    )


def _get_programs(supabase, query):
    app = FastAPI()
    app.include_router(programs.router)
    app.dependency_overrides[get_current_studio_id] = lambda: "studio-1"
    app.dependency_overrides[get_supabase] = lambda: supabase
    response = TestClient(app).get(f"/programs{query}")
    assert response.status_code == 200, response.text
    return response.json()


class ProgramServiceTest(unittest.TestCase):
    def test_list_programs_does_not_repair_ladders(self):
        supabase = TableBackedSupabase(
            {
                "programs": [
                    {
                        "id": "program-1",
                        "studio_id": "studio-1",
                        "name": "Youth Karate",
                        "description": None,
                        "color_hex": "#64748B",
                        "sort_order": 10,
                        "is_system": False,
                        "archived_at": None,
                        "created_at": "2026-05-01T00:00:00Z",
                        "updated_at": "2026-05-01T00:00:00Z",
                    }
                ],
                "student_program_memberships": [],
                "class_sessions": [],
                "leads": [],
                "belt_ladders": [],
            }
        )
        service = ProgramService(supabase)

        programs = service.list_programs_sync("studio-1")
        self.assertTrue(
            all(
                q["insert"] is None
                and q["upsert"] is None
                and q["update"] is None
                and not q["delete"]
                for q in supabase.query_log
            )
        )

        self.assertEqual(len(programs), 1)
        self.assertEqual(programs[0].id, "program-1")
        self.assertEqual(programs[0].usage.belt_ladder_count, 0)


class ProgramListEndpointTest(unittest.TestCase):
    def test_usage_stays_default_and_metadata_mode_reads_only_programs(self):
        cases = [
            ("", False, ["p1"], True),
            ("?include_usage=true", False, ["p1"], True),
            ("?include_archived=true", True, ["p1", "p2"], True),
            ("?include_usage=false", False, ["p1"], False),
            ("?include_archived=true&include_usage=false", True, ["p1", "p2"], False),
        ]
        for query, include_archived, expected_ids, include_usage in cases:
            with self.subTest(query=query):
                supabase = _program_list_supabase()

                rows = _get_programs(supabase, query)

                self.assertEqual([row["id"] for row in rows], expected_ids)
                self.assertEqual(
                    [entry["table"] for entry in supabase.query_log],
                    ["programs", *USAGE_TABLES] if include_usage else ["programs"],
                )
                program_read = supabase.query_log[0]
                self.assertIn(("eq", "studio_id", "studio-1"), program_read["filters"])
                self.assertEqual(
                    ("is", "archived_at", "null") in program_read["filters"],
                    not include_archived,
                )
                expected_count = 1 if include_usage else 0
                self.assertEqual(
                    set(rows[0]["usage"].values()),
                    {expected_count},
                    "metadata mode returns schema-default usage, never computed usage",
                )

    def test_empty_program_list_skips_usage_in_both_modes(self):
        for query in ("", "?include_usage=false"):
            with self.subTest(query=query):
                supabase = TableBackedSupabase({"programs": []})

                self.assertEqual(_get_programs(supabase, query), [])
                self.assertEqual([entry["table"] for entry in supabase.query_log], ["programs"])


if __name__ == "__main__":
    unittest.main()
