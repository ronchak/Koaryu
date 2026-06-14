import asyncio
import unittest

from app.services.demo_service import DemoService
from tests.fakes.supabase import RpcBackedSupabase


class FakeDemoClearSupabase(RpcBackedSupabase):
    def _rpc_clear_studio_operational_data_atomic(self, params):
        studio_id = params["p_studio_id"]
        clear_tables = [
            "students",
            "leads",
            "belt_ranks",
            "class_sessions",
            "attendance",
            "programs",
        ]
        for table in clear_tables:
            self.tables[table] = [
                row for row in self.tables.get(table, []) if row.get("studio_id") != studio_id
            ]
        return []


class FailingSeedDemoService(DemoService):
    def __init__(self):
        self.events = []
        self.failure_audit = None

    def _clear_demo_surface(self, studio_id):
        self.events.append(("clear", studio_id))

    def _update_studio_for_demo(self, studio_id):
        self.events.append(("update_studio", studio_id))

    def _seed_programs(self, studio_id):
        self.events.append(("seed_programs", studio_id))
        return {"program": "program_1"}

    def _seed_belts(self, studio_id, program_ids):
        self.events.append(("seed_belts", studio_id, dict(program_ids)))
        return {"rank": "rank_1"}

    def _seed_students(self, studio_id, program_ids, rank_ids):
        self.events.append(("seed_students", studio_id, dict(program_ids), dict(rank_ids)))
        raise RuntimeError("seed failure")

    def _write_reset_failure_audit(self, studio_id, actor_id, *, phase, error, cleanup_succeeded, cleanup_error=None):
        self.failure_audit = {
            "studio_id": studio_id,
            "actor_id": actor_id,
            "phase": phase,
            "error_type": error.__class__.__name__,
            "cleanup_succeeded": cleanup_succeeded,
            "cleanup_error": cleanup_error,
        }


class ClearFailingDemoService(DemoService):
    def __init__(self):
        self.events = []
        self.failure_audit = None

    def _clear_demo_surface(self, studio_id):
        self.events.append(("clear", studio_id))
        raise RuntimeError("clear failure")

    def _write_reset_failure_audit(self, studio_id, actor_id, *, phase, error, cleanup_succeeded, cleanup_error=None):
        self.failure_audit = {
            "phase": phase,
            "error_type": error.__class__.__name__,
            "cleanup_succeeded": cleanup_succeeded,
            "cleanup_error": cleanup_error,
        }


class StudioUpdateFailingDemoService(ClearFailingDemoService):
    def _clear_demo_surface(self, studio_id):
        self.events.append(("clear", studio_id))

    def _update_studio_for_demo(self, studio_id):
        self.events.append(("update_studio", studio_id))
        raise RuntimeError("studio update failure")


class AuditFailingDemoService(FailingSeedDemoService):
    def _seed_students(self, studio_id, program_ids, rank_ids):
        self.events.append(("seed_students", studio_id, dict(program_ids), dict(rank_ids)))
        return {"student": "student_1"}

    def _seed_promotions(self, studio_id, actor_id, program_ids, student_ids, rank_ids):
        self.events.append(("seed_promotions", studio_id))

    def _seed_schedule(self, studio_id, program_ids, student_ids):
        self.events.append(("seed_schedule", studio_id))

    def _seed_leads(self, studio_id, actor_id, student_ids):
        self.events.append(("seed_leads", studio_id))

    def _seed_billing(self, studio_id, program_ids, student_ids):
        self.events.append(("seed_billing", studio_id))

    def _write_audit_log(self, studio_id, actor_id):
        self.events.append(("write_audit_log", studio_id, actor_id))
        raise RuntimeError("audit failure")


class DemoResetOrchestrationTest(unittest.TestCase):
    def test_clear_studio_data_uses_atomic_clear_rpc_after_counting(self):
        supabase = FakeDemoClearSupabase({
            "studios": [{"id": "studio_1", "name": "Original Studio"}],
            "students": [{"id": "student_1", "studio_id": "studio_1"}],
            "leads": [{"id": "lead_1", "studio_id": "studio_1"}],
            "belt_ranks": [{"id": "rank_1", "studio_id": "studio_1"}],
            "class_sessions": [{"id": "session_1", "studio_id": "studio_1"}],
            "attendance": [{"id": "attendance_1", "studio_id": "studio_1"}],
            "programs": [{"id": "program_1", "studio_id": "studio_1"}],
        })
        service = DemoService(supabase)

        response = asyncio.run(service.clear_studio_data("studio_1"))

        self.assertEqual(response.studio_name, "Original Studio")
        self.assertEqual(response.counts.students, 1)
        self.assertEqual(response.counts.leads, 1)
        self.assertEqual([name for name, _params in supabase.rpc_calls], ["clear_studio_operational_data_atomic"])
        self.assertFalse(supabase.rpc_calls[0][1]["p_include_platform_rows"])
        direct_deletes = [entry for entry in supabase.query_log if entry["delete"]]
        self.assertEqual(direct_deletes, [])
        self.assertEqual(supabase.tables["students"], [])

    def test_seed_failure_clears_partial_demo_surface_and_records_phase(self):
        service = FailingSeedDemoService()

        with self.assertRaises(RuntimeError):
            asyncio.run(service.reset_demo_studio("studio_1", "actor_1"))

        self.assertEqual(
            [event[0] for event in service.events],
            ["clear", "update_studio", "seed_programs", "seed_belts", "seed_students", "clear"],
        )
        self.assertEqual(service.failure_audit["phase"], "seed_students")
        self.assertEqual(service.failure_audit["error_type"], "RuntimeError")
        self.assertTrue(service.failure_audit["cleanup_succeeded"])

    def test_clear_failure_does_not_retry_destructive_clear(self):
        service = ClearFailingDemoService()

        with self.assertRaises(RuntimeError):
            asyncio.run(service.reset_demo_studio("studio_1", "actor_1"))

        self.assertEqual(service.events, [("clear", "studio_1")])
        self.assertEqual(service.failure_audit["phase"], "clear_existing_data")
        self.assertFalse(service.failure_audit["cleanup_succeeded"])

    def test_studio_update_failure_does_not_repeat_clear(self):
        service = StudioUpdateFailingDemoService()

        with self.assertRaises(RuntimeError):
            asyncio.run(service.reset_demo_studio("studio_1", "actor_1"))

        self.assertEqual(service.events, [("clear", "studio_1"), ("update_studio", "studio_1")])
        self.assertEqual(service.failure_audit["phase"], "update_studio")
        self.assertFalse(service.failure_audit["cleanup_succeeded"])

    def test_audit_failure_does_not_clear_successfully_seeded_demo(self):
        service = AuditFailingDemoService()

        with self.assertRaises(RuntimeError):
            asyncio.run(service.reset_demo_studio("studio_1", "actor_1"))

        self.assertEqual(service.events.count(("clear", "studio_1")), 1)
        self.assertEqual(service.failure_audit["phase"], "write_audit_log")
        self.assertFalse(service.failure_audit["cleanup_succeeded"])


if __name__ == "__main__":
    unittest.main()
