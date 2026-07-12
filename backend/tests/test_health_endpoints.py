import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


class HealthEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health_endpoints_accept_get_and_head(self):
        live_paths = (
            "/health",
            "/health/live",
            "/api/v1/health",
            "/api/v1/health/live",
        )
        ready_paths = ("/health/ready", "/api/v1/health/ready")

        for path in (*live_paths, *ready_paths):
            with self.subTest(method="GET", path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                expected_status = "ready" if path.endswith("/ready") else "ok"
                self.assertEqual(response.json()["status"], expected_status)
                self.assertEqual(response.json()["environment"], "development")
                self.assertIsNone(response.json()["commit_sha"])
                self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")

            with self.subTest(method="HEAD", path=path):
                response = self.client.head(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, "")

    def test_health_exposes_only_a_validated_render_commit(self):
        commit_sha = "a" * 40
        with patch.dict(os.environ, {"RENDER_GIT_COMMIT": commit_sha}):
            response = self.client.get("/health/live")

        self.assertEqual(response.json()["commit_sha"], commit_sha)

        with patch.dict(os.environ, {"RENDER_GIT_COMMIT": "unsafe-not-a-sha"}):
            response = self.client.get("/health/live")

        self.assertIsNone(response.json()["commit_sha"])
        self.assertNotIn("unsafe-not-a-sha", response.text)

    def test_readiness_failure_is_sanitized(self):
        class InvalidSettings(SimpleNamespace):
            def validate_runtime_configuration(self):
                raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY contains a provider secret")

        invalid_settings = InvalidSettings(ENVIRONMENT="staging")
        with patch("app.api.v1.endpoints.health.get_settings", return_value=invalid_settings):
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Runtime configuration is not ready.")
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", response.text)


if __name__ == "__main__":
    unittest.main()
