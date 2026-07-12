#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
FIXTURE_DIR = SCRIPT_DIR / "fixtures" / "recovery"
POLICY_PATH = ROOT_DIR / "config" / "recovery" / "production-data-classification-policy.json"
GPG_AVAILABLE = shutil.which("gpg") is not None
sys.path.insert(0, str(SCRIPT_DIR))

import recovery_tooling as recovery  # noqa: E402


def fixture(name: str):
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def private_json(path: Path, value) -> None:
    recovery.write_private_json(path, value)
    os.chmod(path, 0o600)


def run_with_passphrase(command: list[str], passphrase: bytes, **kwargs) -> subprocess.CompletedProcess:
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, passphrase + b"\n")
    finally:
        os.close(write_fd)
    try:
        return subprocess.run(
            [*command, "--passphrase-fd", str(read_fd)],
            pass_fds=(read_fd,),
            text=True,
            capture_output=True,
            check=False,
            **kwargs,
        )
    finally:
        os.close(read_fd)


def gpg_encrypt_bytes(value: bytes, output: Path, passphrase: bytes) -> None:
    plaintext = output.parent / f".{output.name}.plaintext"
    plaintext.write_bytes(value)
    os.chmod(plaintext, 0o600)
    try:
        result = subprocess.run(
            [
                "gpg", "--batch", "--quiet", "--symmetric", "--force-aead",
                "--aead-algo", "OCB", "--cipher-algo", "AES256",
                "--pinentry-mode", "loopback", "--passphrase-fd", "0",
                "--output", str(output), str(plaintext),
            ],
            input=passphrase + b"\n",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            raise AssertionError("fixture encryption failed")
        os.chmod(output, 0o600)
    finally:
        plaintext.unlink(missing_ok=True)


class RecoveryToolingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="koaryu-recovery-test-")
        self.root = Path(self.temporary.name)
        self.policy = recovery.load_json(POLICY_PATH)

    def tearDown(self):
        self.temporary.cleanup()

    def test_versioned_json_schemas_are_well_formed(self):
        schemas = sorted((ROOT_DIR / "config" / "recovery").glob("*.schema.json"))
        self.assertGreaterEqual(len(schemas), 6)
        for schema in schemas:
            payload = json.loads(schema.read_text(encoding="utf-8"))
            self.assertEqual(payload["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertIn("$id", payload)

    def test_classification_is_total_unique_and_fail_closed(self):
        source = fixture("classification-source.json")
        self.assertEqual(
            {rule["rule_id"] for rule in self.policy["rules"]},
            {
                "known-demo-explicit-v1",
                "known-demo-fixture-v1",
                "known-test-explicit-v1",
                "known-test-provider-mode-v1",
            },
        )
        self.assertEqual(self.policy["fallback_rule_id"], "default-unknown-v1")
        self.assertEqual(self.policy["ambiguous_rule_id"], "ambiguous-unknown-v1")
        manifest = recovery.build_classification_manifest(
            source,
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        self.assertEqual(manifest["totals"]["source_count"], 8)
        self.assertEqual(
            manifest["totals"]["classification_counts"],
            {"known_demo": 2, "known_test": 2, "unknown": 4},
        )
        ambiguous = next(
            record
            for group in manifest["sources"]
            if group["source_type"] == "stripe_event"
            for record in group["records"]
            if record["record_id"] == "evt_fixture_0002"
        )
        self.assertEqual(ambiguous["classification"], "unknown")
        self.assertEqual(ambiguous["rule_id"], "ambiguous-unknown-v1")
        recovery.verify_classification_manifest(source, manifest, self.policy)

        source_scoped = fixture("classification-source.json")
        source_scoped["sources"][0]["records"][1]["evidence"] = ["provider_test_mode"]
        scoped_manifest = recovery.build_classification_manifest(
            source_scoped,
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        scoped_record = scoped_manifest["sources"][0]["records"][1]
        self.assertEqual(scoped_record["classification"], "unknown")
        self.assertEqual(scoped_record["reason_code"], "no_approved_evidence")

        tampered = deepcopy(manifest)
        tampered["sources"][0]["records"][1]["classification"] = "known_test"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_classification_manifest(source, tampered, self.policy)

    def test_classification_rejects_duplicates_raw_pii_and_unkeyed_email_hashes(self):
        duplicate = fixture("classification-source.json")
        duplicate["sources"][0]["records"].append(deepcopy(duplicate["sources"][0]["records"][0]))
        duplicate["sources"][0]["source_count"] += 1
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(duplicate, self.policy)

        raw_pii = fixture("classification-source.json")
        raw_pii["sources"][0]["records"][0]["email"] = "deliberate-raw-field-fixture"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(raw_pii, self.policy)

        unkeyed = fixture("classification-source.json")
        unkeyed["sources"][0]["records"][0]["email_hmac"] = "7" * 64
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(unkeyed, self.policy)

        digest_identifier = fixture("classification-source.json")
        digest_identifier["sources"][0]["records"][0]["record_id"] = "7" * 64
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(digest_identifier, self.policy)

        malformed_partition = recovery.build_classification_manifest(
            fixture("classification-source.json"),
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        malformed_partition["sources"][0]["classification_counts"]["unknown"] = False
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_manifest_structure(malformed_partition, self.policy)

    @unittest.skipUnless(GPG_AVAILABLE, "GnuPG is required for encryption-profile tests")
    def test_encryption_profile_rejects_non_aead_input(self):
        plaintext = self.root / "not-encrypted.gpg"
        plaintext.write_bytes(b"deliberately not encrypted\n")
        os.chmod(plaintext, 0o600)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_encryption_packet_profile(plaintext)

    def test_project_and_integrity_contracts_reject_secrets_and_duplicate_tables(self):
        project_config = fixture("project-config-manifest.json")
        recovery.validate_project_config(project_config)
        unsafe = deepcopy(project_config)
        unsafe["api_keys"]["secret_key"] = "deliberately-not-a-real-secret"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_project_config(unsafe)

        integrity = fixture("restore-integrity-manifest.json")
        recovery.validate_restore_integrity(integrity)
        duplicate = deepcopy(integrity)
        duplicate["tables"].append(deepcopy(duplicate["tables"][0]))
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_restore_integrity(duplicate)

    def _create_backup_set(self):
        backup_dir = self.root / "known-local-source"
        backup_dir.mkdir(mode=0o700)
        passphrase = secrets.token_urlsafe(32).encode("ascii")
        metadata = fixture("backup-set-metadata.json")
        project_config = fixture("project-config-manifest.json")
        integrity = fixture("restore-integrity-manifest.json")
        classification = recovery.build_classification_manifest(
            fixture("classification-source.json"),
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        plaintext_contracts = {
            "project-config-manifest.json.gpg": project_config,
            "restore-integrity-manifest.json.gpg": integrity,
            "classification-source.json.gpg": fixture("classification-source.json"),
            "record-classification-manifest.json.gpg": classification,
        }
        for name in recovery.REQUIRED_ENCRYPTED_ARTIFACTS:
            if name in plaintext_contracts:
                value = recovery.canonical_json_bytes(plaintext_contracts[name])
            else:
                value = f"synthetic encrypted fixture for {name}\n".encode("utf-8")
            gpg_encrypt_bytes(value, backup_dir / name, passphrase)

        metadata_path = self.root / "metadata.json"
        project_path = self.root / "project-config.json"
        integrity_path = self.root / "integrity.json"
        classification_source_path = self.root / "classification-source.json"
        classification_path = self.root / "classification.json"
        private_json(metadata_path, metadata)
        private_json(project_path, project_config)
        private_json(integrity_path, integrity)
        private_json(classification_source_path, fixture("classification-source.json"))
        private_json(classification_path, classification)

        create_result = run_with_passphrase(
            [
                sys.executable,
                str(SCRIPT_DIR / "create-encrypted-backup-manifest.py"),
                "--backup-dir", str(backup_dir),
                "--metadata", str(metadata_path),
                "--project-config", str(project_path),
                "--restore-integrity", str(integrity_path),
                "--classification-source", str(classification_source_path),
                "--classification-manifest", str(classification_path),
                "--classification-policy", str(POLICY_PATH),
            ],
            passphrase,
        )
        self.assertEqual(create_result.returncode, 0, create_result.stderr)
        self.assertNotIn("synthetic encrypted fixture", create_result.stdout)
        manifest_sha = recovery.sha256_file(backup_dir / recovery.BACKUP_MANIFEST_NAME)
        return backup_dir, passphrase, manifest_sha

    def _provider_receipt(self, backup_dir: Path, manifest_sha: str) -> dict:
        objects = []
        names = sorted(set(recovery.REQUIRED_ENCRYPTED_ARTIFACTS) | {recovery.BACKUP_MANIFEST_NAME})
        for index, name in enumerate(names, start=1):
            path = backup_dir / name
            objects.append({
                "name": name,
                "object_id": f"object.{index}",
                "version_id": f"version.{index}",
                "size_bytes": path.stat().st_size,
                "sha256": recovery.sha256_file(path),
            })
        return {
            "schema_version": 1,
            "backup_set_id": "koaryu-fixture-20260712",
            "provider": "fixture-cloud",
            "container_id": "fixture-container",
            "object_set_id": "fixture-object-set",
            "downloaded_at": "2026-07-12T12:02:00Z",
            "operator_id": "fixture-operator",
            "expected_manifest_sha256": manifest_sha,
            "objects": objects,
        }

    @unittest.skipUnless(GPG_AVAILABLE, "GnuPG is required for encrypted-manifest tests")
    def test_encrypted_manifest_and_provider_origin_verification(self):
        known_source, passphrase, manifest_sha = self._create_backup_set()
        local = recovery.verify_backup_set(known_source, passphrase, self.policy)
        self.assertFalse(local["provider_origin_verified"])
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, b"deliberately-wrong-key", self.policy)

        extra = known_source / "unsupported-extra.gpg"
        shutil.copyfile(known_source / "roles.sql.gpg", extra)
        os.chmod(extra, 0o600)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        extra.unlink()

        os.chmod(known_source, 0o755)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        os.chmod(known_source, 0o700)

        candidate = self.root / "provider-download"
        shutil.copytree(known_source, candidate)
        os.chmod(candidate, 0o700)
        receipt = self._provider_receipt(candidate, manifest_sha)
        verified = recovery.verify_backup_set(
            candidate,
            passphrase,
            self.policy,
            receipt=receipt,
            known_local_source=known_source,
            expected_manifest_sha256=manifest_sha,
        )
        self.assertTrue(verified["provider_origin_verified"])

        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(
                known_source,
                passphrase,
                self.policy,
                receipt=self._provider_receipt(known_source, manifest_sha),
                known_local_source=known_source,
                expected_manifest_sha256=manifest_sha,
            )

        tampered = candidate / "roles.sql.gpg"
        with tampered.open("ab") as handle:
            handle.write(b"tamper")
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(
                candidate,
                passphrase,
                self.policy,
                receipt=receipt,
                known_local_source=known_source,
                expected_manifest_sha256=manifest_sha,
            )

        (known_source / recovery.BACKUP_MANIFEST_NAME).unlink()
        encrypted_project = known_source / "project-config-manifest.json.gpg"
        encrypted_project.unlink()
        different_project = fixture("project-config-manifest.json")
        different_project["integrations"]["email_delivery"] = "disabled"
        gpg_encrypt_bytes(
            recovery.canonical_json_bytes(different_project),
            encrypted_project,
            passphrase,
        )
        recreate = run_with_passphrase(
            [
                sys.executable,
                str(SCRIPT_DIR / "create-encrypted-backup-manifest.py"),
                "--backup-dir", str(known_source),
                "--metadata", str(self.root / "metadata.json"),
                "--project-config", str(self.root / "project-config.json"),
                "--restore-integrity", str(self.root / "integrity.json"),
                "--classification-source", str(self.root / "classification-source.json"),
                "--classification-manifest", str(self.root / "classification.json"),
                "--classification-policy", str(POLICY_PATH),
            ],
            passphrase,
        )
        self.assertEqual(recreate.returncode, 2)
        self.assertIn("does not match its reviewed plaintext", recreate.stderr)
        self.assertFalse((known_source / recovery.BACKUP_MANIFEST_NAME).exists())

    @unittest.skipUnless(GPG_AVAILABLE, "GnuPG is required for provider-download tests")
    def test_provider_download_adapter_contract(self):
        known_source, passphrase, manifest_sha = self._create_backup_set()
        provider_store = self.root / "provider-store"
        shutil.copytree(known_source, provider_store)
        receipt_path = self.root / "provider-receipt.json"
        private_json(receipt_path, self._provider_receipt(provider_store, manifest_sha))

        adapter = self.root / "provider-adapter.sh"
        adapter.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == download ]]
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --locator) locator="$2"; shift 2 ;;
    --destination) destination="$2"; shift 2 ;;
    --receipt) receipt="$2"; shift 2 ;;
    *) exit 2 ;;
  esac
done
[[ "$locator" == "s3://fixture-bucket/object-set" ]]
cp "$PROVIDER_FIXTURE_DIR"/*.gpg "$destination"/
cp "$PROVIDER_FIXTURE_RECEIPT" "$receipt"
""",
            encoding="utf-8",
        )
        os.chmod(adapter, 0o700)
        destination = self.root / "downloaded"
        result = run_with_passphrase(
            [
                "bash", str(SCRIPT_DIR / "download-offsite-backup.sh"),
                "--provider-command", str(adapter),
                "--provider-locator", "s3://fixture-bucket/object-set",
                "--destination", str(destination),
                "--known-local-source", str(known_source),
                "--expected-manifest-sha256", manifest_sha,
                "--classification-policy", str(POLICY_PATH),
            ],
            passphrase,
            env={
                **os.environ,
                "PROVIDER_FIXTURE_DIR": str(provider_store),
                "PROVIDER_FIXTURE_RECEIPT": str(receipt_path),
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("provider_origin=yes", result.stdout)
        self.assertTrue((destination / "provider-download-receipt.json").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
