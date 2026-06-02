import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException
from jose import JWTError

from app.core.security import get_user_id_from_token


class SecurityTokenTest(unittest.TestCase):
    def test_local_validation_requires_supabase_access_token_claims(self):
        settings = SimpleNamespace(
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET="jwt-secret",
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.jwt.decode",
            return_value={"sub": "user_1", "role": "authenticated"},
        ) as decode:
            self.assertEqual(get_user_id_from_token("local-valid-token"), "user_1")

        decode.assert_called_once()
        self.assertEqual(decode.call_args.kwargs["audience"], "authenticated")
        self.assertEqual(
            decode.call_args.kwargs["issuer"],
            "https://project-ref.supabase.co/auth/v1",
        )
        self.assertTrue(decode.call_args.kwargs["options"]["require_aud"])
        self.assertTrue(decode.call_args.kwargs["options"]["require_exp"])
        self.assertTrue(decode.call_args.kwargs["options"]["require_iat"])
        self.assertTrue(decode.call_args.kwargs["options"]["require_iss"])
        self.assertTrue(decode.call_args.kwargs["options"]["require_sub"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_aud"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_exp"])

    def test_local_validation_rejects_unexpected_role_claim(self):
        settings = SimpleNamespace(
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.jwt.decode",
            return_value={"sub": "user_1", "role": "service_role"},
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token("wrong-role-token")

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

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
