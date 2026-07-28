import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.release_identity import (
    API_SCHEMA_VERSION,
    PRODUCT_RELEASE_VERSION,
    RELEASE_FILE,
    _load_product_release_version,
)
from app.main import app


class ReleaseIdentityTest(unittest.TestCase):
    def test_release_file_drives_runtime_product_identity(self):
        release = json.loads(RELEASE_FILE.read_text(encoding="utf-8"))

        self.assertEqual(PRODUCT_RELEASE_VERSION, release["product_version"])
        self.assertEqual(app.version, API_SCHEMA_VERSION)

        response = TestClient(app).get("/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "name": "Koaryu API",
                "version": API_SCHEMA_VERSION,
                "product_version": PRODUCT_RELEASE_VERSION,
                "api_schema_version": API_SCHEMA_VERSION,
            },
        )

    def test_invalid_release_identity_fails_closed(self):
        invalid_values = (
            {},
            {"product_version": ""},
            {"product_version": "v0.1.2"},
            {"product_version": "not-a-version"},
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            release_path = Path(temp_dir) / "release.json"
            for release in invalid_values:
                with self.subTest(release=release):
                    release_path.write_text(json.dumps(release), encoding="utf-8")
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "must contain a semantic product_version",
                    ):
                        _load_product_release_version(release_path)


if __name__ == "__main__":
    unittest.main()
