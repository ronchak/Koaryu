#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
import importlib.util
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
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


def gpg_encrypt_bytes(
    value: bytes,
    output: Path,
    passphrase: bytes,
    *,
    s2k_mode: int = 3,
    s2k_count: int = 65_011_712,
) -> None:
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, passphrase + b"\n")
    finally:
        os.close(write_fd)
    try:
        result = subprocess.run(
            [
                "gpg", "--batch", "--quiet", "--symmetric", "--force-aead",
                "--aead-algo", "OCB", "--cipher-algo", "AES256",
                "--s2k-mode", str(s2k_mode), "--s2k-digest-algo", "SHA512",
                "--s2k-count", str(s2k_count), "--chunk-size", "22",
                "--pinentry-mode", "loopback", "--passphrase-fd", str(read_fd),
                "--output", str(output),
            ],
            input=value,
            pass_fds=(read_fd,),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            raise AssertionError("fixture encryption failed")
        os.chmod(output, 0o600)
    finally:
        os.close(read_fd)


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

        source_schema = json.loads(
            (ROOT_DIR / "config/recovery/classification-source.schema.json").read_text()
        )
        manifest_schema = json.loads(
            (ROOT_DIR / "config/recovery/classification-manifest.schema.json").read_text()
        )
        for payload in (source_schema, manifest_schema):
            self.assertEqual(
                payload["$defs"]["identifierProtection"]["properties"]["email_strategy"],
                {"const": "omitted"},
            )
            self.assertEqual(
                payload["$defs"]["uuidRecordId"]["pattern"],
                recovery.UUID_RE.pattern,
            )
            self.assertEqual(
                payload["$defs"]["stripeEventId"]["pattern"],
                recovery.STRIPE_EVENT_ID_RE.pattern,
            )
            self.assertEqual(payload["properties"]["sources"]["minItems"], 5)
            self.assertEqual(payload["properties"]["sources"]["maxItems"], 5)
            self.assertEqual(len(payload["properties"]["sources"]["allOf"]), 5)

        receipt_schema = json.loads(
            (ROOT_DIR / "config/recovery/provider-download-receipt.schema.json").read_text()
        )
        self.assertEqual(
            receipt_schema["properties"]["evidence_scope"]["const"],
            "untrusted_adapter_attestation",
        )
        self.assertEqual(len(receipt_schema["properties"]["objects"]["allOf"]), 11)
        approved = json.loads(
            (ROOT_DIR / "config/recovery/approved-provider-adapters.json").read_text()
        )
        self.assertEqual(approved, {"schema_version": 1, "adapters": []})

        expected_encryption = {
            "scheme",
            "key_id",
            "s2k_mode",
            "s2k_digest",
            "s2k_count",
            "aead_chunk_size",
        }
        metadata_schema = json.loads(
            (ROOT_DIR / "config/recovery/backup-set-metadata.schema.json").read_text()
        )
        backup_schema = json.loads(
            (ROOT_DIR / "config/recovery/backup-set-manifest.schema.json").read_text()
        )
        for encryption_schema in (
            metadata_schema["properties"]["encryption"],
            backup_schema["$defs"]["encryption"],
        ):
            self.assertEqual(set(encryption_schema["required"]), expected_encryption)
            self.assertEqual(encryption_schema["properties"]["s2k_mode"], {"const": 3})
            self.assertEqual(encryption_schema["properties"]["s2k_digest"], {"const": "SHA512"})
            self.assertEqual(encryption_schema["properties"]["s2k_count"], {"const": 65_011_712})
            self.assertEqual(encryption_schema["properties"]["aead_chunk_size"], {"const": 22})

        adapter_schema = json.loads(
            (ROOT_DIR / "config/recovery/approved-provider-adapters.schema.json").read_text()
        )
        deny_rules = (
            adapter_schema["$defs"]["adapter"]["properties"]
            ["allowed_environment_variables"]["items"]["not"]["anyOf"]
        )
        reserved = set(deny_rules[0]["enum"])
        reserved_pattern = re.compile(deny_rules[1]["pattern"])
        self.assertIn("PATH", reserved)
        for name in (
            "BASH_ENV",
            "DYLD_FALLBACK_FRAMEWORK_PATH",
            "GIT_ASKPASS",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "LD_AUDIT",
            "LD_PROFILE",
            "NODE_OPTIONS",
            "PERL5OPT",
            "PYTHONPATH",
            "RUBYOPT",
            "SSH_ASKPASS",
        ):
            self.assertRegex(name, reserved_pattern)

        metadata = fixture("backup-set-metadata.json")
        project = fixture("project-config-manifest.json")
        integrity = fixture("restore-integrity-manifest.json")
        classification_source = fixture("classification-source.json")
        recovery.validate_backup_metadata(metadata)
        recovery.validate_project_config(project)
        recovery.validate_restore_integrity(integrity)
        recovery.validate_classification_source(classification_source, self.policy)
        bindings = {
            item["name"]: {
                "plaintext_size_bytes": item["plaintext_size_bytes"],
                "plaintext_sha256": item["plaintext_sha256"],
            }
            for item in integrity["snapshot_artifacts"]
        }
        self.assertEqual(
            integrity["database_snapshot_digest"],
            recovery.compute_snapshot_digest(bindings),
        )

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
        duplicate_unknown_rule = deepcopy(self.policy)
        duplicate_unknown_rule["ambiguous_rule_id"] = duplicate_unknown_rule["fallback_rule_id"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_policy(duplicate_unknown_rule)
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
            if record["record_id"] == "evt_fixture0002"
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

        for unsafe_identifier in (
            "15555550123",
            "d41d8cd98f00b204e9800998ecf8427e",
            "da39a3ee5e6b4b0d3255bfef95601890afd80709",
        ):
            unsafe = fixture("classification-source.json")
            unsafe["sources"][1]["records"][0]["record_id"] = unsafe_identifier
            with self.assertRaises(recovery.RecoveryToolingError):
                recovery.validate_classification_source(unsafe, self.policy)

        malformed_stripe = fixture("classification-source.json")
        malformed_stripe["sources"][-1]["records"][0]["record_id"] = "cus_fixture0001"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(malformed_stripe, self.policy)

        self_asserted_hmac = fixture("classification-source.json")
        self_asserted_hmac["identifier_protection"] = {
            "email_strategy": "hmac-sha256",
            "key_id": "unverified-key",
        }
        self_asserted_hmac["sources"][0]["records"][0]["email_hmac"] = (
            "hmac-sha256:unverified-key:" + "7" * 64
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(self_asserted_hmac, self.policy)

        duplicate_source = fixture("classification-source.json")
        duplicate_source["sources"][-1] = deepcopy(duplicate_source["sources"][0])
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_source(duplicate_source, self.policy)

        malformed_partition = recovery.build_classification_manifest(
            fixture("classification-source.json"),
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        malformed_partition["sources"][0]["classification_counts"]["unknown"] = False
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_manifest_structure(malformed_partition, self.policy)

        duplicate_manifest_source = recovery.build_classification_manifest(
            fixture("classification-source.json"),
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        duplicate_manifest_source["sources"][-1] = deepcopy(
            duplicate_manifest_source["sources"][0]
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_classification_manifest_structure(
                duplicate_manifest_source,
                self.policy,
            )

    @unittest.skipUnless(GPG_AVAILABLE, "GnuPG is required for encryption-profile tests")
    def test_encryption_profile_rejects_non_aead_input(self):
        plaintext = self.root / "not-encrypted.gpg"
        plaintext.write_bytes(b"deliberately not encrypted\n")
        os.chmod(plaintext, 0o600)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_encryption_packet_profile(plaintext)

        weak_s2k = self.root / "weak-s2k.gpg"
        gpg_encrypt_bytes(
            b"weak profile fixture\n",
            weak_s2k,
            b"fixture-passphrase",
            s2k_mode=1,
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_encryption_packet_profile(weak_s2k)

        low_s2k_count = self.root / "low-s2k-count.gpg"
        gpg_encrypt_bytes(
            b"low S2K count fixture\n",
            low_s2k_count,
            b"fixture-passphrase",
            s2k_count=65_536,
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_encryption_packet_profile(low_s2k_count)

        strong_manifest = self.root / "strong-manifest.gpg"
        recovery.encrypt_json(
            {"fixture": True},
            strong_manifest,
            b"fixture-passphrase",
        )
        recovery.validate_encryption_packet_profile(strong_manifest)
        self.assertFalse(any(path.name.startswith(".manifest-") for path in self.root.iterdir()))

        weak_metadata = fixture("backup-set-metadata.json")
        weak_metadata["encryption"]["s2k_count"] = 65_536
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_backup_metadata(weak_metadata)

    def test_encrypted_json_publication_never_materializes_plaintext(self):
        value = {"fixture": "plaintext-must-never-touch-disk"}
        encoded = recovery.canonical_json_bytes(value)
        output = self.root / "streamed-contract.json.gpg"

        def fake_gpg(arguments, **kwargs):
            self.assertEqual(kwargs["input"], encoded)
            self.assertNotIn("fixture-passphrase", " ".join(arguments))
            for path in self.root.iterdir():
                if path.is_file():
                    self.assertNotIn(encoded, path.read_bytes())
            os.write(kwargs["stdout"], b"synthetic-ciphertext")
            return subprocess.CompletedProcess(arguments, 0)

        with patch.object(recovery.subprocess, "run", side_effect=fake_gpg):
            recovery.encrypt_json(value, output, b"fixture-passphrase")
        self.assertEqual(output.read_bytes(), b"synthetic-ciphertext")
        self.assertNotIn(encoded, output.read_bytes())

    def test_manifest_creator_removes_output_after_unexpected_post_write_failure(self):
        creator_spec = importlib.util.spec_from_file_location(
            "koaryu_manifest_creator",
            SCRIPT_DIR / "create-encrypted-backup-manifest.py",
        )
        assert creator_spec is not None and creator_spec.loader is not None
        creator = importlib.util.module_from_spec(creator_spec)
        creator_spec.loader.exec_module(creator)
        backup_dir = self.root / "post-write-cleanup"
        backup_dir.mkdir(mode=0o700)
        output = backup_dir / recovery.BACKUP_MANIFEST_NAME
        args = SimpleNamespace(
            backup_dir=backup_dir,
            metadata=self.root / "metadata.json",
            project_config=self.root / "project.json",
            restore_integrity=self.root / "integrity.json",
            classification_source=self.root / "source.json",
            classification_manifest=self.root / "classification.json",
            classification_policy=POLICY_PATH,
            passphrase_fd=3,
        )

        def publish_fixture(_manifest, path, _passphrase):
            path.write_bytes(b"synthetic encrypted manifest")
            os.chmod(path, 0o600)

        with (
            patch.object(creator, "parse_args", return_value=args),
            patch.object(creator, "REQUIRED_ENCRYPTED_ARTIFACTS", {}),
            patch.object(creator, "CONTRACT_ARTIFACTS", {}),
            patch.object(creator, "require_private_backup_directory", return_value=backup_dir),
            patch.object(creator, "load_json", return_value={}),
            patch.object(creator, "read_passphrase_fd", return_value=b"fixture-passphrase"),
            patch.object(
                creator,
                "build_backup_manifest",
                return_value={"backup_set_id": "fixture-backup", "artifacts": []},
            ),
            patch.object(creator, "require_exact_inventory"),
            patch.object(creator, "encrypt_json", side_effect=publish_fixture),
            patch.object(
                creator,
                "verify_backup_set",
                side_effect=OSError("synthetic post-write verifier failure"),
            ),
        ):
            with self.assertRaises(OSError):
                creator.main()
        self.assertFalse(output.exists())

    def test_passphrase_fd_requires_exactly_one_line(self):
        def read_value(value: bytes) -> bytes:
            read_fd, write_fd = os.pipe()
            try:
                os.write(write_fd, value)
            finally:
                os.close(write_fd)
            try:
                return recovery.read_passphrase_fd(read_fd)
            finally:
                os.close(read_fd)

        self.assertEqual(read_value(b"fixture-passphrase\n"), b"fixture-passphrase")
        self.assertEqual(read_value(b"fixture-passphrase\r\n"), b"fixture-passphrase")
        for invalid in (b"\n", b"first\nsecond\n", b"value\n\n", b"nul\0byte\n"):
            with self.assertRaises(recovery.RecoveryToolingError):
                read_value(invalid)

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

        overstated_project = deepcopy(project_config)
        overstated_project["evidence_scope"]["assurance"] = "complete"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_project_config(overstated_project)

        omitted_surface = deepcopy(project_config)
        omitted_surface["evidence_scope"]["manual_reconfiguration_required"].pop()
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_project_config(omitted_surface)

        unsafe_schema = deepcopy(project_config)
        unsafe_schema["data_api"]["exposed_schemas"] = ["public schema"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_project_config(unsafe_schema)

        unsafe_realtime = deepcopy(project_config)
        unsafe_realtime["realtime"]["publications"] = ["bad publication"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_project_config(unsafe_realtime)

        recovery._validate_cross_contract_bindings(project_config, integrity)
        unbound_storage = deepcopy(integrity)
        unbound_storage["storage"]["buckets"][0]["configuration_digest"] = (
            "sha256:" + "0" * 64
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery._validate_cross_contract_bindings(project_config, unbound_storage)

        unbound_grants = deepcopy(integrity)
        unbound_grants["catalog"]["grants_digest"] = "sha256:" + "0" * 64
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery._validate_cross_contract_bindings(project_config, unbound_grants)

        unbound_publications = deepcopy(integrity)
        unbound_publications["catalog"]["publications"] = ["different_publication"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery._validate_cross_contract_bindings(
                project_config,
                unbound_publications,
            )

        snapshot_bindings = {
            item["name"]: {
                "plaintext_size_bytes": item["plaintext_size_bytes"],
                "plaintext_sha256": item["plaintext_sha256"],
            }
            for item in integrity["snapshot_artifacts"]
        }
        original_digest = recovery.compute_snapshot_digest(snapshot_bindings)
        snapshot_bindings["data.sql.gpg"]["plaintext_sha256"] = "sha256:" + "0" * 64
        self.assertNotEqual(
            original_digest,
            recovery.compute_snapshot_digest(snapshot_bindings),
        )

        stale_integrity = deepcopy(integrity)
        stale_integrity["snapshot_artifacts"][0]["plaintext_sha256"] = "sha256:" + "0" * 64
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_restore_integrity(stale_integrity)

        unsafe_column = deepcopy(integrity)
        unsafe_column["migration_history"]["columns"].append("bad col")
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_restore_integrity(unsafe_column)

        unsafe_extension = deepcopy(integrity)
        unsafe_extension["catalog"]["extensions"] = ["pg crypto"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_restore_integrity(unsafe_extension)

        unsafe_catalog_publication = deepcopy(integrity)
        unsafe_catalog_publication["catalog"]["publications"] = ["bad publication"]
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_restore_integrity(unsafe_catalog_publication)

    def test_snapshot_binding_generator_is_deterministic_and_private(self):
        inputs = {}
        for argument, artifact_name in {
            "roles": "roles.sql.gpg",
            "schema": "schema.sql.gpg",
            "data": "data.sql.gpg",
            "migration-history-schema": "migration-history-schema.sql.gpg",
            "migration-history-data": "migration-history-data.sql.gpg",
            "storage-objects": "storage-objects.tar.gpg",
        }.items():
            path = self.root / artifact_name.removesuffix(".gpg")
            path.write_bytes(f"deterministic fixture for {artifact_name}\n".encode())
            os.chmod(path, 0o600)
            inputs[argument] = path
        output = self.root / "snapshot-bindings.json"
        command = [
            sys.executable,
            str(SCRIPT_DIR / "create-snapshot-bindings.py"),
        ]
        for argument, path in inputs.items():
            command.extend([f"--{argument}", str(path)])
        command.extend(["--output", str(output)])
        generated = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        payload = recovery.load_json(output, require_private=True)
        bindings = {
            item["name"]: {
                "plaintext_size_bytes": item["plaintext_size_bytes"],
                "plaintext_sha256": item["plaintext_sha256"],
            }
            for item in payload["snapshot_artifacts"]
        }
        self.assertEqual(
            payload["database_snapshot_digest"],
            recovery.compute_snapshot_digest(bindings),
        )

    def _create_backup_set(self):
        backup_dir = self.root / "known-local-source"
        backup_dir.mkdir(mode=0o700)
        passphrase = secrets.token_urlsafe(32).encode("ascii")
        metadata = fixture("backup-set-metadata.json")
        project_config = fixture("project-config-manifest.json")
        integrity = fixture("restore-integrity-manifest.json")
        classification_source = fixture("classification-source.json")

        plaintext_values = {
            name: f"synthetic encrypted fixture for {name}\n".encode("utf-8")
            for name in recovery.REQUIRED_ENCRYPTED_ARTIFACTS
            if name not in recovery.CONTRACT_ARTIFACTS
        }
        snapshot_bindings = {
            name: {
                "plaintext_size_bytes": len(plaintext_values[name]),
                "plaintext_sha256": recovery.sha256_bytes(plaintext_values[name]),
            }
            for name in recovery.SNAPSHOT_PAYLOAD_ARTIFACTS
        }
        snapshot_digest = recovery.compute_snapshot_digest(snapshot_bindings)
        metadata["source"]["database_snapshot_digest"] = snapshot_digest
        integrity["database_snapshot_digest"] = snapshot_digest
        integrity["snapshot_artifacts"] = [
            {"name": name, **snapshot_bindings[name]}
            for name in recovery.SNAPSHOT_PAYLOAD_ARTIFACTS
        ]
        classification_source["source_snapshot_digest"] = snapshot_digest
        classification = recovery.build_classification_manifest(
            classification_source,
            self.policy,
            generated_at="2026-07-12T12:01:00Z",
        )
        for name in set(recovery.REQUIRED_ENCRYPTED_ARTIFACTS) - set(
            recovery.CONTRACT_ARTIFACTS
        ):
            gpg_encrypt_bytes(plaintext_values[name], backup_dir / name, passphrase)

        metadata_path = self.root / "metadata.json"
        project_path = self.root / "project-config.json"
        integrity_path = self.root / "integrity.json"
        classification_source_path = self.root / "classification-source.json"
        classification_path = self.root / "classification.json"
        private_json(metadata_path, metadata)
        private_json(project_path, project_config)
        private_json(integrity_path, integrity)
        private_json(classification_source_path, classification_source)
        private_json(classification_path, classification)

        contract_specs = (
            (
                "project-config",
                project_path,
                backup_dir / "project-config-manifest.json.gpg",
                project_config,
            ),
            (
                "restore-integrity",
                integrity_path,
                backup_dir / "restore-integrity-manifest.json.gpg",
                integrity,
            ),
            (
                "classification-source",
                classification_source_path,
                backup_dir / "classification-source.json.gpg",
                classification_source,
            ),
            (
                "classification-manifest",
                classification_path,
                backup_dir / "record-classification-manifest.json.gpg",
                classification,
            ),
        )
        for kind, source_path, output_path, contract in contract_specs:
            encrypted = run_with_passphrase(
                [
                    sys.executable,
                    str(SCRIPT_DIR / "encrypt-recovery-contract.py"),
                    "--kind", kind,
                    "--input", str(source_path),
                    "--output", str(output_path),
                    "--classification-policy", str(POLICY_PATH),
                ],
                passphrase,
            )
            self.assertEqual(encrypted.returncode, 0, encrypted.stderr)
            self.assertEqual(
                recovery.measure_decrypted_artifact(output_path, passphrase),
                {
                    "plaintext_size_bytes": len(recovery.canonical_json_bytes(contract)),
                    "plaintext_sha256": recovery.sha256_bytes(
                        recovery.canonical_json_bytes(contract)
                    ),
                },
            )

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
            "evidence_scope": "untrusted_adapter_attestation",
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

        binding_tamper = self.root / "plaintext-binding-tamper"
        shutil.copytree(known_source, binding_tamper)
        outer_manifest_path = binding_tamper / recovery.BACKUP_MANIFEST_NAME
        outer_manifest = recovery.decrypt_json(outer_manifest_path, passphrase)
        outer_manifest["artifacts"][0]["plaintext_sha256"] = "sha256:" + "0" * 64
        outer_manifest_path.unlink()
        recovery.encrypt_json(outer_manifest, outer_manifest_path, passphrase)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(binding_tamper, passphrase, self.policy)

        plaintext_extra = known_source / "operator-notes.txt"
        plaintext_extra.write_text("must be rejected\n", encoding="utf-8")
        os.chmod(plaintext_extra, 0o600)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        plaintext_extra.unlink()

        directory_extra = known_source / "unexpected-directory"
        directory_extra.mkdir(mode=0o700)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        directory_extra.rmdir()

        extra = known_source / "unsupported-extra.gpg"
        shutil.copyfile(known_source / "roles.sql.gpg", extra)
        os.chmod(extra, 0o600)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        extra.unlink()

        hardlink = self.root / "linked-role.gpg"
        os.link(known_source / "roles.sql.gpg", hardlink)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        hardlink.unlink()

        role = known_source / "roles.sql.gpg"
        held_role = self.root / "held-role.gpg"
        role.rename(held_role)
        role.symlink_to(held_role)
        try:
            with self.assertRaises(recovery.RecoveryToolingError):
                recovery.verify_backup_set(known_source, passphrase, self.policy)
        finally:
            role.unlink()
            held_role.rename(role)

        os.chmod(known_source, 0o755)
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.verify_backup_set(known_source, passphrase, self.policy)
        os.chmod(known_source, 0o700)

        candidate = self.root / "provider-download"
        shutil.copytree(known_source, candidate)
        os.chmod(candidate, 0o700)
        receipt = self._provider_receipt(candidate, manifest_sha)
        duplicate_provider_identifier = deepcopy(receipt)
        duplicate_provider_identifier["objects"][1]["object_id"] = (
            duplicate_provider_identifier["objects"][0]["object_id"]
        )
        duplicate_provider_identifier["objects"][1]["version_id"] = (
            duplicate_provider_identifier["objects"][0]["version_id"]
        )
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_provider_receipt(duplicate_provider_identifier)
        local_scheme = deepcopy(receipt)
        local_scheme["provider"] = "FiLe"
        with self.assertRaises(recovery.RecoveryToolingError):
            recovery.validate_provider_receipt(local_scheme)
        private_json(candidate / recovery.PROVIDER_RECEIPT_NAME, receipt)
        verified = recovery.verify_backup_set(
            candidate,
            passphrase,
            self.policy,
            receipt=receipt,
            known_local_source=known_source,
            expected_manifest_sha256=manifest_sha,
        )
        self.assertTrue(verified["provider_receipt_matches_bytes"])
        self.assertFalse(verified["provider_origin_verified"])

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
if [[ -n "${PROBE_FD:-}" && -r "/dev/fd/$PROBE_FD" ]]; then
  exit 73
fi
if [[ -n "${UNAPPROVED_SECRET:-}" ]]; then
  exit 74
fi
[[ "$PATH" == "/usr/bin:/bin:/usr/sbin:/sbin" ]]
case "$PWD" in
  */.koaryu-provider-exec-*) ;;
  *) exit 75 ;;
esac
[[ "$(umask)" == "0077" || "$(umask)" == "077" ]]
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
[[ "$locator" == "s3://fixture-container/fixture-object-set" ]]
cp "$PROVIDER_FIXTURE_DIR"/*.gpg "$destination"/
cp "$PROVIDER_FIXTURE_RECEIPT" "$receipt"
""",
            encoding="utf-8",
        )
        os.chmod(adapter, 0o700)
        adapter_digest = "sha256:" + hashlib.sha256(adapter.read_bytes()).hexdigest()

        # The repository ships with no approved provider. The public wrapper
        # must fail before executing an arbitrary adapter.
        marker_adapter = self.root / "must-not-run.sh"
        marker = self.root / "adapter-ran"
        marker_adapter.write_text(
            f"#!/usr/bin/env bash\ntouch '{marker}'\nexit 0\n",
            encoding="utf-8",
        )
        os.chmod(marker_adapter, 0o700)
        destination = self.root / "downloaded"
        refused = run_with_passphrase(
            [
                "/bin/bash", str(SCRIPT_DIR / "download-offsite-backup.sh"),
                "--provider-profile", "fixture-provider-v1",
                "--provider-command", str(marker_adapter),
                "--provider-locator", "s3://fixture-container/fixture-object-set",
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
        self.assertEqual(refused.returncode, 1)
        self.assertIn(
            "Provider download refused or failed; the reviewed runner suppressed adapter output.",
            refused.stderr,
        )
        self.assertNotIn("bad substitution", refused.stderr.lower())
        self.assertFalse(marker.exists())
        self.assertFalse(destination.exists())

        unsafe_locator = run_with_passphrase(
            [
                "/bin/bash", str(SCRIPT_DIR / "download-offsite-backup.sh"),
                "--provider-profile", "fixture-provider-v1",
                "--provider-command", str(marker_adapter),
                "--provider-locator", "FILE://fixture-container/fixture-object-set",
                "--destination", str(destination),
                "--known-local-source", str(known_source),
                "--expected-manifest-sha256", manifest_sha,
                "--classification-policy", str(POLICY_PATH),
            ],
            passphrase,
        )
        self.assertEqual(unsafe_locator.returncode, 2)
        self.assertIn(
            "provider locator is local, credential-bearing, or malformed",
            unsafe_locator.stderr,
        )
        self.assertNotIn("bad substitution", unsafe_locator.stderr.lower())
        self.assertFalse(marker.exists())
        self.assertFalse(destination.exists())

        # Exercise the strict adapter boundary with a temporary reviewed policy:
        # only allow-listed environment reaches the child, and an unrelated
        # inherited descriptor (standing in for the recovery-key FD) is closed.
        trust_policy = self.root / "reviewed-provider-policy.json"
        private_json(trust_policy, {
            "schema_version": 1,
            "adapters": [{
                "profile_id": "fixture-provider-v1",
                "provider": "fixture-cloud",
                "locator_scheme": "s3",
                "adapter_sha256": adapter_digest,
                "allowed_environment_variables": [
                    "PROBE_FD",
                    "PROVIDER_FIXTURE_DIR",
                    "PROVIDER_FIXTURE_RECEIPT",
                ],
            }],
        })
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"must-not-reach-adapter\n")
        finally:
            os.close(write_fd)
        try:
            runner_spec = importlib.util.spec_from_file_location(
                "koaryu_provider_runner",
                SCRIPT_DIR / "run-approved-provider-download.py",
            )
            assert runner_spec is not None and runner_spec.loader is not None
            runner_module = importlib.util.module_from_spec(runner_spec)
            runner_spec.loader.exec_module(runner_module)
            adapter_schema = json.loads(
                (ROOT_DIR / "config/recovery/approved-provider-adapters.schema.json").read_text()
            )
            deny_rules = (
                adapter_schema["$defs"]["adapter"]["properties"]
                ["allowed_environment_variables"]["items"]["not"]["anyOf"]
            )
            self.assertEqual(
                set(deny_rules[0]["enum"]),
                runner_module.RESERVED_ENVIRONMENT_VARIABLES,
            )
            self.assertEqual(
                deny_rules[1]["pattern"],
                "^(" + "|".join(runner_module.RESERVED_ENVIRONMENT_PREFIXES) + ")",
            )
            for reserved_name in (
                "PATH",
                "NODE_OPTIONS",
                "RUBYOPT",
                "PERL5OPT",
                "GIT_SSH_COMMAND",
                "GIT_SSH",
                "GIT_ASKPASS",
                "SSH_ASKPASS",
                "LD_AUDIT",
                "LD_PROFILE",
                "DYLD_FRAMEWORK_PATH",
                "DYLD_FALLBACK_FRAMEWORK_PATH",
            ):
                reserved_policy = deepcopy(
                    recovery.load_json(trust_policy, require_private=True)
                )
                reserved_policy["adapters"][0][
                    "allowed_environment_variables"
                ].append(reserved_name)
                with self.assertRaises(recovery.RecoveryToolingError):
                    runner_module._validate_policy(reserved_policy)
            with self.assertRaises(recovery.RecoveryToolingError):
                runner_module._open_pinned_adapter(adapter, "sha256:" + "0" * 64)
            with patch.dict(os.environ, {
                "PROBE_FD": str(read_fd),
                "PROVIDER_FIXTURE_DIR": str(provider_store),
                "PROVIDER_FIXTURE_RECEIPT": str(receipt_path),
                "UNAPPROVED_SECRET": "must-not-reach-adapter",
            }):
                runner_module.run_download(
                    SimpleNamespace(
                        profile="fixture-provider-v1",
                        provider_command=adapter,
                        locator="s3://fixture-container/fixture-object-set",
                        destination=destination,
                    ),
                    trust_policy=trust_policy,
                )
        finally:
            os.close(read_fd)
        self.assertTrue((destination / recovery.PROVIDER_RECEIPT_NAME).is_file())

        verified = run_with_passphrase(
            [
                sys.executable,
                str(SCRIPT_DIR / "verify-backup-set.py"),
                "--backup-dir", str(destination),
                "--provider-receipt", str(destination / recovery.PROVIDER_RECEIPT_NAME),
                "--known-local-source", str(known_source),
                "--expected-manifest-sha256", manifest_sha,
                "--classification-policy", str(POLICY_PATH),
            ],
            passphrase,
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("provider_receipt_bytes=yes", verified.stdout)
        self.assertIn("provider_origin=no", verified.stdout)

        timeout_adapter = self.root / "timeout-provider-adapter.sh"
        timeout_adapter.write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nsleep 30\n",
            encoding="utf-8",
        )
        os.chmod(timeout_adapter, 0o700)
        timeout_digest = "sha256:" + hashlib.sha256(timeout_adapter.read_bytes()).hexdigest()
        timeout_policy = self.root / "timeout-provider-policy.json"
        private_json(timeout_policy, {
            "schema_version": 1,
            "adapters": [{
                "profile_id": "timeout-provider-v1",
                "provider": "fixture-cloud",
                "locator_scheme": "s3",
                "adapter_sha256": timeout_digest,
                "allowed_environment_variables": [],
            }],
        })
        timeout_destination = self.root / "timeout-download"
        with patch.object(runner_module, "ADAPTER_TIMEOUT_SECONDS", 0.05):
            with self.assertRaises(recovery.RecoveryToolingError):
                runner_module.run_download(
                    SimpleNamespace(
                        profile="timeout-provider-v1",
                        provider_command=timeout_adapter,
                        locator="s3://fixture-container/fixture-object-set",
                        destination=timeout_destination,
                    ),
                    trust_policy=timeout_policy,
                )
        self.assertFalse(timeout_destination.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
