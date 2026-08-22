import unittest

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app


class SchemaExposureTest(unittest.TestCase):
    """The OpenAPI schema is a build-time artifact, not a public endpoint.

    Serving it publishes every route, including ``internal/*`` and the header
    names that guard them. Tests run with ``ENVIRONMENT=test``, which takes the
    same branch as staging and production.
    """

    def setUp(self):
        self.client = TestClient(app)

    def test_environment_under_test_is_not_development(self):
        # Guards the premise of every other assertion in this class.
        self.assertNotEqual(get_settings().ENVIRONMENT, "development")

    def test_schema_and_docs_routes_are_not_served(self):
        self.assertIsNone(app.openapi_url)
        self.assertIsNone(app.docs_url)
        self.assertIsNone(app.redoc_url)

        for path in ("/openapi.json", "/docs", "/redoc"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_schema_still_builds_in_process(self):
        # scripts/generate-api-types.py and the contract tests call app.openapi()
        # directly; disabling the HTTP route must not disable the schema itself.
        schema = app.openapi()

        self.assertIn("/api/v1/auth/me", schema["paths"])
        self.assertIn("ErrorResponse", schema["components"]["schemas"])


if __name__ == "__main__":
    unittest.main()
