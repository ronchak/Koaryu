import unittest
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.schemas.student import CsvImportOptions, CsvImportResult
from app.services.student_import_runs import IMPORT_RUN_OPERATION, IMPORT_RUN_STALE_AFTER_SECONDS, StudentImportRunStore
from tests.fakes.supabase import RpcBackedSupabase


class FakeSupabase(RpcBackedSupabase):
    def __init__(self, tables: dict[str, list[dict]]):
        super().__init__(tables)

    def _rpc_claim_student_import_run(self, params: dict) -> list[dict]:
        rows = self.tables.setdefault("student_import_runs", [])
        now = datetime.now(timezone.utc)
        run_row = next(
            (
                row
                for row in rows
                if row.get("studio_id") == params["p_studio_id"]
                and row.get("operation") == params["p_operation"]
                and row.get("idempotency_key") == params["p_idempotency_key"]
            ),
            None,
        )
        if run_row is None:
            run_row = {
                "id": str(uuid.uuid4()),
                "studio_id": params["p_studio_id"],
                "actor_id": params["p_actor_id"],
                "operation": params["p_operation"],
                "idempotency_key": params["p_idempotency_key"],
                "request_hash": params["p_request_hash"],
                "status": "processing",
                "result_json": None,
                "error_message": None,
                "started_at": now.isoformat(),
                "completed_at": None,
                "processing_token": params["p_processing_token"],
                "processing_started_at": now.isoformat(),
            }
            rows.append(run_row)
            return [{"claim_status": "claimed", "run_row": dict(run_row)}]
        if run_row.get("request_hash") != params["p_request_hash"]:
            return [{"claim_status": "hash_mismatch", "run_row": dict(run_row)}]
        if run_row.get("status") == "completed" and run_row.get("result_json") is not None:
            return [{"claim_status": "completed", "run_row": dict(run_row)}]
        if run_row.get("status") == "processing" and not self._claim_is_stale(run_row, now):
            return [{"claim_status": "already_processing", "run_row": dict(run_row)}]
        run_row.update({
            "actor_id": params["p_actor_id"],
            "status": "processing",
            "error_message": None,
            "started_at": now.isoformat(),
            "completed_at": None,
            "processing_token": params["p_processing_token"],
            "processing_started_at": now.isoformat(),
        })
        return [{"claim_status": "claimed", "run_row": dict(run_row)}]

    def _rpc_heartbeat_student_import_run(self, params: dict) -> list[dict]:
        for row in self.tables.setdefault("student_import_runs", []):
            if (
                row.get("id") == params["p_import_run_id"]
                and row.get("status") == "processing"
                and row.get("processing_token") == params["p_processing_token"]
            ):
                row["processing_started_at"] = datetime.now(timezone.utc).isoformat()
                return [{"updated": True, "run_row": dict(row)}]
        return [{"updated": False, "run_row": None}]

    def _rpc_finish_student_import_run(self, params: dict) -> list[dict]:
        for row in self.tables.setdefault("student_import_runs", []):
            if (
                row.get("id") == params["p_import_run_id"]
                and row.get("processing_token") == params["p_processing_token"]
            ):
                row["status"] = params["p_status"]
                if params["p_status"] == "completed":
                    row["result_json"] = params["p_result_json"]
                    row["error_message"] = None
                    row["completed_at"] = datetime.now(timezone.utc).isoformat()
                if params["p_status"] == "failed":
                    row["error_message"] = params["p_error_message"]
                row["processing_token"] = None
                row["processing_started_at"] = None
                return [{"updated": True, "run_row": dict(row)}]
        return [{"updated": False, "run_row": None}]

    @staticmethod
    def _parse_datetime(value):
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _claim_is_stale(self, run_row: dict, now: datetime) -> bool:
        started_at = (
            run_row.get("processing_started_at")
            or run_row.get("updated_at")
            or run_row.get("created_at")
        )
        if not started_at:
            return False
        return (now - self._parse_datetime(started_at)).total_seconds() >= IMPORT_RUN_STALE_AFTER_SECONDS


def import_payload():
    rows = [{"First Name": "Ava", "Last Name": "Nguyen"}]
    mapping = {"First Name": "legal_first_name", "Last Name": "legal_last_name"}
    options = CsvImportOptions()
    return rows, mapping, options


def import_run_row(*, status: str, processing_token: Optional[str], processing_started_at: str) -> dict:
    rows, mapping, options = import_payload()
    return {
        "id": "run-1",
        "studio_id": "studio-1",
        "actor_id": "user-old",
        "operation": IMPORT_RUN_OPERATION,
        "idempotency_key": "import-key",
        "request_hash": StudentImportRunStore.compute_request_hash(rows, mapping, options),
        "status": status,
        "result_json": None,
        "error_message": None,
        "started_at": processing_started_at,
        "completed_at": None,
        "processing_token": processing_token,
        "processing_started_at": processing_started_at,
        "created_at": processing_started_at,
        "updated_at": processing_started_at,
    }


class StudentImportRunClaimTest(unittest.TestCase):
    def test_stale_import_run_reclaim_sets_token_and_completion_clears_it(self):
        old_started_at = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        supabase = FakeSupabase({
            "student_import_runs": [
                import_run_row(
                    status="processing",
                    processing_token="old-worker",
                    processing_started_at=old_started_at,
                )
            ]
        })
        store = StudentImportRunStore(supabase)
        rows, mapping, options = import_payload()

        run_row, cached, key, token = store.claim(
            studio_id="studio-1",
            actor_id="user-new",
            rows=rows,
            mapping=mapping,
            options=options,
            idempotency_key="import-key",
        )

        self.assertIsNone(cached)
        self.assertEqual(key, "import-key")
        self.assertIsNotNone(token)
        self.assertNotEqual(token, "old-worker")
        self.assertEqual(run_row["processing_token"], token)
        self.assertEqual(run_row["actor_id"], "user-new")
        self.assertEqual(run_row["status"], "processing")

        result = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1)
        self.assertTrue(store.save_result("run-1", token, result))
        stored = supabase.tables["student_import_runs"][0]
        self.assertEqual(stored["status"], "completed")
        self.assertIsNone(stored["processing_token"])
        self.assertIsNone(stored["processing_started_at"])
        self.assertEqual(stored["result_json"]["imported_count"], 1)

    def test_lost_claim_cannot_complete_or_fail_import_run(self):
        now = datetime.now(timezone.utc).isoformat()
        supabase = FakeSupabase({
            "student_import_runs": [
                import_run_row(
                    status="processing",
                    processing_token="other-worker",
                    processing_started_at=now,
                )
            ]
        })
        store = StudentImportRunStore(supabase)
        result = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1)

        self.assertFalse(store.save_result("run-1", "old-worker", result))
        self.assertFalse(store.mark_failed("run-1", "old-worker", "boom"))
        stored = supabase.tables["student_import_runs"][0]
        self.assertEqual(stored["status"], "processing")
        self.assertEqual(stored["processing_token"], "other-worker")
        self.assertIsNone(stored["result_json"])
        self.assertIsNone(stored["error_message"])

    def test_active_claim_check_renews_lease_before_retry_can_reclaim(self):
        old_started_at = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        supabase = FakeSupabase({
            "student_import_runs": [
                import_run_row(
                    status="processing",
                    processing_token="active-worker",
                    processing_started_at=old_started_at,
                )
            ]
        })
        store = StudentImportRunStore(supabase)
        rows, mapping, options = import_payload()

        store.ensure_claim_active("run-1", "active-worker")

        stored = supabase.tables["student_import_runs"][0]
        self.assertEqual(stored["processing_token"], "active-worker")
        self.assertNotEqual(stored["processing_started_at"], old_started_at)
        with self.assertRaises(HTTPException) as raised:
            store.claim(
                studio_id="studio-1",
                actor_id="user-new",
                rows=rows,
                mapping=mapping,
                options=options,
                idempotency_key="import-key",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(stored["processing_token"], "active-worker")

    def test_student_import_uses_worker_claim_rpc_when_available(self):
        supabase = FakeSupabase({"student_import_runs": []})
        store = StudentImportRunStore(supabase)
        rows, mapping, options = import_payload()

        run_row, cached, key, token = store.claim(
            studio_id="studio-1",
            actor_id="user-new",
            rows=rows,
            mapping=mapping,
            options=options,
            idempotency_key="import-key",
        )

        self.assertIsNone(cached)
        self.assertEqual(key, "import-key")
        self.assertEqual(run_row["id"], supabase.tables["student_import_runs"][0]["id"])
        self.assertIsNotNone(token)

        store.ensure_claim_active(run_row["id"], token)
        result = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1)
        self.assertTrue(store.save_result(run_row["id"], token, result))
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["claim_student_import_run", "heartbeat_student_import_run", "finish_student_import_run"],
        )
        self.assertEqual(supabase.tables["student_import_runs"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
