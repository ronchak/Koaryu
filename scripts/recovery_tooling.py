#!/usr/bin/env python3
"""Shared, secret-safe contracts for Koaryu recovery tooling."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
import uuid
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit


class RecoveryToolingError(ValueError):
    """A deliberately sanitized recovery-contract failure."""


SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
BACKUP_SET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
STRIPE_EVENT_ID_RE = re.compile(r"^evt_[A-Za-z0-9]{8,124}$")
PROJECT_REF_RE = re.compile(r"^[a-z]{20}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MIGRATION_HEAD_RE = re.compile(r"^[0-9]{14}_[a-z0-9_]+\.sql$")

GPG_S2K_MODE = 3
GPG_S2K_DIGEST_ID = 10  # SHA-512 in OpenPGP packet output.
GPG_S2K_COUNT = 65_011_712
GPG_AEAD_CHUNK_SIZE = 22
GPG_PACKET_CHUNK_BYTE = GPG_AEAD_CHUNK_SIZE - 6

RAW_PII_KEYS = {
    "address",
    "browser_context",
    "details",
    "email",
    "email_address",
    "first_name",
    "full_name",
    "last_name",
    "phone",
    "phone_number",
    "requester_email",
    "subject",
    "user_agent",
}
SECRET_VALUE_KEYS = {
    "access_token",
    "anon_key",
    "api_key",
    "authorization",
    "client_secret",
    "database_url",
    "jwt_secret",
    "password",
    "refresh_token",
    "secret",
    "secret_key",
    "service_role_key",
    "signed_url",
    "token",
    "webhook_secret",
}

REQUIRED_ENCRYPTED_ARTIFACTS: dict[str, str] = {
    "roles.sql.gpg": "database_roles",
    "schema.sql.gpg": "database_schema",
    "data.sql.gpg": "database_data",
    "migration-history-schema.sql.gpg": "migration_history_schema",
    "migration-history-data.sql.gpg": "migration_history_data",
    "project-config-manifest.json.gpg": "project_configuration",
    "restore-integrity-manifest.json.gpg": "restore_integrity",
    "classification-source.json.gpg": "classification_source",
    "record-classification-manifest.json.gpg": "record_classification",
    "storage-objects.tar.gpg": "storage_objects",
}
CONTRACT_ARTIFACTS: dict[str, str] = {
    "project-config-manifest.json.gpg": "project-config",
    "restore-integrity-manifest.json.gpg": "restore-integrity",
    "classification-source.json.gpg": "classification-source",
    "record-classification-manifest.json.gpg": "classification-manifest",
}
BACKUP_MANIFEST_NAME = "backup-manifest.json.gpg"
PROVIDER_RECEIPT_NAME = "provider-download-receipt.json"
SNAPSHOT_PAYLOAD_ARTIFACTS = (
    "roles.sql.gpg",
    "schema.sql.gpg",
    "data.sql.gpg",
    "migration-history-schema.sql.gpg",
    "migration-history-data.sql.gpg",
    "storage-objects.tar.gpg",
)

PROJECT_CAPTURED_SURFACES = (
    "api_key_posture",
    "auth_core_security",
    "data_api_schema_and_grants",
    "integration_mode_posture",
    "realtime_publications",
    "storage_bucket_configuration",
)
PROJECT_MANUAL_RECONFIGURATION = (
    "auth_external_providers_and_oauth_credentials",
    "auth_hooks",
    "auth_smtp_sms_and_message_templates",
    "custom_domains",
    "database_network_pooler_and_ssl_settings",
    "edge_function_code_secrets_and_schedules",
    "logging_alerting_and_drains",
    "provider_plan_backups_and_pitr",
    "realtime_limits",
    "runtime_deployment_environment",
    "storage_s3_and_image_transformation_settings",
    "stripe_credentials_webhook_secrets_and_dashboard_configuration",
    "vault_secrets",
)
INTEGRITY_UNVERIFIED_UNTIL_RESTORE = (
    "catalog_digests",
    "migration_history_row_semantics",
    "storage_object_inventory_and_bytes",
    "table_row_counts_and_primary_key_sets",
)


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise RecoveryToolingError("Recovery directory could not be durably synchronized") from exc


def _publish_private_file_noreplace(temporary: Path, output: Path) -> None:
    """Atomically publish one private file without ever replacing an existing path."""
    published = False
    try:
        os.link(temporary, output, follow_symlinks=False)
        published = True
        temporary.unlink()
        _fsync_directory(output.parent)
    except OSError as exc:
        if published:
            output.unlink(missing_ok=True)
        raise RecoveryToolingError("Refusing to overwrite an existing or unsafe output") from exc
    except RecoveryToolingError:
        if published:
            output.unlink(missing_ok=True)
        raise


def _open_private_regular_file(path: Path, *, encrypted: bool = False) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        details = os.fstat(descriptor)
    except OSError as exc:
        raise RecoveryToolingError("Recovery input must be a regular non-symlink file") from exc
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
        os.close(descriptor)
        raise RecoveryToolingError("Recovery input must be a singly linked regular file")
    mode = stat.S_IMODE(details.st_mode)
    if mode & 0o077:
        os.close(descriptor)
        kind = "Encrypted artifact" if encrypted else "Recovery contract"
        raise RecoveryToolingError(f"{kind} must not be group- or world-accessible")
    return descriptor, details


def _assert_unchanged_fd(descriptor: int, before: os.stat_result) -> None:
    try:
        after = os.fstat(descriptor)
    except OSError as exc:
        raise RecoveryToolingError("Recovery input changed while it was being read") from exc
    identity = (before.st_dev, before.st_ino, before.st_nlink)
    final_identity = (after.st_dev, after.st_ino, after.st_nlink)
    state = (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    final_state = (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
    if identity != final_identity or state != final_state or after.st_nlink != 1:
        raise RecoveryToolingError("Recovery input changed while it was being read")


def measure_private_file(path: Path, *, encrypted: bool | None = None) -> dict[str, Any]:
    if encrypted is None:
        encrypted = path.suffix == ".gpg"
    descriptor, before = _open_private_regular_file(path, encrypted=encrypted)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(os.dup(descriptor), "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
        _assert_unchanged_fd(descriptor, before)
    finally:
        os.close(descriptor)
    return {
        "size_bytes": size,
        "sha256": f"sha256:{digest.hexdigest()}",
    }


def sha256_file(path: Path) -> str:
    return measure_private_file(path)["sha256"]


def load_json(
    path: Path,
    *,
    max_bytes: int = 16 * 1024 * 1024,
    require_private: bool = False,
) -> Any:
    if require_private:
        descriptor, before = _open_private_regular_file(path)
    else:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
            before = os.fstat(descriptor)
        except OSError as exc:
            raise RecoveryToolingError("JSON input must be a regular non-symlink file") from exc
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) & 0o022
        ):
            os.close(descriptor)
            raise RecoveryToolingError(
                "Public JSON input must be a singly linked regular file that is not group- or world-writable"
            )
    if before.st_size > max_bytes:
        os.close(descriptor)
        raise RecoveryToolingError("JSON contract exceeds the allowed size")
    try:
        with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        _assert_unchanged_fd(descriptor, before)
        return payload
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryToolingError("JSON contract is unreadable or malformed") from exc
    finally:
        os.close(descriptor)


def write_private_json(path: Path, value: Any) -> None:
    if path.exists() or path.is_symlink():
        raise RecoveryToolingError("Refusing to overwrite an existing output")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (
        path.parent.is_symlink()
        or not path.parent.is_dir()
        or stat.S_IMODE(path.parent.stat().st_mode) & 0o077
    ):
        raise RecoveryToolingError("Private JSON output directory must be a locked non-symlink directory")
    old_umask = os.umask(0o077)
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        _publish_private_file_noreplace(temporary, path)
        temporary = None
    finally:
        os.umask(old_umask)
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _require_private_regular_file(path: Path, *, encrypted: bool = False) -> None:
    descriptor, _ = _open_private_regular_file(path, encrypted=encrypted)
    os.close(descriptor)


def require_private_backup_directory(path: Path) -> Path:
    """Resolve an existing locked directory without accepting a symlink."""
    if path.is_symlink() or not path.is_dir():
        raise RecoveryToolingError("Backup set must be a regular non-symlink directory")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise RecoveryToolingError("Backup directory must not be group- or world-accessible")
    try:
        return path.resolve(strict=True)
    except OSError as exc:
        raise RecoveryToolingError("Backup directory could not be resolved") from exc


def require_exact_inventory(
    backup_dir: Path,
    *,
    include_manifest: bool,
    include_provider_receipt: bool = False,
) -> None:
    expected = set(REQUIRED_ENCRYPTED_ARTIFACTS)
    if include_manifest:
        expected.add(BACKUP_MANIFEST_NAME)
    if include_provider_receipt:
        expected.add(PROVIDER_RECEIPT_NAME)
    try:
        entries = list(backup_dir.iterdir())
    except OSError as exc:
        raise RecoveryToolingError("Backup artifact inventory could not be read") from exc
    actual = {entry.name for entry in entries}
    if actual != expected:
        raise RecoveryToolingError("Backup directory does not contain the exact canonical artifact set")
    for entry in entries:
        _require_private_regular_file(entry, encrypted=entry.suffix == ".gpg")


def _expect_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RecoveryToolingError(f"{label} must be an object")
    return value


def _expect_exact_keys(value: Mapping[str, Any], expected: Iterable[str], label: str) -> None:
    expected_set = set(expected)
    actual = set(value)
    if actual != expected_set:
        raise RecoveryToolingError(f"{label} has missing or unsupported fields")


def _expect_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise RecoveryToolingError(f"{label} must be a boolean")
    return value


def _expect_int(value: Any, label: str, *, minimum: int = 0, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RecoveryToolingError(f"{label} must be an integer in the allowed range")
    if maximum is not None and value > maximum:
        raise RecoveryToolingError(f"{label} must be an integer in the allowed range")
    return value


def _expect_safe_text(value: Any, label: str, *, pattern: re.Pattern[str] = SAFE_ID_RE) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise RecoveryToolingError(f"{label} must be a bounded opaque identifier")
    return value


def _expect_record_id(value: Any, label: str, source_type: str) -> str:
    if not isinstance(value, str):
        raise RecoveryToolingError(f"{label} must use the canonical source identifier")
    if source_type == "stripe_event":
        if not STRIPE_EVENT_ID_RE.fullmatch(value):
            raise RecoveryToolingError("Stripe classification records require a canonical evt_ identifier")
        return value
    if not UUID_RE.fullmatch(value):
        raise RecoveryToolingError("Database classification records require a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise RecoveryToolingError("Database classification records require a canonical UUID") from exc
    if str(parsed) != value:
        raise RecoveryToolingError("Database classification records require a canonical lowercase UUID")
    return value


def _expect_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise RecoveryToolingError(f"{label} must be a prefixed SHA-256 digest")
    return value


def _expect_timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) > 64:
        raise RecoveryToolingError(f"{label} must be an ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RecoveryToolingError(f"{label} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RecoveryToolingError(f"{label} must include a timezone")
    return value


def _expect_string_list(value: Any, label: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise RecoveryToolingError(f"{label} must be a list of strings")
    if (
        not all(
            isinstance(item, str)
            and item
            and len(item) <= 256
            and "\r" not in item
            and "\n" not in item
            for item in value
        )
        or len(value) != len(set(value))
    ):
        raise RecoveryToolingError(f"{label} must contain unique non-empty strings")
    return list(value)


def _expect_safe_id_list(value: Any, label: str, *, allow_empty: bool = True) -> list[str]:
    items = _expect_string_list(value, label, allow_empty=allow_empty)
    for item in items:
        _expect_safe_text(item, label)
    return items


def _expect_canonical_list(value: Any, expected: Iterable[str], label: str) -> list[str]:
    items = _expect_string_list(value, label, allow_empty=False)
    canonical = sorted(expected)
    if items != canonical:
        raise RecoveryToolingError(f"{label} must be the exact sorted canonical inventory")
    return items


def _expect_https_url(value: Any, label: str, *, origin_only: bool = False) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise RecoveryToolingError(f"{label} must be a bounded HTTPS URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RecoveryToolingError(f"{label} must be a credential-free canonical HTTPS URL")
    if origin_only and parsed.path not in ("", "/"):
        raise RecoveryToolingError(f"{label} must be an origin without a path")
    return value


def _reject_sensitive_keys(value: Any, *, allow_email_hmac: bool = False) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = str(key).strip().lower()
            if normalized in SECRET_VALUE_KEYS or normalized in RAW_PII_KEYS:
                raise RecoveryToolingError("Recovery evidence contains a prohibited secret or raw-PII field")
            if normalized == "email_hmac" and not allow_email_hmac:
                raise RecoveryToolingError("Email-derived identifiers are not allowed in this contract")
            _reject_sensitive_keys(nested, allow_email_hmac=allow_email_hmac)
    elif isinstance(value, list):
        for nested in value:
            _reject_sensitive_keys(nested, allow_email_hmac=allow_email_hmac)


def validate_backup_metadata(value: Any) -> dict[str, Any]:
    payload = _expect_mapping(value, "backup metadata")
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "source", "tools", "encryption", "retention_class"}, "backup metadata")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported backup metadata schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)

    source = _expect_mapping(payload["source"], "backup source")
    _expect_exact_keys(source, {"project_ref", "captured_at", "database_snapshot_digest", "application_sha", "repository_migration_head", "remote_migration_history_digest"}, "backup source")
    _expect_safe_text(source["project_ref"], "source project ref", pattern=PROJECT_REF_RE)
    _expect_timestamp(source["captured_at"], "capture timestamp")
    _expect_sha256(source["database_snapshot_digest"], "database snapshot digest")
    _expect_safe_text(source["application_sha"], "application SHA", pattern=GIT_SHA_RE)
    _expect_safe_text(source["repository_migration_head"], "repository migration head", pattern=MIGRATION_HEAD_RE)
    _expect_sha256(source["remote_migration_history_digest"], "remote migration history digest")

    tools = _expect_mapping(payload["tools"], "tool versions")
    _expect_exact_keys(tools, {"postgres", "supabase_cli", "gpg"}, "tool versions")
    for key, item in tools.items():
        if not isinstance(item, str) or not item.strip() or len(item) > 80 or any(character in item for character in "\r\n"):
            raise RecoveryToolingError(f"{key} version is malformed")

    encryption = _expect_mapping(payload["encryption"], "encryption metadata")
    _expect_exact_keys(
        encryption,
        {"scheme", "key_id", "s2k_mode", "s2k_digest", "s2k_count", "aead_chunk_size"},
        "encryption metadata",
    )
    if encryption["scheme"] != "gpg-aes256-ocb":
        raise RecoveryToolingError("Backup manifest requires GPG AES-256 OCB")
    _expect_safe_text(encryption["key_id"], "encryption key id", pattern=KEY_ID_RE)
    if (
        encryption["s2k_mode"] != GPG_S2K_MODE
        or encryption["s2k_digest"] != "SHA512"
        or encryption["s2k_count"] != GPG_S2K_COUNT
        or encryption["aead_chunk_size"] != GPG_AEAD_CHUNK_SIZE
    ):
        raise RecoveryToolingError("Backup metadata does not declare the canonical GPG key-derivation profile")
    _expect_safe_text(payload["retention_class"], "retention class")
    _reject_sensitive_keys(payload)
    return payload


def validate_project_config(value: Any) -> dict[str, Any]:
    payload = _expect_mapping(value, "project configuration manifest")
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "captured_at", "source_project_ref", "evidence_scope", "auth", "api_keys", "data_api", "realtime", "storage", "integrations"}, "project configuration manifest")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported project configuration schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_timestamp(payload["captured_at"], "project configuration capture timestamp")
    _expect_safe_text(payload["source_project_ref"], "source project ref", pattern=PROJECT_REF_RE)

    evidence_scope = _expect_mapping(payload["evidence_scope"], "project configuration evidence scope")
    _expect_exact_keys(
        evidence_scope,
        {"assurance", "captured_surfaces", "manual_reconfiguration_required"},
        "project configuration evidence scope",
    )
    if evidence_scope["assurance"] != "operator_attested_partial":
        raise RecoveryToolingError("Project configuration evidence must not claim automated completeness")
    _expect_canonical_list(
        evidence_scope["captured_surfaces"],
        PROJECT_CAPTURED_SURFACES,
        "captured project surfaces",
    )
    _expect_canonical_list(
        evidence_scope["manual_reconfiguration_required"],
        PROJECT_MANUAL_RECONFIGURATION,
        "manual project reconfiguration inventory",
    )

    auth = _expect_mapping(payload["auth"], "Auth configuration")
    _expect_exact_keys(auth, {"site_url_origin", "redirect_allow_list", "email_confirmation_required", "otp_length", "otp_expiry_seconds", "password_min_length", "password_required_characters", "leaked_password_protection", "captcha_enabled", "jwt_expiry_seconds", "session", "mfa"}, "Auth configuration")
    _expect_https_url(auth["site_url_origin"], "Auth site URL", origin_only=True)
    redirects = _expect_string_list(auth["redirect_allow_list"], "Auth redirect allow-list", allow_empty=False)
    for redirect in redirects:
        _expect_https_url(redirect, "Auth redirect URL")
    _expect_bool(auth["email_confirmation_required"], "email confirmation setting")
    _expect_int(auth["otp_length"], "OTP length", minimum=6, maximum=10)
    _expect_int(auth["otp_expiry_seconds"], "OTP expiry", minimum=60, maximum=86400)
    _expect_int(auth["password_min_length"], "password minimum length", minimum=6, maximum=128)
    required_characters = auth["password_required_characters"]
    if required_characters is not None and (not isinstance(required_characters, str) or len(required_characters) > 160):
        raise RecoveryToolingError("Password character policy is malformed")
    _expect_bool(auth["leaked_password_protection"], "leaked-password protection")
    _expect_bool(auth["captcha_enabled"], "CAPTCHA setting")
    _expect_int(auth["jwt_expiry_seconds"], "JWT expiry", minimum=300, maximum=86400)

    session = _expect_mapping(auth["session"], "Auth session configuration")
    _expect_exact_keys(session, {"inactivity_timeout_seconds", "timebox_seconds", "single_session_per_user"}, "Auth session configuration")
    for key in ("inactivity_timeout_seconds", "timebox_seconds"):
        if session[key] is not None:
            _expect_int(session[key], key, minimum=300)
    _expect_bool(session["single_session_per_user"], "single-session setting")

    mfa = _expect_mapping(auth["mfa"], "MFA configuration")
    _expect_exact_keys(mfa, {"totp_api_enabled", "phone_api_enabled", "webauthn_api_enabled", "enforcement"}, "MFA configuration")
    for key in ("totp_api_enabled", "phone_api_enabled", "webauthn_api_enabled"):
        _expect_bool(mfa[key], key)
    if mfa["enforcement"] not in {"none", "optional", "step_up", "all"}:
        raise RecoveryToolingError("MFA enforcement posture is unsupported")

    api_keys = _expect_mapping(payload["api_keys"], "API-key posture")
    _expect_exact_keys(api_keys, {"publishable_enabled", "secret_enabled", "legacy_anon_enabled", "legacy_service_role_enabled", "signing_algorithm"}, "API-key posture")
    for key in ("publishable_enabled", "secret_enabled", "legacy_anon_enabled", "legacy_service_role_enabled"):
        _expect_bool(api_keys[key], key)
    if api_keys["signing_algorithm"] not in {"ES256", "RS256", "HS256"}:
        raise RecoveryToolingError("Auth signing algorithm is unsupported")

    data_api = _expect_mapping(payload["data_api"], "Data API configuration")
    _expect_exact_keys(data_api, {"exposed_schemas", "automatic_table_exposure", "grants_digest"}, "Data API configuration")
    _expect_safe_id_list(data_api["exposed_schemas"], "Data API schemas", allow_empty=False)
    _expect_bool(data_api["automatic_table_exposure"], "automatic table exposure")
    _expect_sha256(data_api["grants_digest"], "Data API grants digest")

    realtime = _expect_mapping(payload["realtime"], "Realtime configuration")
    _expect_exact_keys(realtime, {"publications"}, "Realtime configuration")
    _expect_safe_id_list(realtime["publications"], "Realtime publications")

    storage = _expect_mapping(payload["storage"], "Storage configuration")
    _expect_exact_keys(storage, {"buckets"}, "Storage configuration")
    if not isinstance(storage["buckets"], list):
        raise RecoveryToolingError("Storage buckets must be a list")
    bucket_ids: set[str] = set()
    for bucket in storage["buckets"]:
        item = _expect_mapping(bucket, "Storage bucket")
        _expect_exact_keys(item, {"id", "public", "file_size_limit", "allowed_mime_types"}, "Storage bucket")
        bucket_id = _expect_safe_text(item["id"], "Storage bucket id")
        if bucket_id in bucket_ids:
            raise RecoveryToolingError("Storage bucket ids must be unique")
        bucket_ids.add(bucket_id)
        _expect_bool(item["public"], "Storage bucket public setting")
        if item["file_size_limit"] is not None:
            _expect_int(item["file_size_limit"], "Storage file-size limit", minimum=1)
        _expect_string_list(item["allowed_mime_types"], "Storage MIME types")

    integrations = _expect_mapping(payload["integrations"], "integration posture")
    _expect_exact_keys(integrations, {"stripe_mode", "email_delivery"}, "integration posture")
    if integrations["stripe_mode"] not in {"disabled", "test", "live"}:
        raise RecoveryToolingError("Stripe mode is unsupported")
    if integrations["email_delivery"] not in {"disabled", "sink", "configured"}:
        raise RecoveryToolingError("Email delivery posture is unsupported")

    _reject_sensitive_keys(payload)
    return payload


def validate_restore_integrity(value: Any) -> dict[str, Any]:
    payload = _expect_mapping(value, "restore integrity manifest")
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "captured_at", "database_snapshot_digest", "evidence_scope", "snapshot_artifacts", "migration_history", "tables", "catalog", "storage"}, "restore integrity manifest")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported restore integrity schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_timestamp(payload["captured_at"], "integrity capture timestamp")
    _expect_sha256(payload["database_snapshot_digest"], "database snapshot digest")

    evidence_scope = _expect_mapping(payload["evidence_scope"], "restore integrity evidence scope")
    _expect_exact_keys(
        evidence_scope,
        {"assurance", "digest_algorithm", "unverified_until_restore"},
        "restore integrity evidence scope",
    )
    if evidence_scope["assurance"] != "operator_attested_partial":
        raise RecoveryToolingError("Restore integrity evidence must not claim pre-restore completeness")
    if evidence_scope["digest_algorithm"] != "canonical-json-sha256-v1":
        raise RecoveryToolingError("Restore integrity digest algorithm is unsupported")
    _expect_canonical_list(
        evidence_scope["unverified_until_restore"],
        INTEGRITY_UNVERIFIED_UNTIL_RESTORE,
        "post-restore verification inventory",
    )

    if not isinstance(payload["snapshot_artifacts"], list):
        raise RecoveryToolingError("Restore integrity must bind the snapshot payload artifacts")
    snapshot_artifacts: dict[str, dict[str, Any]] = {}
    for artifact in payload["snapshot_artifacts"]:
        item = _expect_mapping(artifact, "snapshot artifact binding")
        _expect_exact_keys(
            item,
            {"name", "plaintext_size_bytes", "plaintext_sha256"},
            "snapshot artifact binding",
        )
        name = item["name"]
        if name not in SNAPSHOT_PAYLOAD_ARTIFACTS or name in snapshot_artifacts:
            raise RecoveryToolingError("Snapshot artifact bindings are duplicated or unsupported")
        _expect_int(item["plaintext_size_bytes"], "snapshot plaintext size", minimum=1)
        _expect_sha256(item["plaintext_sha256"], "snapshot plaintext digest")
        snapshot_artifacts[name] = item
    if set(snapshot_artifacts) != set(SNAPSHOT_PAYLOAD_ARTIFACTS):
        raise RecoveryToolingError("Restore integrity must bind every canonical snapshot payload artifact")
    measured_snapshot_digest = compute_snapshot_digest({
        name: {
            "plaintext_size_bytes": item["plaintext_size_bytes"],
            "plaintext_sha256": item["plaintext_sha256"],
        }
        for name, item in snapshot_artifacts.items()
    })
    if measured_snapshot_digest != payload["database_snapshot_digest"]:
        raise RecoveryToolingError(
            "Restore integrity snapshot digest is not derived from its plaintext artifact bindings"
        )

    history = _expect_mapping(payload["migration_history"], "migration history contract")
    _expect_exact_keys(history, {"row_count", "digest", "columns"}, "migration history contract")
    _expect_int(history["row_count"], "migration history row count")
    _expect_sha256(history["digest"], "migration history digest")
    columns = _expect_safe_id_list(history["columns"], "migration history columns", allow_empty=False)
    if not {"version", "statements", "name"}.issubset(columns):
        raise RecoveryToolingError("Migration history must preserve every canonical Supabase CLI column")

    tables = payload["tables"]
    if not isinstance(tables, list) or not tables:
        raise RecoveryToolingError("Restore integrity manifest must inventory tables")
    table_keys: set[tuple[str, str]] = set()
    for table in tables:
        item = _expect_mapping(table, "table integrity entry")
        _expect_exact_keys(item, {"schema", "table", "row_count", "primary_key_set_digest"}, "table integrity entry")
        schema = _expect_safe_text(item["schema"], "table schema")
        name = _expect_safe_text(item["table"], "table name")
        key = (schema, name)
        if key in table_keys:
            raise RecoveryToolingError("Table integrity entries must be unique")
        table_keys.add(key)
        _expect_int(item["row_count"], "table row count")
        _expect_sha256(item["primary_key_set_digest"], "primary-key-set digest")

    catalog = _expect_mapping(payload["catalog"], "database catalog integrity")
    _expect_exact_keys(catalog, {"functions_digest", "triggers_digest", "rls_policies_digest", "grants_digest", "extensions", "publications"}, "database catalog integrity")
    for key in ("functions_digest", "triggers_digest", "rls_policies_digest", "grants_digest"):
        _expect_sha256(catalog[key], key)
    _expect_safe_id_list(catalog["extensions"], "extension inventory")
    _expect_safe_id_list(catalog["publications"], "publication inventory")

    storage = _expect_mapping(payload["storage"], "Storage integrity")
    _expect_exact_keys(storage, {"buckets"}, "Storage integrity")
    if not isinstance(storage["buckets"], list):
        raise RecoveryToolingError("Storage integrity buckets must be a list")
    bucket_ids: set[str] = set()
    for bucket in storage["buckets"]:
        item = _expect_mapping(bucket, "Storage integrity bucket")
        _expect_exact_keys(item, {"id", "object_count", "object_path_digest", "object_bytes_digest", "configuration_digest"}, "Storage integrity bucket")
        bucket_id = _expect_safe_text(item["id"], "Storage bucket id")
        if bucket_id in bucket_ids:
            raise RecoveryToolingError("Storage integrity bucket ids must be unique")
        bucket_ids.add(bucket_id)
        _expect_int(item["object_count"], "Storage object count")
        for key in ("object_path_digest", "object_bytes_digest", "configuration_digest"):
            _expect_sha256(item[key], key)
    _reject_sensitive_keys(payload)
    return payload


def validate_classification_policy(value: Any) -> dict[str, Any]:
    policy = _expect_mapping(value, "classification policy")
    _expect_exact_keys(policy, {"schema_version", "policy_id", "policy_version", "default_label", "fallback_rule_id", "ambiguous_rule_id", "labels", "source_types", "allowed_evidence_markers", "rules"}, "classification policy")
    if policy["schema_version"] != 1 or policy["policy_version"] != 1:
        raise RecoveryToolingError("Unsupported classification policy version")
    _expect_safe_text(policy["policy_id"], "policy id")
    fallback_rule_id = _expect_safe_text(policy["fallback_rule_id"], "fallback rule id")
    ambiguous_rule_id = _expect_safe_text(policy["ambiguous_rule_id"], "ambiguous rule id")
    if fallback_rule_id == ambiguous_rule_id:
        raise RecoveryToolingError("Fallback and ambiguous classification rule ids must differ")
    labels = _expect_string_list(policy["labels"], "classification labels", allow_empty=False)
    if policy["default_label"] != "unknown" or "unknown" not in labels:
        raise RecoveryToolingError("Classification must fail closed to unknown")
    sources = _expect_string_list(policy["source_types"], "classification source types", allow_empty=False)
    evidence = set(_expect_string_list(policy["allowed_evidence_markers"], "approved evidence markers", allow_empty=False))
    if not isinstance(policy["rules"], list) or not policy["rules"]:
        raise RecoveryToolingError("Classification policy must define explicit rules")
    rule_ids: set[str] = {fallback_rule_id, ambiguous_rule_id}
    for rule in policy["rules"]:
        item = _expect_mapping(rule, "classification rule")
        _expect_exact_keys(
            item,
            {"rule_id", "label", "source_types", "all_evidence", "reason_code"},
            "classification rule",
        )
        rule_id = _expect_safe_text(item["rule_id"], "classification rule id")
        if rule_id in rule_ids:
            raise RecoveryToolingError("Classification rule ids must be unique")
        rule_ids.add(rule_id)
        if item["label"] not in labels or item["label"] == "unknown":
            raise RecoveryToolingError("Explicit rules must produce a known label")
        applicable_sources = set(
            _expect_string_list(item["source_types"], "rule source types", allow_empty=False)
        )
        if not applicable_sources.issubset(set(sources)):
            raise RecoveryToolingError("Classification rule uses an unsupported source type")
        required = set(_expect_string_list(item["all_evidence"], "rule evidence", allow_empty=False))
        if not required.issubset(evidence):
            raise RecoveryToolingError("Classification rule uses an unapproved evidence marker")
        _expect_safe_text(item["reason_code"], "classification reason code")
    if len(sources) != len(set(sources)):
        raise RecoveryToolingError("Classification source types must be unique")
    return policy


def validate_classification_source(value: Any, policy: Mapping[str, Any]) -> dict[str, Any]:
    validate_classification_policy(policy)
    payload = _expect_mapping(value, "classification source")
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "source_snapshot_digest", "captured_at", "identifier_protection", "sources"}, "classification source")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported classification source schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_sha256(payload["source_snapshot_digest"], "classification snapshot digest")
    _expect_timestamp(payload["captured_at"], "classification capture timestamp")

    protection = _expect_mapping(payload["identifier_protection"], "identifier protection")
    _expect_exact_keys(protection, {"email_strategy", "key_id"}, "identifier protection")
    if protection != {"email_strategy": "omitted", "key_id": None}:
        raise RecoveryToolingError(
            "Classification inputs must omit email-derived identifiers; no trusted HMAC capture path is configured"
        )

    expected_sources = set(policy["source_types"])
    if not isinstance(payload["sources"], list):
        raise RecoveryToolingError("Classification sources must be a list")
    seen_sources: set[str] = set()
    seen_records: set[tuple[str, str]] = set()
    allowed_evidence = set(policy["allowed_evidence_markers"])
    for source in payload["sources"]:
        item = _expect_mapping(source, "classification source group")
        _expect_exact_keys(item, {"source_type", "source_count", "records"}, "classification source group")
        source_type = _expect_safe_text(item["source_type"], "classification source type")
        if source_type not in expected_sources or source_type in seen_sources:
            raise RecoveryToolingError("Classification source coverage is missing, duplicated, or unsupported")
        seen_sources.add(source_type)
        if not isinstance(item["records"], list):
            raise RecoveryToolingError("Classification records must be a list")
        _expect_int(item["source_count"], "classification source count")
        if item["source_count"] != len(item["records"]):
            raise RecoveryToolingError("Classification source count does not match its records")
        for record in item["records"]:
            row = _expect_mapping(record, "classification source record")
            _expect_exact_keys(row, {"record_id", "evidence"}, "classification record")
            record_id = _expect_record_id(
                row["record_id"], "classification record id", source_type
            )
            composite = (source_type, record_id)
            if composite in seen_records:
                raise RecoveryToolingError("Classification record identifiers must be unique per source")
            seen_records.add(composite)
            markers = set(_expect_string_list(row["evidence"], "classification evidence"))
            if not markers.issubset(allowed_evidence):
                raise RecoveryToolingError("Classification input contains unapproved evidence")
    if seen_sources != expected_sources:
        raise RecoveryToolingError("Classification input must include every policy source type, including empty sources")
    _reject_sensitive_keys(payload)
    return payload


def _classify_record(
    record: Mapping[str, Any],
    policy: Mapping[str, Any],
    source_type: str,
) -> dict[str, str]:
    evidence = set(record["evidence"])
    matches = [
        rule
        for rule in policy["rules"]
        if source_type in rule["source_types"]
        and set(rule["all_evidence"]).issubset(evidence)
    ]
    if not matches:
        return {
            "classification": policy["default_label"],
            "rule_id": policy["fallback_rule_id"],
            "reason_code": "no_approved_evidence",
        }
    if len(matches) != 1:
        return {
            "classification": policy["default_label"],
            "rule_id": policy["ambiguous_rule_id"],
            "reason_code": "ambiguous_approved_evidence",
        }
    rule = matches[0]
    return {
        "classification": rule["label"],
        "rule_id": rule["rule_id"],
        "reason_code": rule["reason_code"],
    }


def build_classification_manifest(source: Any, policy: Any, *, generated_at: str | None = None) -> dict[str, Any]:
    policy = validate_classification_policy(policy)
    source = validate_classification_source(source, policy)
    labels = list(policy["labels"])
    total_counts = {label: 0 for label in labels}
    output_sources: list[dict[str, Any]] = []
    for source_group in source["sources"]:
        source_counts = {label: 0 for label in labels}
        records: list[dict[str, Any]] = []
        for record in source_group["records"]:
            classification = _classify_record(record, policy, source_group["source_type"])
            source_counts[classification["classification"]] += 1
            total_counts[classification["classification"]] += 1
            output = {
                "record_id": record["record_id"],
                "evidence": sorted(record["evidence"]),
                "evidence_fingerprint": sha256_bytes(canonical_json_bytes(sorted(record["evidence"]))),
                **classification,
            }
            records.append(output)
        output_sources.append({
            "source_type": source_group["source_type"],
            "source_count": source_group["source_count"],
            "classification_counts": source_counts,
            "records": records,
        })
    total_records = sum(group["source_count"] for group in source["sources"])
    manifest = {
        "schema_version": 1,
        "backup_set_id": source["backup_set_id"],
        "source_snapshot_digest": source["source_snapshot_digest"],
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "policy": {
            "policy_id": policy["policy_id"],
            "policy_version": policy["policy_version"],
            "policy_sha256": sha256_bytes(canonical_json_bytes(policy)),
        },
        "identifier_protection": deepcopy(source["identifier_protection"]),
        "sources": output_sources,
        "totals": {
            "source_count": total_records,
            "classification_counts": total_counts,
        },
    }
    validate_classification_manifest_structure(manifest, policy)
    return manifest


def validate_classification_manifest_structure(value: Any, policy: Any) -> dict[str, Any]:
    policy = validate_classification_policy(policy)
    manifest = _expect_mapping(value, "classification manifest")
    _expect_exact_keys(manifest, {"schema_version", "backup_set_id", "source_snapshot_digest", "generated_at", "policy", "identifier_protection", "sources", "totals"}, "classification manifest")
    if manifest["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported classification manifest schema version")
    _expect_safe_text(manifest["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_sha256(manifest["source_snapshot_digest"], "classification snapshot digest")
    _expect_timestamp(manifest["generated_at"], "classification generation timestamp")
    policy_ref = _expect_mapping(manifest["policy"], "classification policy reference")
    _expect_exact_keys(policy_ref, {"policy_id", "policy_version", "policy_sha256"}, "classification policy reference")
    if policy_ref["policy_id"] != policy["policy_id"] or policy_ref["policy_version"] != policy["policy_version"]:
        raise RecoveryToolingError("Classification manifest references the wrong policy")
    if policy_ref["policy_sha256"] != sha256_bytes(canonical_json_bytes(policy)):
        raise RecoveryToolingError("Classification policy digest does not match")

    protection = _expect_mapping(manifest["identifier_protection"], "identifier protection")
    _expect_exact_keys(protection, {"email_strategy", "key_id"}, "identifier protection")
    if protection != {"email_strategy": "omitted", "key_id": None}:
        raise RecoveryToolingError("Classification manifests must omit email-derived identifiers")

    expected_sources = set(policy["source_types"])
    seen_sources: set[str] = set()
    labels = set(policy["labels"])
    computed_totals = {label: 0 for label in policy["labels"]}
    total_records = 0
    if not isinstance(manifest["sources"], list):
        raise RecoveryToolingError("Classification manifest sources must be a list")
    for source in manifest["sources"]:
        item = _expect_mapping(source, "classification manifest source")
        _expect_exact_keys(item, {"source_type", "source_count", "classification_counts", "records"}, "classification manifest source")
        source_type = _expect_safe_text(item["source_type"], "classification source type")
        if source_type not in expected_sources or source_type in seen_sources:
            raise RecoveryToolingError("Classification manifest source coverage is invalid")
        seen_sources.add(source_type)
        source_count = _expect_int(item["source_count"], "classification manifest source count")
        if not isinstance(item["records"], list) or source_count != len(item["records"]):
            raise RecoveryToolingError("Classification manifest source total is inconsistent")
        counts = _expect_mapping(item["classification_counts"], "classification partition counts")
        if set(counts) != labels:
            raise RecoveryToolingError("Classification partition is incomplete")
        for label in policy["labels"]:
            _expect_int(counts[label], f"classification count for {label}")
        computed_source = {label: 0 for label in policy["labels"]}
        record_ids: set[str] = set()
        for record in item["records"]:
            row = _expect_mapping(record, "classified record")
            allowed_keys = {"record_id", "evidence", "evidence_fingerprint", "classification", "rule_id", "reason_code"}
            _expect_exact_keys(row, allowed_keys, "classified record")
            record_id = _expect_record_id(
                row["record_id"], "classification record id", source_type
            )
            if record_id in record_ids:
                raise RecoveryToolingError("Classified record ids must be unique per source")
            record_ids.add(record_id)
            evidence = _expect_string_list(row["evidence"], "classified evidence")
            if not set(evidence).issubset(set(policy["allowed_evidence_markers"])):
                raise RecoveryToolingError("Classified record contains unapproved evidence")
            if row["evidence_fingerprint"] != sha256_bytes(canonical_json_bytes(sorted(evidence))):
                raise RecoveryToolingError("Classified evidence fingerprint does not match")
            expected = _classify_record({"evidence": evidence}, policy, source_type)
            if any(row[key] != expected[key] for key in ("classification", "rule_id", "reason_code")):
                raise RecoveryToolingError("Classified record does not follow the approved policy")
            if row["classification"] not in labels:
                raise RecoveryToolingError("Classified record uses an unsupported label")
            computed_source[row["classification"]] += 1
            computed_totals[row["classification"]] += 1
        if counts != computed_source or sum(counts.values()) != source_count:
            raise RecoveryToolingError("Classification counts do not form a total partition")
        total_records += source_count
    if seen_sources != expected_sources:
        raise RecoveryToolingError("Classification manifest must cover every source type")
    totals = _expect_mapping(manifest["totals"], "classification totals")
    _expect_exact_keys(totals, {"source_count", "classification_counts"}, "classification totals")
    total_source_count = _expect_int(totals["source_count"], "classification total source count")
    total_counts = _expect_mapping(totals["classification_counts"], "classification total partition counts")
    if set(total_counts) != labels:
        raise RecoveryToolingError("Classification total partition is incomplete")
    for label in policy["labels"]:
        _expect_int(total_counts[label], f"classification total count for {label}")
    if total_source_count != total_records or total_counts != computed_totals:
        raise RecoveryToolingError("Classification totals are inconsistent")
    _reject_sensitive_keys(manifest)
    return manifest


def verify_classification_manifest(source: Any, manifest: Any, policy: Any) -> None:
    expected = build_classification_manifest(source, policy, generated_at=manifest.get("generated_at") if isinstance(manifest, dict) else None)
    validate_classification_manifest_structure(manifest, policy)
    if canonical_json_bytes(expected) != canonical_json_bytes(manifest):
        raise RecoveryToolingError("Classification manifest does not exactly partition its source")


def validate_provider_receipt(value: Any, expected_names: set[str] | None = None) -> dict[str, Any]:
    receipt = _expect_mapping(value, "provider download receipt")
    _expect_exact_keys(receipt, {"schema_version", "evidence_scope", "backup_set_id", "provider", "container_id", "object_set_id", "downloaded_at", "operator_id", "expected_manifest_sha256", "objects"}, "provider download receipt")
    if receipt["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported provider receipt schema version")
    if receipt["evidence_scope"] != "untrusted_adapter_attestation":
        raise RecoveryToolingError("Generic provider receipts must not claim trusted provider origin")
    _expect_safe_text(receipt["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    provider = _expect_safe_text(receipt["provider"], "provider id")
    if len(provider) < 2:
        raise RecoveryToolingError("Provider id is too short")
    if provider.lower() in {"file", "filesystem", "local", "local-copy", "synced-folder"}:
        raise RecoveryToolingError("A local filesystem is not valid off-site evidence")
    for label in ("container_id", "object_set_id", "operator_id"):
        value_text = receipt[label]
        if (
            not isinstance(value_text, str)
            or not value_text.strip()
            or len(value_text) > 256
            or any(character in value_text for character in "\r\n?#@")
            or value_text.startswith("/")
            or value_text.lower().startswith("file:")
            or ".." in value_text.split("/")
        ):
            raise RecoveryToolingError(f"Provider receipt {label} is malformed or credential-bearing")
    _expect_timestamp(receipt["downloaded_at"], "provider download timestamp")
    _expect_sha256(receipt["expected_manifest_sha256"], "expected encrypted manifest digest")
    if not isinstance(receipt["objects"], list) or not receipt["objects"]:
        raise RecoveryToolingError("Provider receipt must inventory downloaded objects")
    names: set[str] = set()
    object_ids: set[str] = set()
    for entry in receipt["objects"]:
        item = _expect_mapping(entry, "provider object receipt")
        _expect_exact_keys(item, {"name", "object_id", "version_id", "size_bytes", "sha256"}, "provider object receipt")
        name = item["name"]
        if name not in set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME} or name in names:
            raise RecoveryToolingError("Provider receipt object inventory is duplicated or unsupported")
        names.add(name)
        for label in ("object_id", "version_id"):
            _expect_safe_text(item[label], f"provider object {label}")
        if item["object_id"] in object_ids:
            raise RecoveryToolingError(
                "Provider receipt artifacts must identify distinct provider objects"
            )
        object_ids.add(item["object_id"])
        _expect_int(item["size_bytes"], "provider object size", minimum=1)
        _expect_sha256(item["sha256"], "provider object SHA-256")
    if expected_names is None:
        expected_names = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    if names != expected_names:
        raise RecoveryToolingError("Provider receipt does not exactly cover the backup set")
    _reject_sensitive_keys(receipt)
    return receipt


def compute_snapshot_digest(
    plaintext_artifacts: Mapping[str, Mapping[str, Any]],
) -> str:
    if set(plaintext_artifacts) != set(SNAPSHOT_PAYLOAD_ARTIFACTS):
        raise RecoveryToolingError("Snapshot digest requires every canonical payload artifact")
    bindings: list[dict[str, Any]] = []
    for name in SNAPSHOT_PAYLOAD_ARTIFACTS:
        item = plaintext_artifacts[name]
        size = _expect_int(item.get("plaintext_size_bytes"), "snapshot plaintext size", minimum=1)
        digest = _expect_sha256(item.get("plaintext_sha256"), "snapshot plaintext digest")
        bindings.append({
            "name": name,
            "plaintext_size_bytes": size,
            "plaintext_sha256": digest,
        })
    return sha256_bytes(canonical_json_bytes(bindings))


def _validate_cross_contract_bindings(
    project_config: Mapping[str, Any],
    integrity: Mapping[str, Any],
) -> None:
    project_buckets = {item["id"]: item for item in project_config["storage"]["buckets"]}
    integrity_buckets = {item["id"]: item for item in integrity["storage"]["buckets"]}
    if set(project_buckets) != set(integrity_buckets):
        raise RecoveryToolingError("Project and integrity contracts must cover the same Storage buckets")
    for bucket_id, project_bucket in project_buckets.items():
        expected_digest = sha256_bytes(canonical_json_bytes(project_bucket))
        if integrity_buckets[bucket_id]["configuration_digest"] != expected_digest:
            raise RecoveryToolingError("Storage configuration digest is not bound to the project contract")
    if project_config["data_api"]["grants_digest"] != integrity["catalog"]["grants_digest"]:
        raise RecoveryToolingError("Project and integrity grants digests do not match")
    if sorted(project_config["realtime"]["publications"]) != sorted(integrity["catalog"]["publications"]):
        raise RecoveryToolingError("Project and integrity Realtime publication inventories do not match")


def build_backup_manifest(
    metadata: Any,
    backup_dir: Path,
    plaintext_contracts: Mapping[str, Any],
    policy: Any,
    plaintext_artifacts: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    backup_dir = require_private_backup_directory(backup_dir)
    require_exact_inventory(backup_dir, include_manifest=False)
    metadata = validate_backup_metadata(metadata)
    if set(plaintext_artifacts) != set(REQUIRED_ENCRYPTED_ARTIFACTS):
        raise RecoveryToolingError("Every encrypted artifact requires a measured plaintext binding")
    for name, binding in plaintext_artifacts.items():
        _expect_exact_keys(
            binding,
            {"plaintext_size_bytes", "plaintext_sha256"},
            f"plaintext binding for {name}",
        )
        _expect_int(binding["plaintext_size_bytes"], "artifact plaintext size", minimum=1)
        _expect_sha256(binding["plaintext_sha256"], "artifact plaintext digest")
    expected_contracts = set(CONTRACT_ARTIFACTS.values())
    if set(plaintext_contracts) != expected_contracts:
        raise RecoveryToolingError("Every encrypted JSON contract requires matching reviewed plaintext")
    contract_hashes: dict[str, str] = {}
    for artifact_name, kind in CONTRACT_ARTIFACTS.items():
        contract = plaintext_contracts[kind]
        validate_contract(kind, contract, policy=policy)
        if contract.get("backup_set_id") != metadata["backup_set_id"]:
            raise RecoveryToolingError("Recovery contracts must share the backup-set id")
        contract_hashes[artifact_name] = sha256_bytes(canonical_json_bytes(contract))
    if plaintext_contracts["restore-integrity"]["database_snapshot_digest"] != metadata["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Integrity manifest must match the database snapshot")
    snapshot_bindings = {
        name: plaintext_artifacts[name] for name in SNAPSHOT_PAYLOAD_ARTIFACTS
    }
    measured_snapshot_digest = compute_snapshot_digest(snapshot_bindings)
    if metadata["source"]["database_snapshot_digest"] != measured_snapshot_digest:
        raise RecoveryToolingError("Backup snapshot digest is not derived from the measured plaintext artifacts")
    integrity_bindings = {
        item["name"]: {
            "plaintext_size_bytes": item["plaintext_size_bytes"],
            "plaintext_sha256": item["plaintext_sha256"],
        }
        for item in plaintext_contracts["restore-integrity"]["snapshot_artifacts"]
    }
    if integrity_bindings != snapshot_bindings:
        raise RecoveryToolingError("Integrity snapshot bindings do not match the decrypted artifact bytes")
    if plaintext_contracts["restore-integrity"]["migration_history"]["digest"] != metadata["source"]["remote_migration_history_digest"]:
        raise RecoveryToolingError("Integrity manifest must match the remote migration-history digest")
    if plaintext_contracts["project-config"]["source_project_ref"] != metadata["source"]["project_ref"]:
        raise RecoveryToolingError("Project configuration must match the backup source project")
    for kind in ("project-config", "restore-integrity", "classification-source"):
        if plaintext_contracts[kind]["captured_at"] != metadata["source"]["captured_at"]:
            raise RecoveryToolingError("Recovery contracts must share the backup capture timestamp")
    if plaintext_contracts["classification-manifest"]["source_snapshot_digest"] != metadata["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Classification manifest must match the database snapshot")
    if plaintext_contracts["classification-source"]["source_snapshot_digest"] != metadata["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Classification source must match the database snapshot")
    verify_classification_manifest(
        plaintext_contracts["classification-source"],
        plaintext_contracts["classification-manifest"],
        policy,
    )
    _validate_cross_contract_bindings(
        plaintext_contracts["project-config"],
        plaintext_contracts["restore-integrity"],
    )

    artifacts: list[dict[str, Any]] = []
    for name, role in REQUIRED_ENCRYPTED_ARTIFACTS.items():
        path = backup_dir / name
        ciphertext = measure_private_file(path, encrypted=True)
        entry: dict[str, Any] = {
            "name": name,
            "role": role,
            "size_bytes": ciphertext["size_bytes"],
            "sha256": ciphertext["sha256"],
            "plaintext_size_bytes": plaintext_artifacts[name]["plaintext_size_bytes"],
            "plaintext_sha256": plaintext_artifacts[name]["plaintext_sha256"],
        }
        if name in contract_hashes:
            entry["plaintext_contract_sha256"] = contract_hashes[name]
        artifacts.append(entry)
    return {
        "schema_version": 1,
        "backup_set_id": metadata["backup_set_id"],
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": deepcopy(metadata["source"]),
        "tools": deepcopy(metadata["tools"]),
        "encryption": deepcopy(metadata["encryption"]),
        "retention_class": metadata["retention_class"],
        "artifacts": artifacts,
    }


def validate_backup_manifest(value: Any) -> dict[str, Any]:
    manifest = _expect_mapping(value, "backup-set manifest")
    _expect_exact_keys(manifest, {"schema_version", "backup_set_id", "created_at", "source", "tools", "encryption", "retention_class", "artifacts"}, "backup-set manifest")
    validate_backup_metadata({key: manifest[key] for key in ("schema_version", "backup_set_id", "source", "tools", "encryption", "retention_class")})
    _expect_timestamp(manifest["created_at"], "backup manifest creation timestamp")
    if not isinstance(manifest["artifacts"], list):
        raise RecoveryToolingError("Backup manifest artifacts must be a list")
    artifacts: dict[str, dict[str, Any]] = {}
    for artifact in manifest["artifacts"]:
        item = _expect_mapping(artifact, "backup artifact")
        expected_keys = {
            "name",
            "role",
            "size_bytes",
            "sha256",
            "plaintext_size_bytes",
            "plaintext_sha256",
        }
        if item.get("name") in CONTRACT_ARTIFACTS:
            expected_keys.add("plaintext_contract_sha256")
        _expect_exact_keys(item, expected_keys, "backup artifact")
        name = item["name"]
        if name not in REQUIRED_ENCRYPTED_ARTIFACTS or name in artifacts:
            raise RecoveryToolingError("Backup artifact inventory is duplicated or unsupported")
        if item["role"] != REQUIRED_ENCRYPTED_ARTIFACTS[name]:
            raise RecoveryToolingError("Backup artifact role does not match its canonical name")
        _expect_int(item["size_bytes"], "backup artifact size", minimum=1)
        _expect_sha256(item["sha256"], "backup artifact digest")
        _expect_int(item["plaintext_size_bytes"], "backup artifact plaintext size", minimum=1)
        _expect_sha256(item["plaintext_sha256"], "backup artifact plaintext digest")
        if name in CONTRACT_ARTIFACTS:
            _expect_sha256(item["plaintext_contract_sha256"], "plaintext contract digest")
        artifacts[name] = item
    if set(artifacts) != set(REQUIRED_ENCRYPTED_ARTIFACTS):
        raise RecoveryToolingError("Backup manifest does not contain the canonical artifact set")
    _reject_sensitive_keys(manifest)
    return manifest


def read_passphrase_fd(fd: int) -> bytes:
    if fd < 0:
        raise RecoveryToolingError("Passphrase file descriptor is invalid")
    try:
        with os.fdopen(os.dup(fd), "rb") as handle:
            value = handle.read(8193)
    except OSError as exc:
        raise RecoveryToolingError("Passphrase file descriptor could not be read") from exc
    if len(value) > 8192:
        raise RecoveryToolingError("Passphrase input is unexpectedly large")
    if value.endswith(b"\r\n"):
        value = value[:-2]
    elif value.endswith((b"\r", b"\n")):
        value = value[:-1]
    if not value or b"\n" in value or b"\r" in value or b"\0" in value:
        raise RecoveryToolingError("Passphrase input must contain exactly one non-empty line")
    return value


def encrypt_json(value: Any, output: Path, passphrase: bytes) -> None:
    if output.exists() or output.is_symlink():
        raise RecoveryToolingError("Refusing to overwrite an encrypted artifact")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (
        output.parent.is_symlink()
        or not output.parent.is_dir()
        or stat.S_IMODE(output.parent.stat().st_mode) & 0o077
    ):
        raise RecoveryToolingError("Encrypted output directory must be a locked non-symlink directory")
    old_umask = os.umask(0o077)
    encrypted: Path | None = None
    encrypted_fd: int | None = None
    passphrase_read_fd: int | None = None
    try:
        encrypted_fd, encrypted_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        encrypted = Path(encrypted_name)
        passphrase_read_fd, passphrase_write_fd = os.pipe()
        try:
            os.write(passphrase_write_fd, passphrase + b"\n")
        finally:
            os.close(passphrase_write_fd)
        try:
            result = subprocess.run(
                [
                    "gpg", "--no-options", "--batch", "--quiet", "--no-tty",
                    "--symmetric", "--force-aead",
                    "--aead-algo", "OCB", "--cipher-algo", "AES256",
                    "--s2k-mode", str(GPG_S2K_MODE),
                    "--s2k-digest-algo", "SHA512",
                    "--s2k-count", str(GPG_S2K_COUNT),
                    "--chunk-size", str(GPG_AEAD_CHUNK_SIZE),
                    "--pinentry-mode", "loopback",
                    "--passphrase-fd", str(passphrase_read_fd),
                    "--output", "-",
                ],
                input=canonical_json_bytes(value),
                pass_fds=(passphrase_read_fd,),
                stdout=encrypted_fd,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError as exc:
            raise RecoveryToolingError("GPG could not encrypt the backup manifest") from exc
        finally:
            os.close(passphrase_read_fd)
            passphrase_read_fd = None
        if result.returncode != 0:
            raise RecoveryToolingError("GPG could not encrypt the backup manifest")
        os.fchmod(encrypted_fd, 0o600)
        os.fsync(encrypted_fd)
        os.close(encrypted_fd)
        encrypted_fd = None
        _publish_private_file_noreplace(encrypted, output)
        encrypted = None
    finally:
        os.umask(old_umask)
        if passphrase_read_fd is not None:
            os.close(passphrase_read_fd)
        if encrypted_fd is not None:
            os.close(encrypted_fd)
        if encrypted is not None:
            encrypted.unlink(missing_ok=True)


def _gpg_artifact_command(
    path: Path,
    passphrase: bytes | None,
    command: list[str],
    *,
    stdout: Any,
    text: bool = False,
    max_input_bytes: int | None = None,
) -> subprocess.CompletedProcess[Any]:
    artifact_fd, before = _open_private_regular_file(path, encrypted=True)
    if max_input_bytes is not None and before.st_size > max_input_bytes:
        os.close(artifact_fd)
        raise RecoveryToolingError("Encrypted JSON contract exceeds the allowed size")
    passphrase_read_fd: int | None = None
    pass_fds = [artifact_fd]
    arguments = list(command)
    if passphrase is not None:
        passphrase_read_fd, passphrase_write_fd = os.pipe()
        try:
            os.write(passphrase_write_fd, passphrase + b"\n")
        finally:
            os.close(passphrase_write_fd)
        pass_fds.append(passphrase_read_fd)
        arguments.extend([
            "--pinentry-mode", "loopback",
            "--passphrase-fd", str(passphrase_read_fd),
        ])
    arguments.append(f"/dev/fd/{artifact_fd}")
    try:
        try:
            result = subprocess.run(
                arguments,
                pass_fds=tuple(pass_fds),
                stdout=stdout,
                stderr=subprocess.DEVNULL,
                check=False,
                text=text,
                env={**os.environ, "LC_ALL": "C"},
            )
        except OSError as exc:
            raise RecoveryToolingError("GPG could not process an encrypted recovery artifact") from exc
        finally:
            if passphrase_read_fd is not None:
                os.close(passphrase_read_fd)
        _assert_unchanged_fd(artifact_fd, before)
        return result
    finally:
        os.close(artifact_fd)


def decrypt_json(path: Path, passphrase: bytes) -> Any:
    result = _gpg_artifact_command(
        path,
        passphrase,
        ["gpg", "--no-options", "--batch", "--quiet", "--no-tty", "--decrypt", "--output", "-"],
        stdout=subprocess.PIPE,
        max_input_bytes=32 * 1024 * 1024,
    )
    if result.returncode != 0:
        raise RecoveryToolingError("Encrypted JSON contract could not be authenticated and decrypted")
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RecoveryToolingError("Decrypted JSON contract exceeds the allowed size")
    try:
        return json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryToolingError("Decrypted JSON contract is malformed") from exc


def validate_encryption_packet_profile(path: Path) -> None:
    """Fail closed unless GnuPG reports the complete canonical encryption profile."""
    result = _gpg_artifact_command(
        path,
        None,
        ["gpg", "--no-options", "--batch", "--no-tty", "--list-only", "--list-packets"],
        stdout=subprocess.PIPE,
        text=True,
    )
    packet_summary = result.stdout
    if (
        result.returncode != 0
        or len(packet_summary) > 16 * 1024
        or packet_summary.count(":symkey enc packet:") != 1
        or packet_summary.count(":aead encrypted packet:") != 1
        or packet_summary.count("# off=") != 2
        or (
            f":symkey enc packet: version 5, cipher 9, aead 2, "
            f"s2k {GPG_S2K_MODE}, hash {GPG_S2K_DIGEST_ID},"
        ) not in packet_summary
        or not re.search(
            rf"\bsalt [0-9A-F]{{16}}, count {GPG_S2K_COUNT} \(255\)$",
            packet_summary,
            re.MULTILINE,
        )
        or f":aead encrypted packet: cipher=9 aead=2 cb={GPG_PACKET_CHUNK_BYTE}" not in packet_summary
    ):
        raise RecoveryToolingError(
            "Encrypted artifact is not canonical GPG AES-256 OCB AEAD with strong iterated SHA-512 S2K"
        )


def measure_decrypted_artifact(path: Path, passphrase: bytes) -> dict[str, Any]:
    """Return a streaming plaintext size/digest without materializing plaintext on disk."""
    artifact_fd, before = _open_private_regular_file(path, encrypted=True)
    passphrase_read_fd, passphrase_write_fd = os.pipe()
    try:
        os.write(passphrase_write_fd, passphrase + b"\n")
    finally:
        os.close(passphrase_write_fd)
    try:
        process = subprocess.Popen(
            [
                "gpg", "--no-options", "--batch", "--quiet", "--no-tty", "--decrypt",
                "--pinentry-mode", "loopback", "--passphrase-fd", str(passphrase_read_fd),
                "--output", "-", f"/dev/fd/{artifact_fd}",
            ],
            pass_fds=(artifact_fd, passphrase_read_fd),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C"},
        )
    except OSError as exc:
        os.close(passphrase_read_fd)
        os.close(artifact_fd)
        raise RecoveryToolingError("GPG could not measure an encrypted recovery artifact") from exc
    os.close(passphrase_read_fd)
    digest = hashlib.sha256()
    size = 0
    assert process.stdout is not None
    for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
        digest.update(chunk)
        size += len(chunk)
    process.stdout.close()
    return_code = process.wait()
    try:
        _assert_unchanged_fd(artifact_fd, before)
    finally:
        os.close(artifact_fd)
    if return_code != 0 or size < 1:
        raise RecoveryToolingError("Encrypted artifact could not be authenticated and measured")
    return {
        "plaintext_size_bytes": size,
        "plaintext_sha256": f"sha256:{digest.hexdigest()}",
    }


def assert_not_known_local_source(candidate: Path, known_local_source: Path, artifact_names: Iterable[str]) -> None:
    if candidate.is_symlink() or known_local_source.is_symlink():
        raise RecoveryToolingError("Recovery source directories must not be symlinks")
    try:
        candidate_real = candidate.resolve(strict=True)
        source_real = known_local_source.resolve(strict=True)
    except OSError as exc:
        raise RecoveryToolingError("Recovery source directories could not be resolved") from exc
    if candidate_real == source_real or source_real in candidate_real.parents or candidate_real in source_real.parents:
        raise RecoveryToolingError("Provider recovery evidence cannot use the known local source path")
    for name in artifact_names:
        candidate_file = candidate_real / name
        source_file = source_real / name
        if source_file.exists() and candidate_file.exists() and os.path.samefile(candidate_file, source_file):
            raise RecoveryToolingError("Provider recovery evidence cannot use hardlinks to local source artifacts")


@contextmanager
def private_backup_snapshot(
    source_dir: Path,
    *,
    include_provider_receipt: bool,
) -> Iterable[Path]:
    """Copy a held, exact source inventory into a private immutable verification snapshot."""
    source_dir = require_private_backup_directory(source_dir)
    require_exact_inventory(
        source_dir,
        include_manifest=True,
        include_provider_receipt=include_provider_receipt,
    )
    expected = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    if include_provider_receipt:
        expected.add(PROVIDER_RECEIPT_NAME)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(source_dir, directory_flags)
    except OSError as exc:
        raise RecoveryToolingError("Backup directory could not be held for verification") from exc
    held: dict[str, tuple[int, os.stat_result]] = {}
    temporary = tempfile.TemporaryDirectory(prefix="koaryu-recovery-snapshot-")
    snapshot = Path(temporary.name)
    os.chmod(snapshot, 0o700)
    try:
        try:
            if set(os.listdir(directory_fd)) != expected:
                raise RecoveryToolingError("Backup inventory changed before verification")
            for name in sorted(expected):
                flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                try:
                    descriptor = os.open(name, flags, dir_fd=directory_fd)
                except OSError as exc:
                    raise RecoveryToolingError("Backup artifact could not be held for verification") from exc
                details = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) & 0o077
                ):
                    os.close(descriptor)
                    raise RecoveryToolingError("Backup artifacts must be private singly linked regular files")
                held[name] = (descriptor, details)

            for name in sorted(expected):
                source_fd, before = held[name]
                destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
                destination_fd = os.open(snapshot / name, destination_flags, 0o600)
                try:
                    os.lseek(source_fd, 0, os.SEEK_SET)
                    while True:
                        chunk = os.read(source_fd, 1024 * 1024)
                        if not chunk:
                            break
                        view = memoryview(chunk)
                        while view:
                            written = os.write(destination_fd, view)
                            view = view[written:]
                    os.fsync(destination_fd)
                finally:
                    os.close(destination_fd)
                _assert_unchanged_fd(source_fd, before)

            if set(os.listdir(directory_fd)) != expected:
                raise RecoveryToolingError("Backup inventory changed during verification snapshot creation")
            for name, (descriptor, before) in held.items():
                try:
                    current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                except OSError as exc:
                    raise RecoveryToolingError("Backup artifact identity changed during snapshot creation") from exc
                if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                    raise RecoveryToolingError("Backup artifact identity changed during snapshot creation")
                _assert_unchanged_fd(descriptor, before)
            _fsync_directory(snapshot)
            for path in snapshot.iterdir():
                os.chmod(path, 0o400)
            os.chmod(snapshot, 0o500)
            yield snapshot
        finally:
            for descriptor, _ in held.values():
                os.close(descriptor)
            os.close(directory_fd)
    finally:
        os.chmod(snapshot, 0o700)
        for path in snapshot.iterdir():
            os.chmod(path, 0o600)
        temporary.cleanup()


def verify_backup_set(
    backup_dir: Path,
    passphrase: bytes,
    policy: Any,
    *,
    receipt: Any | None = None,
    known_local_source: Path | None = None,
    expected_manifest_sha256: str | None = None,
) -> dict[str, Any]:
    backup_dir = require_private_backup_directory(backup_dir)
    expected_names = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    validated_receipt: dict[str, Any] | None = None
    if receipt is not None:
        if known_local_source is None or expected_manifest_sha256 is None:
            raise RecoveryToolingError(
                "Provider-receipt verification requires a known source and independently recorded manifest digest"
            )
        validated_receipt = validate_provider_receipt(receipt, expected_names)
        assert_not_known_local_source(backup_dir, known_local_source, expected_names)
    elif known_local_source is not None:
        raise RecoveryToolingError("Known local source was supplied without provider receipt evidence")

    with private_backup_snapshot(
        backup_dir,
        include_provider_receipt=validated_receipt is not None,
    ) as snapshot:
        if validated_receipt is not None:
            snapshot_receipt = validate_provider_receipt(
                load_json(snapshot / PROVIDER_RECEIPT_NAME, require_private=True),
                expected_names,
            )
            if canonical_json_bytes(snapshot_receipt) != canonical_json_bytes(validated_receipt):
                raise RecoveryToolingError("Provider receipt input does not match the locked download receipt")
        return _verify_backup_snapshot(
            snapshot,
            passphrase,
            policy,
            validated_receipt=validated_receipt,
            expected_manifest_sha256=expected_manifest_sha256,
        )


def _verify_backup_snapshot(
    backup_dir: Path,
    passphrase: bytes,
    policy: Any,
    *,
    validated_receipt: Mapping[str, Any] | None,
    expected_manifest_sha256: str | None,
) -> dict[str, Any]:
    expected_names = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    for artifact_name in expected_names:
        validate_encryption_packet_profile(backup_dir / artifact_name)
    manifest_path = backup_dir / BACKUP_MANIFEST_NAME
    manifest_digest = sha256_file(manifest_path)
    if expected_manifest_sha256 is not None and manifest_digest != _expect_sha256(expected_manifest_sha256, "expected manifest digest"):
        raise RecoveryToolingError("Encrypted backup manifest does not match the recorded digest")
    manifest = validate_backup_manifest(decrypt_json(manifest_path, passphrase))
    artifacts = {entry["name"]: entry for entry in manifest["artifacts"]}

    for name, entry in artifacts.items():
        path = backup_dir / name
        ciphertext = measure_private_file(path, encrypted=True)
        if ciphertext["size_bytes"] != entry["size_bytes"] or ciphertext["sha256"] != entry["sha256"]:
            raise RecoveryToolingError("Backup artifact size or digest does not match the encrypted manifest")

    plaintext_measurements: dict[str, dict[str, Any]] = {}
    for artifact_name in REQUIRED_ENCRYPTED_ARTIFACTS:
        measurement = measure_decrypted_artifact(backup_dir / artifact_name, passphrase)
        entry = artifacts[artifact_name]
        if (
            measurement["plaintext_size_bytes"] != entry["plaintext_size_bytes"]
            or measurement["plaintext_sha256"] != entry["plaintext_sha256"]
        ):
            raise RecoveryToolingError("Decrypted artifact does not match its plaintext binding")
        plaintext_measurements[artifact_name] = measurement

    contracts: dict[str, dict[str, Any]] = {}
    for artifact_name, kind in CONTRACT_ARTIFACTS.items():
        contract = decrypt_json(backup_dir / artifact_name, passphrase)
        validate_contract(kind, contract, policy=policy)
        entry = artifacts[artifact_name]
        if sha256_bytes(canonical_json_bytes(contract)) != entry["plaintext_contract_sha256"]:
            raise RecoveryToolingError("Decrypted contract digest does not match the encrypted manifest")
        if entry["plaintext_sha256"] != entry["plaintext_contract_sha256"]:
            raise RecoveryToolingError("Encrypted JSON contract is not canonical or is bound inconsistently")
        if contract["backup_set_id"] != manifest["backup_set_id"]:
            raise RecoveryToolingError("Decrypted recovery contracts do not belong to this backup set")
        contracts[kind] = contract

    integrity = contracts["restore-integrity"]
    measured_snapshot_digest = compute_snapshot_digest({
        name: plaintext_measurements[name] for name in SNAPSHOT_PAYLOAD_ARTIFACTS
    })
    if measured_snapshot_digest != manifest["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Measured plaintext snapshot does not match the backup manifest")
    if integrity["database_snapshot_digest"] != manifest["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Integrity contract does not match the backup snapshot")
    if integrity["migration_history"]["digest"] != manifest["source"]["remote_migration_history_digest"]:
        raise RecoveryToolingError("Migration history contract does not match the backup manifest")
    if contracts["project-config"]["source_project_ref"] != manifest["source"]["project_ref"]:
        raise RecoveryToolingError("Project configuration contract does not match the backup source")
    for kind in ("project-config", "restore-integrity", "classification-source"):
        if contracts[kind]["captured_at"] != manifest["source"]["captured_at"]:
            raise RecoveryToolingError("Recovery contract capture timestamp does not match the backup manifest")
    if contracts["classification-manifest"]["source_snapshot_digest"] != manifest["source"]["database_snapshot_digest"]:
        raise RecoveryToolingError("Classification contract does not match the backup snapshot")
    verify_classification_manifest(
        contracts["classification-source"],
        contracts["classification-manifest"],
        policy,
    )
    integrity_bindings = {
        item["name"]: {
            "plaintext_size_bytes": item["plaintext_size_bytes"],
            "plaintext_sha256": item["plaintext_sha256"],
        }
        for item in integrity["snapshot_artifacts"]
    }
    if integrity_bindings != {
        name: plaintext_measurements[name] for name in SNAPSHOT_PAYLOAD_ARTIFACTS
    }:
        raise RecoveryToolingError("Integrity contract is not bound to the measured snapshot artifacts")
    _validate_cross_contract_bindings(contracts["project-config"], integrity)

    receipt_matches_bytes = False
    if validated_receipt is not None:
        if validated_receipt["backup_set_id"] != manifest["backup_set_id"]:
            raise RecoveryToolingError("Provider receipt identifies a different backup set")
        if validated_receipt["expected_manifest_sha256"] != manifest_digest:
            raise RecoveryToolingError("Provider receipt does not match the encrypted manifest digest")
        receipt_objects = {item["name"]: item for item in validated_receipt["objects"]}
        for name in expected_names:
            path = backup_dir / name
            ciphertext = measure_private_file(path, encrypted=True)
            if receipt_objects[name]["size_bytes"] != ciphertext["size_bytes"] or receipt_objects[name]["sha256"] != ciphertext["sha256"]:
                raise RecoveryToolingError("Provider receipt object evidence does not match the downloaded bytes")
        receipt_matches_bytes = True

    return {
        "backup_set_id": manifest["backup_set_id"],
        "artifact_count": len(expected_names),
        "manifest_sha256": manifest_digest,
        # A receipt produced by the same generic adapter that supplied the bytes
        # is useful integrity evidence, but it is not independent provider-origin
        # proof. A reviewed provider-specific trust profile is intentionally absent.
        "provider_receipt_matches_bytes": receipt_matches_bytes,
        "provider_origin_verified": False,
    }


def validate_contract(kind: str, value: Any, *, policy: Any | None = None) -> dict[str, Any]:
    if kind == "backup-metadata":
        return validate_backup_metadata(value)
    if kind == "project-config":
        return validate_project_config(value)
    if kind == "restore-integrity":
        return validate_restore_integrity(value)
    if kind == "classification-source":
        if policy is None:
            raise RecoveryToolingError("Classification source validation requires a policy")
        return validate_classification_source(value, policy)
    if kind == "classification-manifest":
        if policy is None:
            raise RecoveryToolingError("Classification manifest validation requires a policy")
        return validate_classification_manifest_structure(value, policy)
    if kind == "provider-receipt":
        return validate_provider_receipt(value)
    raise RecoveryToolingError("Unsupported recovery contract kind")
