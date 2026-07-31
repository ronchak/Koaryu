import asyncio
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from app.api.v1.endpoints import health
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

        with patch(
            "app.api.v1.endpoints.health._probe_required_supabase_path",
            new=AsyncMock(),
        ):
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

    def test_readiness_checks_bounded_read_only_supabase_path(self):
        client = MagicMock()
        query = client.table.return_value.select.return_value.limit.return_value

        with patch(
            "app.api.v1.endpoints.health.create_supabase_readiness_client",
            return_value=client,
        ) as create_client:
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        create_client.assert_called_once_with(
            timeout_seconds=health.SUPABASE_REQUEST_TIMEOUT_SECONDS
        )
        client.table.assert_called_once_with("studios")
        client.table.return_value.select.assert_called_once_with("id")
        client.table.return_value.select.return_value.limit.assert_called_once_with(1)
        query.execute.assert_called_once_with()
        client.postgrest.session.close.assert_called_once_with()

    def test_readiness_runs_synchronous_supabase_probe_off_event_loop(self):
        loop_thread_id = None
        probe_thread_ids: list[int] = []

        def record_probe_thread():
            probe_thread_ids.append(threading.get_ident())

        async def run_probe():
            nonlocal loop_thread_id
            loop_thread_id = threading.get_ident()
            with patch(
                "app.api.v1.endpoints.health._probe_required_supabase_path_sync",
                side_effect=record_probe_thread,
            ):
                await health._probe_required_supabase_path()

        asyncio.run(run_probe())

        self.assertEqual(len(probe_thread_ids), 1)
        self.assertNotEqual(probe_thread_ids[0], loop_thread_id)

    def test_readiness_dependency_failure_is_sanitized_and_liveness_stays_up(self):
        client = MagicMock()
        client.table.return_value.select.return_value.limit.return_value.execute.side_effect = (
            ConnectionError("provider URL and credential details")
        )

        with patch(
            "app.api.v1.endpoints.health.create_supabase_readiness_client",
            return_value=client,
        ) as create_client:
            ready_response = self.client.get("/health/ready")
            health_response = self.client.get("/health")
            live_response = self.client.get("/health/live")

        self.assertEqual(ready_response.status_code, 503)
        self.assertEqual(ready_response.json()["detail"], "Service is not ready.")
        self.assertEqual(
            ready_response.headers["cache-control"], "no-store, max-age=0"
        )
        self.assertNotIn("provider URL", ready_response.text)
        self.assertEqual(health_response.status_code, 200)
        self.assertEqual(health_response.json()["status"], "ok")
        self.assertEqual(live_response.status_code, 200)
        self.assertEqual(live_response.json()["status"], "ok")
        create_client.assert_called_once()
        client.postgrest.session.close.assert_called_once_with()

    def test_readiness_timeout_is_sanitized(self):
        async def blocked_probe():
            await asyncio.Event().wait()

        with (
            patch(
                "app.api.v1.endpoints.health.asyncio.to_thread",
                new=lambda *_args: blocked_probe(),
            ),
            patch(
                "app.api.v1.endpoints.health.READINESS_CHECK_TIMEOUT_SECONDS",
                0.01,
            ),
        ):
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Service is not ready.")
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")

    def test_invalid_runtime_configuration_skips_dependency_probe(self):
        class InvalidSettings(SimpleNamespace):
            def validate_runtime_configuration(self):
                raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY contains a provider secret")

        invalid_settings = InvalidSettings(ENVIRONMENT="staging")
        with (
            patch(
                "app.api.v1.endpoints.health.get_settings",
                return_value=invalid_settings,
            ),
            patch(
                "app.api.v1.endpoints.health._probe_required_supabase_path",
                new=AsyncMock(),
            ) as probe,
        ):
            response = self.client.get("/health/ready")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Service is not ready.")
        self.assertEqual(response.headers["cache-control"], "no-store, max-age=0")
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", response.text)
        probe.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
