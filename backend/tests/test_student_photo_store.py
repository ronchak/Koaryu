import asyncio
import unittest

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from storage3.utils import StorageException

from app.services.student_photo_store import StudentPhotoStore


class FakeUploadFile:
    def __init__(self, content: bytes, content_type: str):
        self.content = content
        self.content_type = content_type

    async def read(self, size: int = -1):
        if size is None or size < 0:
            return self.content
        return self.content[:size]


class FakeStorage:
    def __init__(self, bucket):
        self.bucket = bucket

    def from_(self, bucket_name: str):
        self.bucket.bucket_name = bucket_name
        return self.bucket


class FakeSupabase:
    def __init__(self, bucket):
        self.storage = FakeStorage(bucket)


class StudentPhotoStoreTests(unittest.TestCase):
    def test_columns_available_caches_positive_probe(self):
        class Query:
            calls = 0

            def select(self, columns):
                self.columns = columns
                return self

            def limit(self, value):
                self.limit_value = value
                return self

            def execute(self):
                Query.calls += 1

        class Supabase(FakeSupabase):
            def table(self, name):
                self.table_name = name
                return Query()

        supabase = Supabase(bucket=None)
        store = StudentPhotoStore(supabase)

        self.assertTrue(store.columns_available())
        self.assertTrue(store.columns_available())
        self.assertEqual(supabase.table_name, "students")
        self.assertEqual(Query.calls, 1)

    def test_columns_available_caches_missing_photo_columns(self):
        class Query:
            calls = 0

            def select(self, columns):
                return self

            def limit(self, value):
                return self

            def execute(self):
                Query.calls += 1
                raise PostgrestAPIError({
                    "message": "column students.photo_path does not exist",
                    "code": "42703",
                })

        class Supabase(FakeSupabase):
            def table(self, name):
                return Query()

        store = StudentPhotoStore(Supabase(bucket=None))

        self.assertFalse(store.columns_available())
        self.assertFalse(store.columns_available())
        self.assertEqual(Query.calls, 1)

    def test_read_validated_file_accepts_declared_png_content(self):
        store = StudentPhotoStore(FakeSupabase(bucket=None))
        upload = FakeUploadFile(b"\x89PNG\r\n\x1a\nimage-bytes", "image/png; charset=binary")

        content, content_type, extension = asyncio.run(store.read_validated_file(upload))

        self.assertEqual(content, b"\x89PNG\r\n\x1a\nimage-bytes")
        self.assertEqual(content_type, "image/png")
        self.assertEqual(extension, "png")

    def test_read_validated_file_rejects_mismatched_declared_type(self):
        store = StudentPhotoStore(FakeSupabase(bucket=None))
        upload = FakeUploadFile(b"\x89PNG\r\n\x1a\nimage-bytes", "image/jpeg")

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(store.read_validated_file(upload))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("does not match", raised.exception.detail)

    def test_create_signed_urls_deduplicates_paths_and_maps_indexed_payloads(self):
        class Bucket:
            def create_signed_urls(self, paths, expires_in):
                self.paths = paths
                self.expires_in = expires_in
                return [
                    {"signedURL": "url-one"},
                    {"path": "studio/students/two/profile", "signedUrl": "url-two"},
                ]

        bucket = Bucket()
        store = StudentPhotoStore(FakeSupabase(bucket))

        result = store.create_signed_urls([
            "studio/students/one/profile",
            "studio/students/one/profile",
            "studio/students/two/profile",
        ])

        self.assertEqual(bucket.paths, ["studio/students/one/profile", "studio/students/two/profile"])
        self.assertEqual(result["studio/students/one/profile"], "url-one")
        self.assertEqual(result["studio/students/two/profile"], "url-two")

    def test_upload_conflict_falls_back_to_update(self):
        class Bucket:
            def __init__(self):
                self.updated = None

            def upload(self, path, content, file_options):
                raise StorageException({"statusCode": 409, "message": "already exists"})

            def update(self, path, content, file_options):
                self.updated = (path, content, file_options)

        bucket = Bucket()
        store = StudentPhotoStore(FakeSupabase(bucket))

        store.upload("studio/students/student/profile", b"data", "image/webp")

        self.assertEqual(bucket.updated[0], "studio/students/student/profile")
        self.assertEqual(bucket.updated[1], b"data")
        self.assertEqual(bucket.updated[2]["content-type"], "image/webp")
        self.assertEqual(bucket.updated[2]["upsert"], "true")

    def test_remove_ignores_missing_objects(self):
        class Bucket:
            def remove(self, paths):
                self.paths = paths
                raise StorageException({"statusCode": 404, "message": "not found"})

        bucket = Bucket()
        store = StudentPhotoStore(FakeSupabase(bucket))

        store.remove(["one", "one", "two"])

        self.assertEqual(bucket.paths, ["one", "two"])


if __name__ == "__main__":
    unittest.main()
