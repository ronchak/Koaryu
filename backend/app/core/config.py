from functools import lru_cache
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import secrets
from typing import Literal
from urllib.parse import urlparse
from urllib.request import getproxies

from pydantic_settings import BaseSettings


KOARYU_PRODUCTION_SUPABASE_REF = "mimguepumzsgmcaycdsh"
KOARYU_PRODUCTION_SUPABASE_URL = (
    f"https://{KOARYU_PRODUCTION_SUPABASE_REF}.supabase.co"
)
KOARYU_STAGING_SUPABASE_REF = "nxgsektqsgrtyfhawxbc"
KOARYU_STAGING_SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
KOARYU_STAGING_FRONTEND_URL = (
    "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app"
)
KOARYU_PRODUCTION_FRONTEND_URL = "https://koaryu.app"
PERMISSIVE_ENVIRONMENTS = {"development", "test"}
STRICT_ENVIRONMENTS = {"production", "staging"}
LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"
SHIPPED_PLACEHOLDER_SUPABASE_URLS = {
    "https://placeholder.supabase.co",
    "https://your-project.supabase.co",
}
HOSTED_SUPABASE_URL_PATTERN = re.compile(
    r"https://(?P<project_ref>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.supabase\.co",
    re.ASCII,
)
PROXY_ENVIRONMENT_KEYS = (
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
)
CA_BUNDLE_ENVIRONMENT_KEYS = (
    "REQUESTS_CA_BUNDLE",
    "requests_ca_bundle",
    "CURL_CA_BUNDLE",
    "curl_ca_bundle",
    "SSL_CERT_FILE",
    "ssl_cert_file",
    "SSL_CERT_DIR",
    "ssl_cert_dir",
)
AMBIENT_TRANSPORT_ENVIRONMENT_KEYS = (
    PROXY_ENVIRONMENT_KEYS + CA_BUNDLE_ENVIRONMENT_KEYS
)
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
HEADER_BOUND_CREDENTIAL_FIELDS = (
    "SUPABASE_SERVICE_ROLE_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_RESTRICTED_KEY",
    "ACCOUNT_DELETION_WORKER_SECRET",
    "OPERATIONAL_ALERT_WORKER_SECRET",
    "OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET",
    "OPERATIONAL_ALERT_PRIMARY_ACK_SECRET",
    "OPERATIONAL_ALERT_BACKUP_BEARER_SECRET",
    "OPERATIONAL_ALERT_BACKUP_ACK_SECRET",
    "SUPPORT_TRIAGE_SECRET",
)


PLACEHOLDER_MARKERS = (
    "placeholder",
    "your-",
    "your_",
    "_your",
    "example",
    "change-me",
    "changeme",
    "replace-me",
    "todo",
    "<",
    ">",
)

PLACEHOLDER_VALUES = {
    "delete-secret",
    "jwt-secret",
    "long-random-secret",
    "long-random-secret-for-support-ticket-triage",
    "long-random-secret-for-operational-alert-evaluation",
    "long-random-secret-for-the-deletion-cron",
    "long-random-secret-for-the-deletion-worker",
    "placeholder-key",
    "placeholder-secret",
    "price_core",
    "price_koaryu_core",
    "service-role-key",
    "sk_live_or_test_your_key",
    "support-secret",
    "whsec_connect",
    "whsec_connect_connected_scope",
    "whsec_connect_platform_scope",
    "whsec_platform",
}


def is_placeholder_value(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        not normalized
        or normalized in PLACEHOLDER_VALUES
        or any(marker in normalized for marker in PLACEHOLDER_MARKERS)
    )


def has_minimum_secret_length(value: str, minimum: int = 32) -> bool:
    return len(value.strip()) >= minimum


def validate_raw_header_value(name: str, value: str) -> None:
    """Reject header values that HTTP clients cannot safely transmit unchanged."""
    has_control = any(
        ord(character) < 32 or ord(character) == 127 for character in value
    )
    if value != value.strip() or has_control:
        raise RuntimeError(
            "Runtime configuration is incomplete or unsafe: "
            f"{name} must not contain surrounding whitespace or ASCII control "
            "characters"
        )


def validate_frontend_origin(url: str, environment: str) -> str:
    """Return one canonical frontend origin or fail without reflecting its value."""
    normalized_environment = environment.strip().lower()
    has_control = any(
        ord(character) < 32 or ord(character) == 127 for character in url
    )
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        raise RuntimeError(
            "Runtime configuration is incomplete or unsafe: FRONTEND_URL must be "
            "a canonical frontend origin"
        ) from None

    hostname = parsed.hostname or ""
    authority = hostname if port is None else f"{hostname}:{port}"
    canonical_origin = f"{parsed.scheme}://{authority}"
    invalid_structure = (
        not url
        or url != url.strip()
        or has_control
        or parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.netloc != authority
        or url != canonical_origin
        or bool(parsed.path)
        or bool(parsed.params)
        or bool(parsed.query)
        or bool(parsed.fragment)
    )
    if invalid_structure:
        raise RuntimeError(
            "Runtime configuration is incomplete or unsafe: FRONTEND_URL must be "
            "a canonical frontend origin"
        )

    if normalized_environment == "production":
        if url != KOARYU_PRODUCTION_FRONTEND_URL:
            raise RuntimeError(
                "Production configuration is incomplete or unsafe: FRONTEND_URL "
                "must match Koaryu's pinned production frontend"
            )
        return url
    if normalized_environment == "staging":
        if url != KOARYU_STAGING_FRONTEND_URL:
            raise RuntimeError(
                "Staging configuration is incomplete or unsafe: FRONTEND_URL "
                "must match Koaryu's pinned staging frontend"
            )
        return url
    if normalized_environment not in PERMISSIVE_ENVIRONMENTS:
        raise RuntimeError(
            "Runtime configuration is incomplete or unsafe: ENVIRONMENT must be "
            "development, test, staging, or production"
        )

    if parsed.scheme == "http":
        if hostname not in {"localhost", "127.0.0.1"} or port is None:
            raise RuntimeError(
                "Runtime configuration is incomplete or unsafe: FRONTEND_URL must "
                "use loopback HTTP or a canonical HTTPS origin"
            )
    elif port is not None:
        raise RuntimeError(
            "Runtime configuration is incomplete or unsafe: FRONTEND_URL must not "
            "use an explicit HTTPS port"
        )
    return url


def parse_stripe_webhook_secrets(name: str, value: str) -> list[str]:
    """Parse the canonical comma-separated webhook secret rotation format."""
    if not value:
        return []
    candidates = value.split(",")
    if any(not candidate for candidate in candidates):
        raise RuntimeError(
            f"Runtime configuration is incomplete or unsafe: {name} must contain "
            "nonempty comma-separated candidates"
        )
    for candidate in candidates:
        validate_raw_header_value(name, candidate)
    return candidates


class SupabaseSafetyError(RuntimeError):
    """Raised before a service-role client can use an unsafe target or transport."""


def validate_no_ambient_supabase_transport() -> None:
    """Refuse ambient proxy and CA overrides the pinned SDK cannot disable."""
    configured_keys = {
        key.upper()
        for key in AMBIENT_TRANSPORT_ENVIRONMENT_KEYS
        if os.environ.get(key, "").strip()
    }
    discovered_proxies = getproxies()
    if configured_keys or any(
        str(discovered_proxies.get(scheme, "")).strip()
        for scheme in ("http", "https", "all")
    ):
        names = ", ".join(sorted(configured_keys)) or "system HTTP proxy settings"
        raise SupabaseSafetyError(
            "Refusing unsafe Supabase service-role transport: ambient proxy or CA "
            f"configuration is active ({names}). Remove it for this process; "
            "NO_PROXY is not accepted as an exception."
        )


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    SUPABASE_URL: str = "https://placeholder.supabase.co"
    SUPABASE_DEVELOPMENT_PROJECT_REF: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = "placeholder-key"
    SUPABASE_JWT_SECRET: str = "placeholder-secret"
    SUPABASE_ALLOW_LEGACY_HS256: bool = False
    FRONTEND_URL: str = "http://localhost:4000"
    ENVIRONMENT: str = "development"
    DEMO_RESET_ENABLED: bool = False
    DEMO_RESET_STUDIO_IDS: str = ""
    STRIPE_MODE: Literal["test", "live"] = "test"
    LIVE_BILLING_ENABLED: bool = False
    CORE_SELF_CHECKOUT_ENABLED: bool = False
    STRIPE_SECRET_KEY: str = ""
    STRIPE_RESTRICTED_KEY: str = ""
    STRIPE_PLATFORM_WEBHOOK_SECRET: str = ""
    STRIPE_CONNECT_WEBHOOK_SECRET: str = ""
    STRIPE_KOARYU_CORE_PRICE_ID: str = ""
    BILLING_PLATFORM_FEE_BPS: int = 50
    ACCOUNT_DELETION_WORKER_SECRET: str = ""
    BILLING_TRANSITION_WORKER_SECRET: str = ""
    OPERATIONAL_ALERTS_ENABLED: bool = False
    OPERATIONAL_ALERT_WORKER_SECRET: str = ""
    OPERATIONAL_ALERT_PRIMARY_URL: str = ""
    OPERATIONAL_ALERT_PRIMARY_HOST: str = ""
    OPERATIONAL_ALERT_PRIMARY_URL_SHA256: str = ""
    OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET: str = ""
    OPERATIONAL_ALERT_PRIMARY_ACK_SECRET: str = ""
    OPERATIONAL_ALERT_BACKUP_URL: str = ""
    OPERATIONAL_ALERT_BACKUP_HOST: str = ""
    OPERATIONAL_ALERT_BACKUP_URL_SHA256: str = ""
    OPERATIONAL_ALERT_BACKUP_BEARER_SECRET: str = ""
    OPERATIONAL_ALERT_BACKUP_ACK_SECRET: str = ""
    SUPPORT_TRIAGE_SECRET: str = ""

    # API
    API_V1_PREFIX: str = "/api/v1"

    model_config = {
        "env_file": str(Path(__file__).resolve().parents[2] / ".env"),
        "case_sensitive": True,
        "extra": "ignore"
    }

    def validate_supabase_target(self) -> None:
        """Require an exact environment-to-project mapping before privileged use."""
        raw_url = self.SUPABASE_URL
        environment = self.ENVIRONMENT.strip().lower()
        environment_label = environment or "<empty>"

        if any(ord(character) < 32 or ord(character) == 127 for character in raw_url):
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: SUPABASE_URL contains an ASCII "
                "control character."
            )
        if environment not in PERMISSIVE_ENVIRONMENTS | STRICT_ENVIRONMENTS:
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: ENVIRONMENT must be development, "
                f"test, staging, or production; received {environment_label}."
            )

        if raw_url == LOCAL_SUPABASE_URL:
            if environment in PERMISSIVE_ENVIRONMENTS:
                return
            raise SupabaseSafetyError(
                f"Refusing unsafe Supabase target: ENVIRONMENT={environment} cannot "
                "use the local Supabase project."
            )

        hosted_match = HOSTED_SUPABASE_URL_PATTERN.fullmatch(raw_url)
        if hosted_match is None:
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: SUPABASE_URL must be the canonical "
                "https://<project-ref>.supabase.co URL with no credentials, port, "
                "path, query, fragment, whitespace, or trailing slash."
            )

        project_ref = hosted_match.group("project_ref")
        if environment == "production":
            if raw_url == KOARYU_PRODUCTION_SUPABASE_URL:
                return
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: ENVIRONMENT=production requires "
                "Koaryu's pinned production Supabase project."
            )
        if environment == "staging":
            if raw_url == KOARYU_STAGING_SUPABASE_URL:
                return
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: ENVIRONMENT=staging requires "
                "Koaryu's pinned staging Supabase project."
            )
        if raw_url in SHIPPED_PLACEHOLDER_SUPABASE_URLS:
            return
        if environment == "test":
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: ENVIRONMENT=test cannot use a real "
                "hosted Supabase project."
            )
        if project_ref in {
            KOARYU_PRODUCTION_SUPABASE_REF,
            KOARYU_STAGING_SUPABASE_REF,
        }:
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: ENVIRONMENT=development cannot use "
                "Koaryu's production or staging Supabase project."
            )
        expected_ref = self.SUPABASE_DEVELOPMENT_PROJECT_REF
        if project_ref != expected_ref:
            raise SupabaseSafetyError(
                "Refusing unsafe Supabase target: hosted development requires "
                "SUPABASE_DEVELOPMENT_PROJECT_REF to exactly match SUPABASE_URL."
            )

    def validate_supabase_service_role_configuration(self) -> None:
        validate_raw_header_value(
            "SUPABASE_SERVICE_ROLE_KEY", self.SUPABASE_SERVICE_ROLE_KEY
        )
        self.validate_supabase_target()
        validate_no_ambient_supabase_transport()

    def validated_frontend_origin(self) -> str:
        return validate_frontend_origin(self.FRONTEND_URL, self.ENVIRONMENT)

    def validate_runtime_configuration(self) -> None:
        """Fail closed when a hosted environment has incomplete or unsafe config."""
        environment = self.ENVIRONMENT.strip().lower()
        for name in HEADER_BOUND_CREDENTIAL_FIELDS:
            validate_raw_header_value(name, getattr(self, name, ""))
        platform_webhook_secrets = parse_stripe_webhook_secrets(
            "STRIPE_PLATFORM_WEBHOOK_SECRET",
            self.STRIPE_PLATFORM_WEBHOOK_SECRET,
        )
        connect_webhook_secrets = parse_stripe_webhook_secrets(
            "STRIPE_CONNECT_WEBHOOK_SECRET",
            self.STRIPE_CONNECT_WEBHOOK_SECRET,
        )
        self.validated_frontend_origin()
        self.validate_supabase_service_role_configuration()
        if self.CORE_SELF_CHECKOUT_ENABLED and environment != "production":
            raise RuntimeError(
                "Runtime configuration is incomplete or unsafe: "
                "CORE_SELF_CHECKOUT_ENABLED may only be true in production"
            )
        if environment in PERMISSIVE_ENVIRONMENTS:
            return
        if environment not in STRICT_ENVIRONMENTS:
            raise RuntimeError(
                "Runtime configuration is incomplete or unsafe: "
                "ENVIRONMENT must be development, test, staging, or production"
            )

        missing: list[str] = []
        required_values = {
            "SUPABASE_URL": self.SUPABASE_URL,
            "SUPABASE_SERVICE_ROLE_KEY": self.SUPABASE_SERVICE_ROLE_KEY,
            "FRONTEND_URL": self.FRONTEND_URL,
            "STRIPE_SECRET_KEY": self.STRIPE_SECRET_KEY,
            "STRIPE_PLATFORM_WEBHOOK_SECRET": self.STRIPE_PLATFORM_WEBHOOK_SECRET,
            "STRIPE_CONNECT_WEBHOOK_SECRET": self.STRIPE_CONNECT_WEBHOOK_SECRET,
            "STRIPE_KOARYU_CORE_PRICE_ID": self.STRIPE_KOARYU_CORE_PRICE_ID,
            "ACCOUNT_DELETION_WORKER_SECRET": self.ACCOUNT_DELETION_WORKER_SECRET,
            "BILLING_TRANSITION_WORKER_SECRET": self.BILLING_TRANSITION_WORKER_SECRET,
            "SUPPORT_TRIAGE_SECRET": self.SUPPORT_TRIAGE_SECRET,
        }
        optional_values = {
            "STRIPE_RESTRICTED_KEY": self.STRIPE_RESTRICTED_KEY,
        }

        for name, value in required_values.items():
            normalized = value.strip() if isinstance(value, str) else value
            if not normalized or is_placeholder_value(normalized):
                missing.append(name)

        for name, value in optional_values.items():
            normalized = value.strip() if isinstance(value, str) else value
            if normalized and is_placeholder_value(normalized):
                missing.append(name)

        if self.DEMO_RESET_ENABLED:
            missing.append(f"DEMO_RESET_ENABLED must be false in {environment}")
        if self.DEMO_RESET_STUDIO_IDS.strip():
            missing.append(f"DEMO_RESET_STUDIO_IDS must be empty in {environment}")
        if self.API_V1_PREFIX != "/api/v1":
            missing.append("API_V1_PREFIX must be /api/v1")

        supabase = urlparse(self.SUPABASE_URL)
        if supabase.scheme != "https" or not supabase.netloc or supabase.hostname in {"localhost", "127.0.0.1"}:
            missing.append("SUPABASE_URL must be a public HTTPS URL")

        if not has_minimum_secret_length(self.SUPABASE_SERVICE_ROLE_KEY):
            missing.append("SUPABASE_SERVICE_ROLE_KEY must be a real secret value")

        if environment == "staging" and self.SUPABASE_ALLOW_LEGACY_HS256:
            missing.append("SUPABASE_ALLOW_LEGACY_HS256 must be false in staging")
        elif self.SUPABASE_ALLOW_LEGACY_HS256:
            if is_placeholder_value(self.SUPABASE_JWT_SECRET) or not has_minimum_secret_length(
                self.SUPABASE_JWT_SECRET
            ):
                missing.append(
                    "SUPABASE_JWT_SECRET must be a real secret value when "
                    "SUPABASE_ALLOW_LEGACY_HS256 is enabled"
                )

        stripe_secret_prefixes = ("sk_test_",) if environment == "staging" else ("sk_live_",)
        if not self.STRIPE_SECRET_KEY.startswith(stripe_secret_prefixes) or not has_minimum_secret_length(
            self.STRIPE_SECRET_KEY, 16
        ):
            if environment == "staging":
                missing.append("STRIPE_SECRET_KEY must be a Stripe test secret key in staging")
            else:
                missing.append("STRIPE_SECRET_KEY must be a Stripe live secret key in production")
        elif not self.STRIPE_SECRET_KEY.startswith(f"sk_{self.STRIPE_MODE}_"):
            missing.append("STRIPE_SECRET_KEY must match STRIPE_MODE")

        restricted_key = self.STRIPE_RESTRICTED_KEY.strip()
        restricted_key_prefixes = ("rk_test_",) if environment == "staging" else ("rk_live_",)
        if restricted_key and (
            not restricted_key.startswith(restricted_key_prefixes)
            or not has_minimum_secret_length(restricted_key, 16)
        ):
            if environment == "staging":
                missing.append(
                    "STRIPE_RESTRICTED_KEY must be a Stripe test restricted key "
                    "in staging when set"
                )
            else:
                missing.append(
                    "STRIPE_RESTRICTED_KEY must be a Stripe live restricted key in production when set"
                )
        elif restricted_key and not restricted_key.startswith(f"rk_{self.STRIPE_MODE}_"):
            missing.append("STRIPE_RESTRICTED_KEY must match STRIPE_MODE when set")

        if self.LIVE_BILLING_ENABLED:
            deployment_sha = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
            if environment != "production":
                missing.append("LIVE_BILLING_ENABLED may only be true in production")
            if not COMMIT_SHA_PATTERN.fullmatch(deployment_sha):
                missing.append(
                    "RENDER_GIT_COMMIT must contain the exact deployed candidate when live billing is enabled"
                )

        if self.CORE_SELF_CHECKOUT_ENABLED:
            deployment_sha = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
            if environment != "production":
                missing.append("CORE_SELF_CHECKOUT_ENABLED may only be true in production")
            if not COMMIT_SHA_PATTERN.fullmatch(deployment_sha):
                missing.append(
                    "RENDER_GIT_COMMIT must contain the exact deployed candidate when Core self-checkout is enabled"
                )

        if not platform_webhook_secrets or any(
            is_placeholder_value(secret)
            or not secret.startswith("whsec_")
            or not has_minimum_secret_length(secret, 20)
            for secret in platform_webhook_secrets
        ):
            missing.append("STRIPE_PLATFORM_WEBHOOK_SECRET must be a Stripe webhook secret")

        if not connect_webhook_secrets or any(
            is_placeholder_value(secret)
            or not secret.startswith("whsec_")
            or not has_minimum_secret_length(secret, 20)
            for secret in connect_webhook_secrets
        ):
            missing.append("STRIPE_CONNECT_WEBHOOK_SECRET must contain Stripe webhook secrets")

        if not self.STRIPE_KOARYU_CORE_PRICE_ID.startswith("price_") or not has_minimum_secret_length(
            self.STRIPE_KOARYU_CORE_PRICE_ID, 16
        ):
            missing.append("STRIPE_KOARYU_CORE_PRICE_ID must be a Stripe Price ID")

        if not has_minimum_secret_length(self.ACCOUNT_DELETION_WORKER_SECRET):
            missing.append("ACCOUNT_DELETION_WORKER_SECRET must be a long random secret")

        if not has_minimum_secret_length(self.BILLING_TRANSITION_WORKER_SECRET):
            missing.append("BILLING_TRANSITION_WORKER_SECRET must be a long random secret")

        if not has_minimum_secret_length(self.SUPPORT_TRIAGE_SECRET):
            missing.append("SUPPORT_TRIAGE_SECRET must be a long random secret")

        if self.OPERATIONAL_ALERTS_ENABLED:
            if (
                is_placeholder_value(self.OPERATIONAL_ALERT_WORKER_SECRET)
                or not has_minimum_secret_length(self.OPERATIONAL_ALERT_WORKER_SECRET)
            ):
                missing.append("OPERATIONAL_ALERT_WORKER_SECRET must be a long random secret when alerts are enabled")
            alert_destinations = (
                (
                    "PRIMARY",
                    self.OPERATIONAL_ALERT_PRIMARY_URL,
                    self.OPERATIONAL_ALERT_PRIMARY_URL_SHA256,
                    self.OPERATIONAL_ALERT_PRIMARY_HOST,
                    self.OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET,
                    self.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET,
                ),
                (
                    "BACKUP",
                    self.OPERATIONAL_ALERT_BACKUP_URL,
                    self.OPERATIONAL_ALERT_BACKUP_URL_SHA256,
                    self.OPERATIONAL_ALERT_BACKUP_HOST,
                    self.OPERATIONAL_ALERT_BACKUP_BEARER_SECRET,
                    self.OPERATIONAL_ALERT_BACKUP_ACK_SECRET,
                ),
            )
            for label, url, fingerprint, hostname, bearer_secret, ack_secret in alert_destinations:
                try:
                    validate_operational_alert_destination(url, fingerprint, hostname)
                except ValueError:
                    missing.append(
                        f"OPERATIONAL_ALERT_{label}_URL, host allowlist, and fingerprint must be an exact public HTTPS destination"
                    )
                if is_placeholder_value(bearer_secret) or not has_minimum_secret_length(bearer_secret):
                    missing.append(
                        f"OPERATIONAL_ALERT_{label}_BEARER_SECRET must be a long random secret"
                    )
                if is_placeholder_value(ack_secret) or not has_minimum_secret_length(ack_secret):
                    missing.append(
                        f"OPERATIONAL_ALERT_{label}_ACK_SECRET must be a long random secret"
                    )
            configured_alert_secrets = {
                self.OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET,
                self.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET,
                self.OPERATIONAL_ALERT_BACKUP_BEARER_SECRET,
                self.OPERATIONAL_ALERT_BACKUP_ACK_SECRET,
            }
            if len(configured_alert_secrets) != 4:
                missing.append("operational alert bearer and acknowledgement secrets must all be distinct")
            if (
                self.OPERATIONAL_ALERT_PRIMARY_URL == self.OPERATIONAL_ALERT_BACKUP_URL
                or self.OPERATIONAL_ALERT_PRIMARY_URL_SHA256
                == self.OPERATIONAL_ALERT_BACKUP_URL_SHA256
            ):
                missing.append("operational alert primary and backup destinations must be distinct")

        if environment == "staging":
            if self.SUPABASE_URL != KOARYU_STAGING_SUPABASE_URL:
                missing.append("SUPABASE_URL must match Koaryu's pinned staging project")

        if missing:
            detail = ", ".join(dict.fromkeys(missing))
            label = environment.capitalize()
            raise RuntimeError(f"{label} configuration is incomplete or unsafe: {detail}")

    def validate_production_configuration(self) -> None:
        """Backward-compatible alias for the hosted runtime guard."""
        self.validate_runtime_configuration()


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def validate_operational_alert_destination(
    url: str,
    expected_sha256: str,
    expected_hostname: str,
) -> str:
    """Validate one exact, public HTTPS destination without resolving or logging it."""
    if not url or url != url.strip() or any(ord(character) < 32 or ord(character) == 127 for character in url):
        raise ValueError("invalid operational alert destination")
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.port not in {None, 443}
    ):
        raise ValueError("invalid operational alert destination")
    hostname = parsed.hostname.lower()
    if (
        expected_hostname != expected_hostname.strip().lower()
        or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+",
            expected_hostname,
        )
        or not secrets.compare_digest(hostname, expected_hostname)
    ):
        raise ValueError("invalid operational alert destination")
    if hostname == "localhost" or hostname.endswith(
        (".localhost", ".local", ".test", ".invalid", ".example")
    ):
        raise ValueError("invalid operational alert destination")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise ValueError("invalid operational alert destination")
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256 or ""):
        raise ValueError("invalid operational alert destination")
    if not secrets.compare_digest(digest, expected_sha256):
        raise ValueError("invalid operational alert destination")
    return url
