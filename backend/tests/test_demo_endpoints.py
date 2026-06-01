import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.api.v1.endpoints import demo


class DemoEndpointsTest(unittest.TestCase):
    def test_demo_capabilities_reflect_disabled_environment(self):
        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(DEMO_RESET_ENABLED=False),
        ):
            result = asyncio.run(demo.get_demo_capabilities(user_id="user-1"))

        self.assertEqual(result, {"enabled": False})

    def test_demo_reset_rejects_when_environment_guard_is_disabled(self):
        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(DEMO_RESET_ENABLED=False),
        ), self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                demo.reset_demo_studio(
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=object(),
                )
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, "Demo data tools are disabled in this environment.")

    def test_demo_reset_requires_destructive_confirmation_header(self):
        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(DEMO_RESET_ENABLED=True),
        ), patch(
            "app.api.v1.endpoints.demo.resolve_staff_role_for_user",
        ) as resolve_staff, self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                demo.reset_demo_studio(
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=object(),
                )
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn(demo.DEMO_RESET_DESTRUCTIVE_ACTION, ctx.exception.detail)
        resolve_staff.assert_not_called()

    def test_demo_reset_uses_resolved_membership_studio_for_service_call(self):
        service = SimpleNamespace(reset_demo_studio=AsyncMock(return_value="reset-ok"))

        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(
                DEMO_RESET_ENABLED=True,
                DEMO_RESET_STUDIO_IDS="resolved-studio",
            ),
        ), patch(
            "app.api.v1.endpoints.demo.resolve_staff_role_for_user",
            return_value={"studio_id": "resolved-studio", "role": "admin"},
        ), patch(
            "app.api.v1.endpoints.demo.DemoService",
            return_value=service,
        ):
            result = asyncio.run(
                demo.reset_demo_studio(
                    user_id="user-1",
                    requested_studio_id="requested-studio",
                    destructive_action=demo.DEMO_RESET_DESTRUCTIVE_ACTION,
                    supabase=object(),
                )
            )

        self.assertEqual(result, "reset-ok")
        service.reset_demo_studio.assert_awaited_once_with("resolved-studio", "user-1")

    def test_demo_reset_rejects_admin_studio_not_in_demo_allowlist(self):
        service = SimpleNamespace(reset_demo_studio=AsyncMock(return_value="reset-ok"))

        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(
                DEMO_RESET_ENABLED=True,
                DEMO_RESET_STUDIO_IDS="demo-studio",
            ),
        ), patch(
            "app.api.v1.endpoints.demo.resolve_staff_role_for_user",
            return_value={"studio_id": "real-studio", "role": "admin"},
        ), patch(
            "app.api.v1.endpoints.demo.DemoService",
            return_value=service,
        ), self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                demo.reset_demo_studio(
                    user_id="user-1",
                    requested_studio_id="real-studio",
                    destructive_action=demo.DEMO_RESET_DESTRUCTIVE_ACTION,
                    supabase=object(),
                )
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("explicitly configured demo studios", ctx.exception.detail)
        service.reset_demo_studio.assert_not_called()

    def test_clear_studio_data_uses_resolved_membership_studio_for_service_call(self):
        service = SimpleNamespace(clear_studio_data=AsyncMock(return_value="clear-ok"))

        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(
                DEMO_RESET_ENABLED=True,
                DEMO_RESET_STUDIO_IDS="resolved-studio",
            ),
        ), patch(
            "app.api.v1.endpoints.demo.resolve_staff_role_for_user",
            return_value={"studio_id": "resolved-studio", "role": "admin"},
        ), patch(
            "app.api.v1.endpoints.demo.DemoService",
            return_value=service,
        ):
            result = asyncio.run(
                demo.clear_studio_data(
                    user_id="user-1",
                    requested_studio_id="requested-studio",
                    destructive_action=demo.CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION,
                    supabase=object(),
                )
            )

        self.assertEqual(result, "clear-ok")
        service.clear_studio_data.assert_awaited_once_with("resolved-studio")

    def test_clear_studio_data_requires_destructive_confirmation_header(self):
        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(DEMO_RESET_ENABLED=True),
        ), patch(
            "app.api.v1.endpoints.demo.resolve_staff_role_for_user",
        ) as resolve_staff, self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                demo.clear_studio_data(
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=object(),
                )
            )

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn(demo.CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION, ctx.exception.detail)
        resolve_staff.assert_not_called()

    def test_clear_studio_data_rejects_when_environment_guard_is_disabled(self):
        with patch(
            "app.api.v1.endpoints.demo.get_settings",
            return_value=SimpleNamespace(DEMO_RESET_ENABLED=False),
        ), self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                demo.clear_studio_data(
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=object(),
                )
            )

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.detail, "Demo data tools are disabled in this environment.")


if __name__ == "__main__":
    unittest.main()
