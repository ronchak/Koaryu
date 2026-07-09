import unittest
import base64
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException
from jose import JWTError
from jose import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.core.security import _clear_jwks_cache_for_tests, get_user_id_from_token


class FakeResponse:
    def __init__(self, body, *, status_error=None):
        self.body = body
        self.status_error = status_error

    def raise_for_status(self):
        if self.status_error:
            raise self.status_error

    def json(self):
        return self.body


def _base64url_uint(value: int, byte_length: int = 32) -> str:
    raw = value.to_bytes(byte_length, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _make_es256_keypair(*, kid: str = "test-key"):
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": _base64url_uint(public_numbers.x),
        "y": _base64url_uint(public_numbers.y),
        "kid": kid,
        "alg": "ES256",
        "use": "sig",
        "key_ops": ["verify"],
    }
    return private_pem, public_jwk


def _make_supabase_payload(**overrides):
    now = int(time.time())
    payload = {
        "sub": "user_1",
        "role": "authenticated",
        "aud": "authenticated",
        "iss": "https://project-ref.supabase.co/auth/v1",
        "iat": now,
        "exp": now + 300,
    }
    payload.update(overrides)
    return payload


def _make_es256_token(*, kid: str = "test-key", payload_overrides=None):
    private_pem, public_jwk = _make_es256_keypair(kid=kid)
    token = jwt.encode(
        _make_supabase_payload(**(payload_overrides or {})),
        private_pem,
        algorithm="ES256",
        headers={"kid": kid},
    )
    return token, public_jwk


def _encode_segment(value) -> str:
    raw = str(value).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class SecurityTokenTest(unittest.TestCase):
    def setUp(self):
        _clear_jwks_cache_for_tests()

    def tearDown(self):
        _clear_jwks_cache_for_tests()

    def test_local_validation_requires_supabase_access_token_claims(self):
        settings = SimpleNamespace(
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET="jwt-secret",
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.jwt.get_unverified_header",
            return_value={"alg": "HS256"},
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

    def test_es256_validation_uses_supabase_jwks(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token()

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [public_jwk]}),
        ) as fetch_jwks:
            self.assertEqual(get_user_id_from_token(token), "user_1")

        fetch_jwks.assert_called_once_with(
            "https://project-ref.supabase.co/auth/v1/.well-known/jwks.json",
            timeout=2.0,
        )

    def test_es256_validation_uses_cached_jwks(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token()

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [public_jwk]}),
        ) as fetch_jwks:
            self.assertEqual(get_user_id_from_token(token), "user_1")
            self.assertEqual(get_user_id_from_token(token), "user_1")

        fetch_jwks.assert_called_once()

    def test_es256_validation_refreshes_jwks_once_for_missing_kid(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token(kid="new-key")
        _, old_jwk = _make_es256_keypair(kid="old-key")

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=[
                FakeResponse({"keys": [old_jwk]}),
                FakeResponse({"keys": [public_jwk]}),
            ],
        ) as fetch_jwks:
            self.assertEqual(get_user_id_from_token(token), "user_1")

        self.assertEqual(fetch_jwks.call_count, 2)

    def test_es256_validation_rejects_missing_kid_without_remote_fallback_in_production(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        private_pem, _public_jwk = _make_es256_keypair(kid="test-key")
        token = jwt.encode(
            _make_supabase_payload(),
            private_pem,
            algorithm="ES256",
            headers={"kid": ""},
        )
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

    def test_es256_validation_rejects_missing_jwks_key_after_refresh_without_remote_fallback(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, _public_jwk = _make_es256_token(kid="new-key")
        _, old_jwk = _make_es256_keypair(kid="old-key")
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=[
                FakeResponse({"keys": [old_jwk]}),
                FakeResponse({"keys": [old_jwk]}),
            ],
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

    def test_es256_validation_rejects_jwks_fetch_failure_without_remote_fallback(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, _public_jwk = _make_es256_token()
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=RuntimeError("provider config leaked"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

    def test_mixed_case_production_rejects_jwks_failure_without_remote_fallback(self):
        settings = SimpleNamespace(
            ENVIRONMENT="Production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, _public_jwk = _make_es256_token()
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=RuntimeError("provider config leaked"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

    def test_es256_validation_rejects_mismatched_jwk_metadata(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token()
        public_jwk["alg"] = "RS256"

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [public_jwk]}),
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")

    def test_es256_validation_rejects_wrong_audience_and_issuer(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        cases = [
            {"aud": "anon"},
            {"iss": "https://other-project.supabase.co/auth/v1"},
        ]

        for overrides in cases:
            with self.subTest(overrides=overrides):
                _clear_jwks_cache_for_tests()
                token, public_jwk = _make_es256_token(payload_overrides=overrides)
                with patch(
                    "app.core.security.get_settings",
                    return_value=settings,
                ), patch(
                    "app.core.security.httpx.get",
                    return_value=FakeResponse({"keys": [public_jwk]}),
                ):
                    with self.assertRaises(HTTPException) as context:
                        get_user_id_from_token(token)

                self.assertEqual(context.exception.status_code, 401)
                self.assertEqual(context.exception.detail, "Invalid authentication token")

    def test_es256_validation_rejects_expired_token(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token(
            payload_overrides={"exp": int(time.time()) - 60}
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [public_jwk]}),
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Authentication token has expired")

    def test_unsupported_algorithm_is_rejected_without_remote_fallback_in_production(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token = jwt.encode(
            _make_supabase_payload(),
            "jwt-secret",
            algorithm="HS512",
        )
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

    def test_missing_algorithm_is_rejected_without_remote_fallback_in_production(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token = ".".join(
            [
                _encode_segment('{"typ":"JWT"}'),
                _encode_segment('{"sub":"user_1"}'),
                _encode_segment("signature"),
            ]
        )
        fallback_get_user = Mock(side_effect=AssertionError("fallback should not run"))
        fallback_client = SimpleNamespace(
            auth=SimpleNamespace(get_user=fallback_get_user)
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()

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
            "app.core.security.jwt.get_unverified_header",
            return_value={"alg": "HS256"},
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
            "app.core.security.jwt.get_unverified_header",
            return_value={"alg": "HS256"},
        ), patch(
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
            "app.core.security.jwt.get_unverified_header",
            return_value={"alg": "HS256"},
        ), patch(
            "app.core.security.jwt.decode",
            side_effect=JWTError("local secret mismatch"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            self.assertEqual(get_user_id_from_token("remote-valid-token"), "user_1")

    def test_production_jwt_validation_error_does_not_use_remote_fallback(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
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
            "app.core.security.jwt.get_unverified_header",
            return_value={"alg": "HS256"},
        ), patch(
            "app.core.security.jwt.decode",
            side_effect=JWTError("local secret mismatch"),
        ), patch(
            "app.core.security.get_supabase_client",
            return_value=fallback_client,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token("bad-token")

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")
        fallback_get_user.assert_not_called()


if __name__ == "__main__":
    unittest.main()
