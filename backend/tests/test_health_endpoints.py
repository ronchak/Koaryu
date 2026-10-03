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
        live_keys = {"status", "version", "service", "environment", "commit_sha"}
        ready_keys = live_keys | {"configured_stripe_mode"}

        for path in (*live_paths, *ready_paths):
            with self.subTest(method="GET", path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    set(response.json()),
                    ready_keys if path.endswith("/ready") else live_keys,
                )
                expected_status = "ready" if path.endswith("/ready") else "ok"
                self.assertEqual(response.json()["status"], expected_status)
                self.assertEqual(response.json()["environment"], "test")
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

    def test_hosted_readiness_requires_exact_database_head(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            validate_runtime_configuration=lambda: None,
        )
        with (
            patch("app.api.v1.endpoints.health.get_settings", return_value=settings),
            patch(
                "app.api.v1.endpoints.health.assert_hosted_release_schema_ready_cached",
                side_effect=RuntimeError("schema 84 and private provider detail"),
            ),
        ):
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Runtime configuration is not ready.")
        self.assertNotIn("schema 84", response.text)

    def test_hosted_readiness_accepts_only_successful_database_preflight(self):
        settings = SimpleNamespace(
            ENVIRONMENT="staging",
            validate_runtime_configuration=lambda: None,
        )
        with (
            patch("app.api.v1.endpoints.health.get_settings", return_value=settings),
            patch(
                "app.api.v1.endpoints.health.assert_hosted_release_schema_ready_cached"
            ) as preflight,
            patch(
                "app.api.v1.endpoints.health.process_rss_observability.observe_process_rss"
            ) as rss_observer,
        ):
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 200)
        preflight.assert_called_once_with()
        rss_observer.assert_called_once_with()

    def test_readiness_aliases_share_the_private_observer_without_public_fields(self):
        settings = SimpleNamespace(
            ENVIRONMENT="staging",
            STRIPE_MODE="test",
            STRIPE_SECRET_KEY="sk_test_private",
            validate_runtime_configuration=lambda: None,
        )
        with (
            patch("app.api.v1.endpoints.health.get_settings", return_value=settings),
            patch("app.api.v1.endpoints.health.assert_hosted_release_schema_ready_cached"),
            patch(
                "app.api.v1.endpoints.health.process_rss_observability.observe_process_rss"
            ) as rss_observer,
        ):
            for path in ("/health/ready", "/api/v1/health/ready"):
                for method in (self.client.get, self.client.head):
                    with self.subTest(path=path, method=method.__name__):
                        response = method(path)
                        self.assertEqual(response.status_code, 200)
                        self.assertNotIn("rss_bytes", response.text)
                        self.assertNotIn("threshold_state", response.text)
                        self.assertNotIn("process_id", response.text)

        self.assertEqual(rss_observer.call_count, 4)

    def test_observer_failure_does_not_change_readiness_result(self):
        settings = SimpleNamespace(
            ENVIRONMENT="staging",
            STRIPE_MODE="test",
            STRIPE_SECRET_KEY="sk_test_private",
            validate_runtime_configuration=lambda: None,
        )
        with (
            patch("app.api.v1.endpoints.health.get_settings", return_value=settings),
            patch("app.api.v1.endpoints.health.assert_hosted_release_schema_ready_cached"),
            patch(
                "app.api.v1.endpoints.health.process_rss_observability.observe_process_rss",
                side_effect=RuntimeError("observer internal detail"),
            ),
        ):
            response = self.client.get("/api/v1/health/ready")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertNotIn("observer internal detail", response.text)

    def test_readiness_reports_only_the_sanitized_configured_stripe_mode(self):
        stripe_secret_key = "sk_test_not_a_real_provider_credential"
        settings = SimpleNamespace(
            ENVIRONMENT="staging",
            STRIPE_MODE="test",
            STRIPE_SECRET_KEY=stripe_secret_key,
            validate_runtime_configuration=lambda: None,
        )
        with (
            patch("app.api.v1.endpoints.health.get_settings", return_value=settings),
            patch("app.api.v1.endpoints.health.assert_hosted_release_schema_ready_cached"),
        ):
            for path in ("/health/ready", "/api/v1/health/ready"):
                with self.subTest(path=path):
                    response = self.client.get(path)

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["configured_stripe_mode"], "test")
                    self.assertNotIn(stripe_secret_key, response.text)


if __name__ == "__main__":
    unittest.main()
