import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from jose import JWTError

from app.core.security import get_user_id_from_token


class SecurityTokenTest(unittest.TestCase):
    def test_invalid_token_response_does_not_expose_underlying_errors(self):
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=lambda _token: (_ for _ in ()).throw(
                    RuntimeError("provider config leaked: service-role-key")
                )
            )
        )

        with patch(
            "app.core.security.jwt.decode",
            side_effect=JWTError("jwt secret leaked"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token("bad-token")

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        self.assertNotIn("provider config leaked", context.exception.detail)
        self.assertNotIn("jwt secret leaked", context.exception.detail)

    def test_fallback_auth_success_returns_user_id(self):
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=lambda _token: SimpleNamespace(user=SimpleNamespace(id="user_1"))
            )
        )

        with patch(
            "app.core.security.jwt.decode",
            side_effect=JWTError("local secret mismatch"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            self.assertEqual(get_user_id_from_token("remote-valid-token"), "user_1")


if __name__ == "__main__":
    unittest.main()
