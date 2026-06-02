import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.schemas.student import CsvImportOptions
from app.services.student_import_executor import StudentImportExecutor
from tests.fakes.supabase import RpcBackedSupabase


class FakeSupabase(RpcBackedSupabase):
    def _rpc_import_student_row_atomic(self, params: dict) -> list[dict]:
        return [{
            "student_id": params["p_student"]["id"],
            "guardian_imported": bool(params.get("p_guardian_name")),
        }]


class FakeImportRunStore:
    latest = None

    def __init__(self, _supabase):
        self.failed_messages = []
        FakeImportRunStore.latest = self

    def claim(self, **_kwargs):
        return (
            {"id": "44444444-4444-4444-8444-444444444444"},
            None,
            "idempotency-key",
            "worker-token",
        )

    def ensure_claim_active(self, _import_run_id, _processing_token):
        return None

    def mark_failed(self, _import_run_id, _processing_token, message):
        self.failed_messages.append(message)
        return True


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

        executor = StudentImportExecutor(FakeSupabase())
        executor.memberships = SimpleNamespace(
            normalize_program_ids_for_write=normalize_program_ids
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
        self.assertNotIn("row write failed", row["issues"][0].message)
        self.assertIn("Retry or contact support", row["issues"][0].message)

    def test_execute_import_sanitizes_unexpected_failure_response_and_failed_run_message(self):
        executor = StudentImportExecutor(FakeSupabase())

        def fail_prepare_import(*_args, **_kwargs):
            raise RuntimeError("database constraint students_email_key leaked")

        executor.planner = SimpleNamespace(prepare_import=fail_prepare_import)

        with patch("app.services.student_import_executor.StudentImportRunStore", FakeImportRunStore):
            with self.assertRaises(HTTPException) as context:
                import asyncio

                asyncio.run(
                    executor.execute_import(
                        rows=[{"First Name": "Ava"}],
                        mapping={"First Name": "legal_first_name"},
                        options=CsvImportOptions(),
                        studio_id="22222222-2222-4222-8222-222222222222",
                        actor_id="actor-1",
                    )
                )

        self.assertEqual(context.exception.status_code, 500)
        self.assertEqual(context.exception.detail["code"], "STUDENT_IMPORT_FAILED")
        self.assertNotIn("students_email_key", context.exception.detail["message"])
        self.assertEqual(
            FakeImportRunStore.latest.failed_messages,
            ["Student import failed unexpectedly. Retry or contact support."],
        )


if __name__ == "__main__":
    unittest.main()
