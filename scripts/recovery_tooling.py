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
RECORD_ID_RE = re.compile(r"^(?=.{8,128}$)(?=.*[0-9])[A-Za-z0-9][A-Za-z0-9._:-]*$")
BARE_SHA256_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
PROJECT_REF_RE = re.compile(r"^[a-z]{20}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MIGRATION_HEAD_RE = re.compile(r"^[0-9]{14}_[a-z0-9_]+\.sql$")
EMAIL_HMAC_RE = re.compile(r"^hmac-sha256:([A-Za-z0-9][A-Za-z0-9._:-]{2,127}):[0-9a-f]{64}$")

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


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_file(path: Path) -> str:
    _require_private_regular_file(path, encrypted=path.suffix == ".gpg")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def load_json(
    path: Path,
    *,
    max_bytes: int = 16 * 1024 * 1024,
    require_private: bool = False,
) -> Any:
    if require_private:
        _require_private_regular_file(path)
    elif path.is_symlink() or not path.is_file():
        raise RecoveryToolingError("JSON input must be a regular non-symlink file")
    elif stat.S_IMODE(path.stat().st_mode) & 0o022:
        raise RecoveryToolingError("Public JSON input must not be group- or world-writable")
    if path.stat().st_size > max_bytes:
        raise RecoveryToolingError("JSON contract exceeds the allowed size")
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryToolingError("JSON contract is unreadable or malformed") from exc


def write_private_json(path: Path, value: Any) -> None:
    if path.exists() or path.is_symlink():
        raise RecoveryToolingError("Refusing to overwrite an existing output")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
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
        os.replace(temporary, path)
        temporary = None
    finally:
        os.umask(old_umask)
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _require_private_regular_file(path: Path, *, encrypted: bool = False) -> None:
    if path.is_symlink() or not path.is_file():
        raise RecoveryToolingError("Recovery input must be a regular non-symlink file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        kind = "Encrypted artifact" if encrypted else "Recovery contract"
        raise RecoveryToolingError(f"{kind} must not be group- or world-accessible")


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


def require_exact_encrypted_inventory(backup_dir: Path, *, include_manifest: bool) -> None:
    expected = set(REQUIRED_ENCRYPTED_ARTIFACTS)
    if include_manifest:
        expected.add(BACKUP_MANIFEST_NAME)
    try:
        actual = {entry.name for entry in backup_dir.iterdir() if entry.name.endswith(".gpg")}
    except OSError as exc:
        raise RecoveryToolingError("Backup artifact inventory could not be read") from exc
    if actual != expected:
        raise RecoveryToolingError("Backup directory does not contain the exact canonical encrypted artifact set")


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


def _expect_record_id(value: Any, label: str) -> str:
    record_id = _expect_safe_text(value, label, pattern=RECORD_ID_RE)
    if BARE_SHA256_RE.fullmatch(record_id):
        raise RecoveryToolingError("Classification record ids must not be unkeyed SHA-256 values")
    return record_id


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
    _expect_exact_keys(encryption, {"scheme", "key_id"}, "encryption metadata")
    if encryption["scheme"] != "gpg-aes256-ocb":
        raise RecoveryToolingError("Backup manifest requires GPG AES-256 OCB")
    _expect_safe_text(encryption["key_id"], "encryption key id", pattern=KEY_ID_RE)
    _expect_safe_text(payload["retention_class"], "retention class")
    _reject_sensitive_keys(payload)
    return payload


def validate_project_config(value: Any) -> dict[str, Any]:
    payload = _expect_mapping(value, "project configuration manifest")
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "captured_at", "source_project_ref", "auth", "api_keys", "data_api", "realtime", "storage", "integrations"}, "project configuration manifest")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported project configuration schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_timestamp(payload["captured_at"], "project configuration capture timestamp")
    _expect_safe_text(payload["source_project_ref"], "source project ref", pattern=PROJECT_REF_RE)

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
    _expect_string_list(data_api["exposed_schemas"], "Data API schemas", allow_empty=False)
    _expect_bool(data_api["automatic_table_exposure"], "automatic table exposure")
    _expect_sha256(data_api["grants_digest"], "Data API grants digest")

    realtime = _expect_mapping(payload["realtime"], "Realtime configuration")
    _expect_exact_keys(realtime, {"publications"}, "Realtime configuration")
    _expect_string_list(realtime["publications"], "Realtime publications")

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
    _expect_exact_keys(payload, {"schema_version", "backup_set_id", "captured_at", "database_snapshot_digest", "migration_history", "tables", "catalog", "storage"}, "restore integrity manifest")
    if payload["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported restore integrity schema version")
    _expect_safe_text(payload["backup_set_id"], "backup_set_id", pattern=BACKUP_SET_ID_RE)
    _expect_timestamp(payload["captured_at"], "integrity capture timestamp")
    _expect_sha256(payload["database_snapshot_digest"], "database snapshot digest")

    history = _expect_mapping(payload["migration_history"], "migration history contract")
    _expect_exact_keys(history, {"row_count", "digest", "columns"}, "migration history contract")
    _expect_int(history["row_count"], "migration history row count")
    _expect_sha256(history["digest"], "migration history digest")
    columns = _expect_string_list(history["columns"], "migration history columns", allow_empty=False)
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
    _expect_string_list(catalog["extensions"], "extension inventory")
    _expect_string_list(catalog["publications"], "publication inventory")

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
    _expect_safe_text(policy["fallback_rule_id"], "fallback rule id")
    _expect_safe_text(policy["ambiguous_rule_id"], "ambiguous rule id")
    labels = _expect_string_list(policy["labels"], "classification labels", allow_empty=False)
    if policy["default_label"] != "unknown" or "unknown" not in labels:
        raise RecoveryToolingError("Classification must fail closed to unknown")
    sources = _expect_string_list(policy["source_types"], "classification source types", allow_empty=False)
    evidence = set(_expect_string_list(policy["allowed_evidence_markers"], "approved evidence markers", allow_empty=False))
    if not isinstance(policy["rules"], list) or not policy["rules"]:
        raise RecoveryToolingError("Classification policy must define explicit rules")
    rule_ids: set[str] = {policy["fallback_rule_id"], policy["ambiguous_rule_id"]}
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
    if protection["email_strategy"] not in {"omitted", "hmac-sha256"}:
        raise RecoveryToolingError("Email identifiers must be omitted or keyed with HMAC-SHA-256")
    if protection["email_strategy"] == "hmac-sha256":
        key_id = _expect_safe_text(protection["key_id"], "email HMAC key id", pattern=KEY_ID_RE)
    elif protection["key_id"] is not None:
        raise RecoveryToolingError("Omitted email identifiers must not declare a key id")
    else:
        key_id = None

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
            if set(row) not in ({"record_id", "evidence"}, {"record_id", "email_hmac", "evidence"}):
                raise RecoveryToolingError("Classification record has missing or unsupported fields")
            record_id = _expect_record_id(row["record_id"], "classification record id")
            composite = (source_type, record_id)
            if composite in seen_records:
                raise RecoveryToolingError("Classification record identifiers must be unique per source")
            seen_records.add(composite)
            markers = set(_expect_string_list(row["evidence"], "classification evidence"))
            if not markers.issubset(allowed_evidence):
                raise RecoveryToolingError("Classification input contains unapproved evidence")
            email_hmac = row.get("email_hmac")
            if email_hmac is not None:
                if protection["email_strategy"] != "hmac-sha256" or not isinstance(email_hmac, str):
                    raise RecoveryToolingError("Email-derived identifiers must use the declared keyed HMAC")
                match = EMAIL_HMAC_RE.fullmatch(email_hmac)
                if not match or match.group(1) != key_id:
                    raise RecoveryToolingError("Email HMAC is malformed or uses the wrong key id")
    if seen_sources != expected_sources:
        raise RecoveryToolingError("Classification input must include every policy source type, including empty sources")
    _reject_sensitive_keys(payload, allow_email_hmac=True)
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
            if "email_hmac" in record:
                output["email_hmac"] = record["email_hmac"]
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
    if protection["email_strategy"] not in {"omitted", "hmac-sha256"}:
        raise RecoveryToolingError("Classification manifest uses unsafe email identifiers")
    key_id = protection["key_id"]
    if protection["email_strategy"] == "hmac-sha256":
        _expect_safe_text(key_id, "email HMAC key id", pattern=KEY_ID_RE)
    elif key_id is not None:
        raise RecoveryToolingError("Omitted emails must not declare an HMAC key")

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
            if "email_hmac" in row:
                allowed_keys.add("email_hmac")
            _expect_exact_keys(row, allowed_keys, "classified record")
            record_id = _expect_record_id(row["record_id"], "classification record id")
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
            if "email_hmac" in row:
                match = EMAIL_HMAC_RE.fullmatch(row["email_hmac"]) if isinstance(row["email_hmac"], str) else None
                if protection["email_strategy"] != "hmac-sha256" or not match or match.group(1) != key_id:
                    raise RecoveryToolingError("Classified email HMAC is invalid")
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
    _reject_sensitive_keys(manifest, allow_email_hmac=True)
    return manifest


def verify_classification_manifest(source: Any, manifest: Any, policy: Any) -> None:
    expected = build_classification_manifest(source, policy, generated_at=manifest.get("generated_at") if isinstance(manifest, dict) else None)
    validate_classification_manifest_structure(manifest, policy)
    if canonical_json_bytes(expected) != canonical_json_bytes(manifest):
        raise RecoveryToolingError("Classification manifest does not exactly partition its source")


def validate_provider_receipt(value: Any, expected_names: set[str] | None = None) -> dict[str, Any]:
    receipt = _expect_mapping(value, "provider download receipt")
    _expect_exact_keys(receipt, {"schema_version", "backup_set_id", "provider", "container_id", "object_set_id", "downloaded_at", "operator_id", "expected_manifest_sha256", "objects"}, "provider download receipt")
    if receipt["schema_version"] != 1:
        raise RecoveryToolingError("Unsupported provider receipt schema version")
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
            or value_text.startswith(("/", "file:"))
            or ".." in value_text.split("/")
        ):
            raise RecoveryToolingError(f"Provider receipt {label} is malformed or credential-bearing")
    _expect_timestamp(receipt["downloaded_at"], "provider download timestamp")
    _expect_sha256(receipt["expected_manifest_sha256"], "expected encrypted manifest digest")
    if not isinstance(receipt["objects"], list) or not receipt["objects"]:
        raise RecoveryToolingError("Provider receipt must inventory downloaded objects")
    names: set[str] = set()
    for entry in receipt["objects"]:
        item = _expect_mapping(entry, "provider object receipt")
        _expect_exact_keys(item, {"name", "object_id", "version_id", "size_bytes", "sha256"}, "provider object receipt")
        name = item["name"]
        if name not in set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME} or name in names:
            raise RecoveryToolingError("Provider receipt object inventory is duplicated or unsupported")
        names.add(name)
        for label in ("object_id", "version_id"):
            _expect_safe_text(item[label], f"provider object {label}")
        _expect_int(item["size_bytes"], "provider object size", minimum=1)
        _expect_sha256(item["sha256"], "provider object SHA-256")
    if expected_names is None:
        expected_names = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    if names != expected_names:
        raise RecoveryToolingError("Provider receipt does not exactly cover the backup set")
    _reject_sensitive_keys(receipt)
    return receipt


def build_backup_manifest(
    metadata: Any,
    backup_dir: Path,
    plaintext_contracts: Mapping[str, Any],
    policy: Any,
) -> dict[str, Any]:
    backup_dir = require_private_backup_directory(backup_dir)
    require_exact_encrypted_inventory(backup_dir, include_manifest=False)
    metadata = validate_backup_metadata(metadata)
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

    artifacts: list[dict[str, Any]] = []
    for name, role in REQUIRED_ENCRYPTED_ARTIFACTS.items():
        path = backup_dir / name
        digest = sha256_file(path)
        entry: dict[str, Any] = {
            "name": name,
            "role": role,
            "size_bytes": path.stat().st_size,
            "sha256": digest,
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
        expected_keys = {"name", "role", "size_bytes", "sha256"}
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
    value = value.rstrip(b"\r\n")
    if not value or b"\n" in value or b"\r" in value:
        raise RecoveryToolingError("Passphrase input must contain exactly one non-empty line")
    return value


def encrypt_json(value: Any, output: Path, passphrase: bytes) -> None:
    if output.exists() or output.is_symlink():
        raise RecoveryToolingError("Refusing to overwrite an encrypted artifact")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    old_umask = os.umask(0o077)
    plaintext: Path | None = None
    encrypted: Path | None = None
    try:
        descriptor, plaintext_name = tempfile.mkstemp(prefix=".manifest-", dir=output.parent)
        plaintext = Path(plaintext_name)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_json_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        encrypted = output.parent / f".{output.name}.{os.getpid()}.tmp"
        try:
            result = subprocess.run(
                [
                    "gpg", "--no-options", "--batch", "--quiet", "--no-tty",
                    "--symmetric", "--force-aead",
                    "--aead-algo", "OCB", "--cipher-algo", "AES256",
                    "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                    "--output", str(encrypted), str(plaintext),
                ],
                input=passphrase + b"\n",
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError as exc:
            raise RecoveryToolingError("GPG could not encrypt the backup manifest") from exc
        if result.returncode != 0 or not encrypted.is_file():
            raise RecoveryToolingError("GPG could not encrypt the backup manifest")
        os.chmod(encrypted, 0o600)
        os.replace(encrypted, output)
        encrypted = None
    finally:
        os.umask(old_umask)
        if plaintext is not None:
            plaintext.unlink(missing_ok=True)
        if encrypted is not None:
            encrypted.unlink(missing_ok=True)


def decrypt_json(path: Path, passphrase: bytes) -> Any:
    _require_private_regular_file(path, encrypted=True)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise RecoveryToolingError("Encrypted JSON contract exceeds the allowed size")
    try:
        result = subprocess.run(
            [
                "gpg", "--no-options", "--batch", "--quiet", "--no-tty",
                "--decrypt", "--pinentry-mode", "loopback",
                "--passphrase-fd", "0", "--output", "-", str(path),
            ],
            input=passphrase + b"\n",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError as exc:
        raise RecoveryToolingError("GPG could not decrypt the encrypted JSON contract") from exc
    if result.returncode != 0:
        raise RecoveryToolingError("Encrypted JSON contract could not be authenticated and decrypted")
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RecoveryToolingError("Decrypted JSON contract exceeds the allowed size")
    try:
        return json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryToolingError("Decrypted JSON contract is malformed") from exc


def validate_encryption_packet_profile(path: Path) -> None:
    """Fail closed unless GnuPG reports AES-256 (9) with OCB AEAD (2)."""
    _require_private_regular_file(path, encrypted=True)
    try:
        result = subprocess.run(
            [
                "gpg", "--no-options", "--batch", "--no-tty", "--list-only",
                "--list-packets", str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            env={**os.environ, "LC_ALL": "C"},
        )
    except OSError as exc:
        raise RecoveryToolingError("GPG could not inspect an encrypted artifact") from exc
    packet_summary = result.stdout
    if (
        result.returncode != 0
        or len(packet_summary) > 16 * 1024
        or packet_summary.count(":symkey enc packet:") != 1
        or packet_summary.count(":aead encrypted packet:") != 1
        or packet_summary.count("# off=") != 2
        or ":symkey enc packet: version 5, cipher 9, aead 2," not in packet_summary
        or ":aead encrypted packet: cipher=9 aead=2 " not in packet_summary
    ):
        raise RecoveryToolingError("Encrypted artifact is not canonical GPG AES-256 OCB AEAD")


def authenticate_encrypted_artifact(path: Path, passphrase: bytes) -> None:
    """Authenticate and decrypt an artifact to a sink without writing plaintext."""
    _require_private_regular_file(path, encrypted=True)
    try:
        result = subprocess.run(
            [
                "gpg", "--no-options", "--batch", "--quiet", "--no-tty",
                "--decrypt", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                "--output", "-", str(path),
            ],
            input=passphrase + b"\n",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError as exc:
        raise RecoveryToolingError("GPG could not authenticate an encrypted artifact") from exc
    if result.returncode != 0:
        raise RecoveryToolingError("Encrypted artifact could not be authenticated with the recovery key")


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
    require_exact_encrypted_inventory(backup_dir, include_manifest=True)
    expected_names = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {BACKUP_MANIFEST_NAME}
    for artifact_name in expected_names:
        validate_encryption_packet_profile(backup_dir / artifact_name)
    validated_receipt: dict[str, Any] | None = None
    if receipt is not None:
        if known_local_source is None or expected_manifest_sha256 is None:
            raise RecoveryToolingError(
                "Provider-origin verification requires a known source and independently recorded manifest digest"
            )
        validated_receipt = validate_provider_receipt(receipt, expected_names)
        assert_not_known_local_source(backup_dir, known_local_source, expected_names)
    elif known_local_source is not None:
        raise RecoveryToolingError("Known local source was supplied without provider receipt evidence")

    manifest_path = backup_dir / BACKUP_MANIFEST_NAME
    manifest_digest = sha256_file(manifest_path)
    if expected_manifest_sha256 is not None and manifest_digest != _expect_sha256(expected_manifest_sha256, "expected manifest digest"):
        raise RecoveryToolingError("Encrypted backup manifest does not match the recorded digest")
    manifest = validate_backup_manifest(decrypt_json(manifest_path, passphrase))
    artifacts = {entry["name"]: entry for entry in manifest["artifacts"]}

    for name, entry in artifacts.items():
        path = backup_dir / name
        if path.stat().st_size != entry["size_bytes"] or sha256_file(path) != entry["sha256"]:
            raise RecoveryToolingError("Backup artifact size or digest does not match the encrypted manifest")

    for artifact_name in set(REQUIRED_ENCRYPTED_ARTIFACTS) - set(CONTRACT_ARTIFACTS):
        authenticate_encrypted_artifact(backup_dir / artifact_name, passphrase)

    contracts: dict[str, dict[str, Any]] = {}
    for artifact_name, kind in CONTRACT_ARTIFACTS.items():
        contract = decrypt_json(backup_dir / artifact_name, passphrase)
        validate_contract(kind, contract, policy=policy)
        entry = artifacts[artifact_name]
        if sha256_bytes(canonical_json_bytes(contract)) != entry["plaintext_contract_sha256"]:
            raise RecoveryToolingError("Decrypted contract digest does not match the encrypted manifest")
        if contract["backup_set_id"] != manifest["backup_set_id"]:
            raise RecoveryToolingError("Decrypted recovery contracts do not belong to this backup set")
        contracts[kind] = contract

    integrity = contracts["restore-integrity"]
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

    provider_verified = False
    if validated_receipt is not None:
        if validated_receipt["backup_set_id"] != manifest["backup_set_id"]:
            raise RecoveryToolingError("Provider receipt identifies a different backup set")
        if validated_receipt["expected_manifest_sha256"] != manifest_digest:
            raise RecoveryToolingError("Provider receipt does not match the encrypted manifest digest")
        receipt_objects = {item["name"]: item for item in validated_receipt["objects"]}
        for name in expected_names:
            path = backup_dir / name
            if receipt_objects[name]["size_bytes"] != path.stat().st_size or receipt_objects[name]["sha256"] != sha256_file(path):
                raise RecoveryToolingError("Provider receipt object evidence does not match the downloaded bytes")
        provider_verified = True

    return {
        "backup_set_id": manifest["backup_set_id"],
        "artifact_count": len(expected_names),
        "manifest_sha256": manifest_digest,
        "provider_origin_verified": provider_verified,
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
