import base64
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from storage3.utils import StorageException

from app.services.student_roster_query import (
    StudentRosterCursorError,
    StudentRosterQuery,
    decode_roster_cursor,
    encode_roster_cursor,
    fetch_student_roster_page,
)
from app.schemas.student import StudentRosterPageResponse


STUDIO_ID = "11111111-1111-1111-1111-111111111111"
STUDENT_ID = "22222222-2222-2222-2222-222222222222"


def roster_item() -> dict:
    return {
        "id": STUDENT_ID,
        "studio_id": STUDIO_ID,
        "legal_first_name": "Aiko",
        "legal_last_name": "Tanaka",
        "preferred_name": "Aiko",
        "status": "active",
        "photo_path": None,
        "photo_url": None,
        "email": "aiko@example.invalid",
        "phone": "555-0100",
        "tags": [],
        "membership_start_date": "2026-01-01",
        "guardian_email": None,
        "notes": None,
        "last_attendance_date": "2026-05-10",
        "inactivity_days": 10,
        "reference_date": "2026-05-10",
        "date_of_birth": None,
        "is_minor": False,
        "hold_start_date": None,
        "hold_end_date": None,
        "address_line1": None,
        "address_city": None,
        "address_state": None,
        "address_zip": None,
        "emergency_contact_name": None,
        "emergency_contact_phone": None,
        "emergency_contact_relation": None,
        "program_id": None,
        "current_belt_rank_id": None,
        "photo_updated_at": None,
        "guardians": [],
        "program_memberships": [],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


class FakeRpc:
    def __init__(self, payload: dict):
        self.payload = payload

    def execute(self):
        return SimpleNamespace(data=[self.payload])


class FakeSupabase:
    def __init__(self, payloads: list[dict]):
        self.payloads = list(payloads)
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name: str, params: dict):
        self.calls.append((name, params))
        return FakeRpc(self.payloads.pop(0))


class StudentRosterQueryTest(unittest.TestCase):
    def setUp(self):
        self.settings = SimpleNamespace(SUPABASE_SERVICE_ROLE_KEY="local-roster-cursor-key-" + "x" * 32)
        self.query = StudentRosterQuery.build(
            STUDIO_ID,
            search="  Aiko  ",
            sort_by="name",
            sort_dir="asc",
            page_size=1,
        )

    def test_fetch_is_one_rpc_and_returns_complete_page_metadata(self):
        payload = {
            "items": [roster_item()],
            "total": 3,
            "has_next": True,
            "has_previous": False,
            "next_anchor": {
                "id": STUDENT_ID,
                "revision": "revision-a",
            },
            "previous_anchor": None,
            "cursor_error": None,
        }
        client = FakeSupabase([payload])
        with patch("app.services.student_roster_query.get_settings", return_value=self.settings):
            result = fetch_student_roster_page(client, self.query, cursor=None)

        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0][0], "list_student_roster")
        self.assertEqual(result.total, 3)
        self.assertEqual(result.page_ordinal, 1)
        self.assertTrue(result.has_next)
        self.assertIsNotNone(result.next_cursor)
        self.assertEqual(result.items[0].guardian_email, None)

    def test_cursor_is_bound_to_query_and_tampering_fails_closed(self):
        payload = {
            "items": [roster_item()],
            "total": 1,
            "has_next": True,
            "has_previous": False,
            "next_anchor": {"id": STUDENT_ID, "revision": "revision-a"},
            "previous_anchor": None,
            "cursor_error": None,
        }
        client = FakeSupabase([payload])
        with patch("app.services.student_roster_query.get_settings", return_value=self.settings):
            result = fetch_student_roster_page(client, self.query, cursor=None)
            for mismatched_query in (
                StudentRosterQuery.build(STUDIO_ID, search="Tanaka", sort_by="name", sort_dir="asc", page_size=1),
                StudentRosterQuery.build(STUDIO_ID, sort_by="name", sort_dir="desc", page_size=1),
                StudentRosterQuery.build(STUDIO_ID, sort_by="name", sort_dir="asc", page_size=2),
            ):
                with self.assertRaises(StudentRosterCursorError) as mismatch:
                    decode_roster_cursor(result.next_cursor or "tampered", mismatched_query)
                self.assertEqual(mismatch.exception.code, "cursor_query_mismatch")
            with self.assertRaises(StudentRosterCursorError) as raised:
                decode_roster_cursor((result.next_cursor or "")[:-1] + "0", self.query)
        self.assertIn(raised.exception.code, {"invalid_cursor", "cursor_query_mismatch"})

    def test_stale_rpc_boundary_is_typed_and_never_hydrates(self):
        client = FakeSupabase([
            {
                "items": [],
                "total": 3,
                "has_next": False,
                "has_previous": True,
                "next_anchor": None,
                "previous_anchor": None,
                "cursor_error": {"code": "stale_cursor"},
            }
        ])
        with patch("app.services.student_roster_query.get_settings", return_value=self.settings):
            cursor = encode_roster_cursor(
                self.query,
                ordinal=2,
                direction="next",
                anchor={
                    "id": STUDENT_ID,
                    "revision": "revision-a",
                },
            )
            with self.assertRaises(StudentRosterCursorError) as raised:
                fetch_student_roster_page(client, self.query, cursor=cursor)
        self.assertEqual(raised.exception.code, "stale_cursor")
        self.assertEqual(len(client.calls), 1)

    def test_decoded_cursor_contains_only_non_pii_binding_and_anchor(self):
        with patch("app.services.student_roster_query.get_settings", return_value=self.settings):
            token = encode_roster_cursor(
                self.query,
                ordinal=2,
                direction="next",
                anchor={"id": STUDENT_ID, "revision": "revision-a"},
            )
        encoded_payload = token.split(".", 1)[0]
        payload = json.loads(
            base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        )
        serialized = json.dumps(payload, sort_keys=True)
        for forbidden in ("Aiko", "Tanaka", "aiko@example.invalid", "555-0100", "search"):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(
            set(payload), {"version", "query_fingerprint", "ordinal", "direction", "anchor"}
        )
        self.assertEqual(set(payload["anchor"]), {"id", "revision"})

    def test_roster_photo_signing_is_one_bounded_batch_after_the_rpc(self):
        from app.services.student_service import StudentService

        class NoHydrationSupabase(FakeSupabase):
            def table(self, *_args, **_kwargs):
                raise AssertionError("roster page must not hydrate students")

        row_a = roster_item()
        row_a["photo_path"] = "studio/students/a/profile"
        row_b = roster_item()
        row_b["id"] = "33333333-3333-3333-3333-333333333333"
        row_b["photo_path"] = "studio/students/b/profile"
        page = StudentRosterPageResponse(
            items=[row_a, row_b],
            total=2,
            page_size=50,
            page_ordinal=1,
            has_next=False,
            has_previous=False,
        )
        client = NoHydrationSupabase([])
        service = StudentService(client)
        signer = Mock(
            return_value={
                "studio/students/a/profile": "signed-a",
                "studio/students/b/profile": "signed-b",
            }
        )
        with patch("app.services.student_service.fetch_student_roster_page", return_value=page), patch.object(
            service._student_photo_store, "create_signed_urls", signer
        ):
            result = service.list_roster_page(STUDIO_ID, page_size=50, sort_by="name", sort_dir="asc")
        signer.assert_called_once_with(
            ["studio/students/a/profile", "studio/students/b/profile"]
        )
        self.assertEqual([item.photo_url for item in result.items], ["signed-a", "signed-b"])
        self.assertEqual(client.calls, [])

        signer.reset_mock()
        signer.return_value = {"studio/students/a/profile": None}
        one_page = StudentRosterPageResponse(
            items=[row_a], total=1, page_size=50, page_ordinal=1, has_next=False, has_previous=False
        )
        with patch("app.services.student_service.fetch_student_roster_page", return_value=one_page), patch.object(
            service._student_photo_store, "create_signed_urls", signer
        ):
            result = service.list_roster_page(STUDIO_ID, page_size=50, sort_by="name", sort_dir="asc")
        signer.assert_called_once_with(["studio/students/a/profile"])
        self.assertIsNone(result.items[0].photo_url)

    def test_private_photo_signing_failure_degrades_without_hydration(self):
        from app.services.student_service import StudentService

        class FailingBucket:
            def __init__(self):
                self.paths = None

            def create_signed_urls(self, paths, expires_in):
                self.paths = paths
                raise StorageException({"statusCode": 503, "message": "local signing failure"})

        class Storage:
            def __init__(self, bucket):
                self.bucket = bucket

            def from_(self, bucket_name):
                self.bucket_name = bucket_name
                return self.bucket

        class NoHydrationSupabase(FakeSupabase):
            def table(self, *_args, **_kwargs):
                raise AssertionError("roster page must not hydrate students")

        row = roster_item()
        row["photo_path"] = "studio/students/a/profile"
        page = StudentRosterPageResponse(
            items=[row],
            total=1,
            page_size=50,
            page_ordinal=1,
            has_next=False,
            has_previous=False,
        )
        bucket = FailingBucket()
        client = NoHydrationSupabase([])
        client.storage = Storage(bucket)
        service = StudentService(client)
        with patch("app.services.student_service.fetch_student_roster_page", return_value=page):
            result = service.list_roster_page(STUDIO_ID, page_size=50, sort_by="name", sort_dir="asc")

        self.assertEqual(bucket.paths, ["studio/students/a/profile"])
        self.assertIsNone(result.items[0].photo_url)
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
