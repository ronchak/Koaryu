import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.core.deps import ACTIVE_STUDIO_COOKIE, get_current_user_id, get_requested_studio_id, security


class AuthDependencyTest(unittest.TestCase):
    def test_bearer_dependency_defers_missing_credentials_to_app_handler(self):
        self.assertFalse(security.auto_error)

    def test_missing_credentials_returns_explicit_401(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(get_current_user_id(None))

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        self.assertEqual(context.exception.headers, {"WWW-Authenticate": "Bearer"})

    def test_invalid_credentials_use_same_401_status_path(self):
        with patch(
            "app.core.deps.get_user_id_from_token",
            side_effect=HTTPException(
                status_code=401,
                detail="Invalid authentication token",
                headers={"WWW-Authenticate": "Bearer"},
            ),
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(get_current_user_id(SimpleNamespace(credentials="bad-token")))

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        self.assertEqual(context.exception.headers, {"WWW-Authenticate": "Bearer"})

    def test_requested_studio_header_is_trimmed_selector(self):
        request = SimpleNamespace(cookies={ACTIVE_STUDIO_COOKIE: "cookie-studio"})

        studio_id = asyncio.run(get_requested_studio_id(request, "  header-studio  "))

        self.assertEqual(studio_id, "header-studio")

    def test_requested_studio_falls_back_to_cookie_selector(self):
        request = SimpleNamespace(cookies={ACTIVE_STUDIO_COOKIE: " cookie-studio "})

        studio_id = asyncio.run(get_requested_studio_id(request, None))

        self.assertEqual(studio_id, "cookie-studio")

    def test_blank_requested_studio_selector_is_ignored(self):
        request = SimpleNamespace(cookies={ACTIVE_STUDIO_COOKIE: "   "})

        studio_id = asyncio.run(get_requested_studio_id(request, " "))

        self.assertIsNone(studio_id)


if __name__ == "__main__":
    unittest.main()
