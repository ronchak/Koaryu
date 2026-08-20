import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from postgrest.exceptions import APIError as PostgrestAPIError

from app.api.v1.endpoints.students import bulk_archive_students
from app.schemas.student import BulkStudentArchiveRequest
from app.services.student_bulk_actions import StudentBulkActions
from tests.fakes.supabase import RpcBackedSupabase


STUDENT_ONE = "11111111-1111-4111-8111-111111111111"
STUDENT_TWO = "22222222-2222-4222-8222-222222222222"


class ArchiveSupabase(RpcBackedSupabase):
    def __init__(self, result=3, error=None):
        super().__init__()
        self.result = result
        self.error = error

    def _rpc_archive_students_bulk_atomic(self, params):
        if self.error:
            raise self.error
        return self.result


class StudentBulkArchiveTest(unittest.TestCase):
    def test_schema_rejects_empty_oversized_and_malformed_ids(self):
        with self.assertRaises(ValidationError):
            BulkStudentArchiveRequest(student_ids=[])
        with self.assertRaises(ValidationError):
            BulkStudentArchiveRequest(student_ids=[STUDENT_ONE] * 201)
        with self.assertRaises(ValidationError):
            BulkStudentArchiveRequest(student_ids=["not-a-uuid"])

    def test_service_deduplicates_and_uses_one_archive_rpc(self):
        supabase = ArchiveSupabase(result=2)
        count = asyncio.run(StudentBulkActions(supabase).archive_students(
            BulkStudentArchiveRequest(student_ids=[STUDENT_TWO, STUDENT_ONE, STUDENT_TWO]),
            "studio-1",
            "actor-1",
        ))
        self.assertEqual(count, 2)
        self.assertEqual(len(supabase.rpc_calls), 1)
        self.assertEqual(
            supabase.rpc_calls[0],
            (
                "archive_students_bulk_atomic",
                {
                    "p_studio_id": "studio-1",
                    "p_actor_id": "actor-1",
                    "p_student_ids": [STUDENT_TWO, STUDENT_ONE],
                },
            ),
        )

    def test_service_maps_provider_not_found_and_role_errors_safely(self):
        for code, status, detail in (
            ("P0002", 404, "One or more students were not found"),
            ("42501", 403, "Bulk student archive requires a roster manager role."),
        ):
            error = PostgrestAPIError({"code": code, "message": "provider detail"})
            with self.subTest(code=code), self.assertRaises(HTTPException) as raised:
                asyncio.run(StudentBulkActions(ArchiveSupabase(error=error)).archive_students(
                    BulkStudentArchiveRequest(student_ids=[STUDENT_ONE]),
                    "studio-1",
                    "actor-1",
                ))
            self.assertEqual(raised.exception.status_code, status)
            self.assertEqual(raised.exception.detail, detail)
            self.assertNotIn("provider detail", str(raised.exception.detail))

    def test_endpoint_returns_updated_and_invalidates_dashboard_after_success(self):
        supabase = ArchiveSupabase(result=1)
        with patch("app.api.v1.endpoints.students.dashboard_summary_fact_cache.invalidate") as invalidate:
            response = asyncio.run(bulk_archive_students(
                BulkStudentArchiveRequest(student_ids=[STUDENT_ONE]),
                user_id="actor-1",
                studio_id="studio-1",
                supabase=supabase,
            ))
        self.assertEqual(response, {"updated": 1})
        invalidate.assert_called_once_with("studio-1", domain="dashboard")
        self.assertEqual(len(supabase.rpc_calls), 1)

    def test_endpoint_does_not_invalidate_when_rpc_fails(self):
        error = PostgrestAPIError({"code": "P0002", "message": "provider detail"})
        with patch("app.api.v1.endpoints.students.dashboard_summary_fact_cache.invalidate") as invalidate:
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(bulk_archive_students(
                    BulkStudentArchiveRequest(student_ids=[STUDENT_ONE]),
                    user_id="actor-1",
                    studio_id="studio-1",
                    supabase=ArchiveSupabase(error=error),
                ))
        self.assertEqual(raised.exception.status_code, 404)
        invalidate.assert_not_called()
