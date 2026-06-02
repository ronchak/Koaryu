import unittest
from types import SimpleNamespace

from app.services.student_import_executor import StudentImportExecutor
from tests.fakes.supabase import RpcBackedSupabase


class FakeSupabase(RpcBackedSupabase):
    def _rpc_import_student_row_atomic(self, params: dict) -> list[dict]:
        return [{
            "student_id": params["p_student"]["id"],
            "guardian_imported": bool(params.get("p_guardian_name")),
        }]


class StudentImportExecutorTest(unittest.TestCase):
    def test_student_row_import_uses_atomic_rpc_contract(self):
        supabase = FakeSupabase()
        executor = StudentImportExecutor(supabase)
        student_id = executor._import_student_row_atomic(
            mapped={
                "id": "11111111-1111-4111-8111-111111111111",
                "studio_id": "22222222-2222-4222-8222-222222222222",
                "legal_first_name": "Ava",
                "legal_last_name": "Nguyen",
                "program_id": "33333333-3333-4333-8333-333333333333",
                "tags": ["trial"],
            },
            studio_id="22222222-2222-4222-8222-222222222222",
            import_run_id="44444444-4444-4444-8444-444444444444",
            processing_token="worker-token",
            row_number=2,
            guardian_fields={
                "guardian_name": "Mina Nguyen",
                "guardian_email": "mina@example.com",
                "guardian_phone": "555-0100",
                "guardian_relation": "Mother",
            },
            program_ids=["33333333-3333-4333-8333-333333333333"],
        )

        self.assertEqual(student_id, "11111111-1111-4111-8111-111111111111")
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["import_student_row_atomic"],
        )
        params = supabase.rpc_calls[0][1]
        self.assertEqual(params["p_processing_token"], "worker-token")
        self.assertEqual(params["p_row_number"], 2)
        self.assertEqual(params["p_guardian_name"], "Mina Nguyen")
        self.assertEqual(params["p_program_ids"], ["33333333-3333-4333-8333-333333333333"])

    def test_failed_unresolved_belt_row_does_not_increment_imported_without_belt(self):
        def normalize_program_ids(_studio_id, program_id, _program_ids):
            return [program_id]

        def deterministic_student_uuid(_run_id, _namespace, _row_number):
            return "11111111-1111-4111-8111-111111111111"

        executor = StudentImportExecutor(FakeSupabase())
        executor.memberships = SimpleNamespace(
            normalize_program_ids_for_write=normalize_program_ids
        )
        executor.setup_writer = SimpleNamespace(
            _deterministic_import_uuid=deterministic_student_uuid
        )
        executor.planner = SimpleNamespace(
            append_import_note=lambda existing, note: f"{existing}\n{note}" if existing else note
        )

        def fail_import(**_kwargs):
            raise RuntimeError("row write failed")

        executor._import_student_row_atomic = fail_import
        row = {
            "row_number": 2,
            "is_valid": True,
            "issues": [],
            "data": {
                "legal_first_name": "Ava",
                "legal_last_name": "Nguyen",
            },
            "resolved_program_id": "33333333-3333-4333-8333-333333333333",
            "unresolved_belt_value": "Blue",
            "resolved_belt_rank_id": None,
        }
        import_runs = SimpleNamespace(ensure_claim_active=lambda _run_id, _token: None)

        imported, imported_without_belt = executor._import_valid_rows(
            planned_rows=[row],
            studio_id="22222222-2222-4222-8222-222222222222",
            import_run_id="44444444-4444-4444-8444-444444444444",
            processing_token="worker-token",
            import_runs=import_runs,
        )

        self.assertEqual(imported, 0)
        self.assertEqual(imported_without_belt, 0)
        self.assertFalse(row["is_valid"])
        self.assertEqual(row["issues"][0].code, "execute_failed")


if __name__ == "__main__":
    unittest.main()
