import unittest
import base64
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from threading import Event, Lock
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException
import jwt
from jwt import InvalidTokenError as JWTError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

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


def _make_rs256_token(*, kid: str = "test-rsa-key", payload_overrides=None):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_numbers = private_key.public_key().public_numbers()
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_jwk = {
        "kty": "RSA",
        "n": _base64url_uint(
            public_numbers.n,
            (public_numbers.n.bit_length() + 7) // 8,
        ),
        "e": _base64url_uint(
            public_numbers.e,
            (public_numbers.e.bit_length() + 7) // 8,
        ),
        "kid": kid,
        "alg": "RS256",
        "use": "sig",
        "key_ops": ["verify"],
    }
    token = jwt.encode(
        _make_supabase_payload(**(payload_overrides or {})),
        private_pem,
        algorithm="RS256",
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
            SUPABASE_ALLOW_LEGACY_HS256=True,
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
        self.assertEqual(
            decode.call_args.kwargs["options"]["require"],
            ["aud", "exp", "iat", "iss", "sub"],
        )
        self.assertTrue(decode.call_args.kwargs["options"]["verify_aud"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_exp"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_iat"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_iss"])
        self.assertTrue(decode.call_args.kwargs["options"]["verify_signature"])

    def test_hs256_validation_accepts_a_complete_supabase_token(self):
        jwt_secret = "test-jwt-secret-with-at-least-thirty-two-bytes"
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET=jwt_secret,
            SUPABASE_ALLOW_LEGACY_HS256=True,
        )
        token = jwt.encode(
            _make_supabase_payload(),
            jwt_secret,
            algorithm="HS256",
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ):
            self.assertEqual(get_user_id_from_token(token), "user_1")

    def test_hs256_validation_is_disabled_by_default_in_production(self):
        jwt_secret = "test-jwt-secret-with-at-least-thirty-two-bytes"
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET=jwt_secret,
        )
        token = jwt.encode(
            _make_supabase_payload(),
            jwt_secret,
            algorithm="HS256",
        )

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ):
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        self.assertEqual(context.exception.detail, "Invalid authentication token")

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

    def test_rs256_validation_uses_supabase_jwks(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co/",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_rs256_token()

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

    def test_es256_unknown_kid_does_not_immediately_refetch_jwks(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, _ = _make_es256_token(kid="new-key")
        _, old_jwk = _make_es256_keypair(kid="old-key")

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [old_jwk]}),
        ) as fetch_jwks:
            with self.assertRaises(HTTPException) as context:
                get_user_id_from_token(token)

        self.assertEqual(context.exception.status_code, 401)
        fetch_jwks.assert_called_once()

    def test_es256_unknown_kids_share_forced_refresh_throttle(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        first_token, _ = _make_es256_token(kid="unknown-one")
        second_token, _ = _make_es256_token(kid="unknown-two")
        _, old_jwk = _make_es256_keypair(kid="old-key")

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            return_value=FakeResponse({"keys": [old_jwk]}),
        ) as fetch_jwks:
            for token in (first_token, second_token):
                with self.assertRaises(HTTPException):
                    get_user_id_from_token(token)

        fetch_jwks.assert_called_once()

    def test_es256_rotation_refreshes_after_the_cooldown(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        old_token, old_jwk = _make_es256_token(kid="old-key")
        new_token, new_jwk = _make_es256_token(kid="new-key")

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS",
            0,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=[
                FakeResponse({"keys": [old_jwk]}),
                FakeResponse({"keys": [new_jwk]}),
            ],
        ) as fetch_jwks:
            self.assertEqual(get_user_id_from_token(old_token), "user_1")
            self.assertEqual(get_user_id_from_token(new_token), "user_1")

        self.assertEqual(fetch_jwks.call_count, 2)

    def test_jwks_failure_is_throttled_for_expired_or_cold_cache(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, _ = _make_es256_token()

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=RuntimeError("provider unavailable"),
        ) as fetch_jwks:
            for _ in range(2):
                with self.assertRaises(HTTPException) as context:
                    get_user_id_from_token(token)
                self.assertEqual(context.exception.status_code, 503)
                self.assertEqual(context.exception.headers, {"Retry-After": "30"})

        fetch_jwks.assert_called_once()

    def test_cached_known_key_does_not_block_during_unknown_key_refresh(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        known_token, known_jwk = _make_es256_token(kid="known-key")
        unknown_token, _ = _make_es256_token(kid="unknown-key")
        refresh_started = Event()
        release_refresh = Event()
        call_lock = Lock()
        call_count = 0

        def fetch_jwks(_url, *, timeout):
            nonlocal call_count
            self.assertEqual(timeout, 2.0)
            with call_lock:
                call_count += 1
                current_call = call_count
            if current_call == 1:
                return FakeResponse({"keys": [known_jwk]})
            refresh_started.set()
            self.assertTrue(release_refresh.wait(timeout=2))
            return FakeResponse({"keys": [known_jwk]})

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS",
            0,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=fetch_jwks,
        ):
            self.assertEqual(get_user_id_from_token(known_token), "user_1")
            with ThreadPoolExecutor(max_workers=2) as executor:
                unknown_future = executor.submit(
                    get_user_id_from_token,
                    unknown_token,
                )
                self.assertTrue(refresh_started.wait(timeout=1))
                known_future = executor.submit(
                    get_user_id_from_token,
                    known_token,
                )
                try:
                    self.assertEqual(known_future.result(timeout=0.2), "user_1")
                except FutureTimeoutError:
                    self.fail("cached known-key verification blocked behind JWKS refresh")
                finally:
                    release_refresh.set()
                with self.assertRaises(HTTPException):
                    unknown_future.result(timeout=1)

        self.assertEqual(call_count, 2)

    def test_concurrent_cold_valid_follower_gets_retryable_unavailable(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        token, public_jwk = _make_es256_token()
        refresh_started = Event()
        release_refresh = Event()

        def fetch_jwks(_url, *, timeout):
            self.assertEqual(timeout, 2.0)
            refresh_started.set()
            self.assertTrue(release_refresh.wait(timeout=2))
            return FakeResponse({"keys": [public_jwk]})

        with patch(
            "app.core.security.get_settings",
            return_value=settings,
        ), patch(
            "app.core.security.httpx.get",
            side_effect=fetch_jwks,
        ) as fetch:
            with ThreadPoolExecutor(max_workers=2) as executor:
                leader = executor.submit(get_user_id_from_token, token)
                self.assertTrue(refresh_started.wait(timeout=1))
                follower = executor.submit(get_user_id_from_token, token)
                with self.assertRaises(HTTPException) as context:
                    follower.result(timeout=0.5)
                self.assertEqual(context.exception.status_code, 503)
                self.assertEqual(context.exception.headers, {"Retry-After": "30"})
                release_refresh.set()
                self.assertEqual(leader.result(timeout=1), "user_1")

        fetch.assert_called_once()

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

        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(
            context.exception.detail,
            "Authentication keys are temporarily unavailable",
        )
        self.assertEqual(context.exception.headers, {"Retry-After": "30"})
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

        self.assertEqual(context.exception.status_code, 503)
        self.assertEqual(
            context.exception.detail,
            "Authentication keys are temporarily unavailable",
        )
        self.assertEqual(context.exception.headers, {"Retry-After": "30"})
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

    def test_asymmetric_validation_rejects_malformed_matching_jwk_as_invalid_token(self):
        settings = SimpleNamespace(
            ENVIRONMENT="production",
            SUPABASE_URL="https://project-ref.supabase.co",
            SUPABASE_JWT_SECRET="jwt-secret",
        )
        cases = [
            (
                "RS256",
                {
                    "kid": "malformed-key",
                    "alg": "RS256",
                    "kty": "RSA",
                    "n": "AQ",
                    "e": "AQAB",
                    "use": "sig",
                },
            ),
            (
                "ES256",
                {
                    "kid": "malformed-key",
                    "alg": "ES256",
                    "kty": "EC",
                    "crv": "P-256",
                    "x": "AQ",
                    "y": "AQ",
                    "use": "sig",
                },
            ),
        ]

        for algorithm, malformed_jwk in cases:
            with self.subTest(algorithm=algorithm):
                _clear_jwks_cache_for_tests()
                token = ".".join(
                    [
                        _encode_segment(
                            f'{{"typ":"JWT","alg":"{algorithm}","kid":"malformed-key"}}'
                        ),
                        _encode_segment('{"sub":"user_1"}'),
                        _encode_segment("signature"),
                    ]
                )
                with patch(
                    "app.core.security.get_settings",
                    return_value=settings,
                ), patch(
                    "app.core.security.httpx.get",
                    return_value=FakeResponse({"keys": [malformed_jwk]}),
                ):
                    with self.assertRaises(HTTPException) as context:
                        get_user_id_from_token(token)

                self.assertEqual(context.exception.status_code, 401)
                self.assertEqual(
                    context.exception.detail,
                    "Invalid authentication token",
                )

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
            SUPABASE_ALLOW_LEGACY_HS256=True,
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
