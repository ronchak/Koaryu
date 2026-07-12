#!/usr/bin/env python3
"""Create Koaryu's canonical authenticated-encrypted backup-set manifest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from recovery_tooling import (
    BACKUP_MANIFEST_NAME,
    CONTRACT_ARTIFACTS,
    REQUIRED_ENCRYPTED_ARTIFACTS,
    RecoveryToolingError,
    build_backup_manifest,
    canonical_json_bytes,
    decrypt_json,
    encrypt_json,
    load_json,
    read_passphrase_fd,
    require_private_backup_directory,
    require_exact_inventory,
    measure_decrypted_artifact,
    sha256_bytes,
    validate_encryption_packet_profile,
    verify_backup_set,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = SCRIPT_DIR.parent / "config" / "recovery" / "production-data-classification-policy.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a complete encrypted backup set and add backup-manifest.json.gpg.",
    )
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--project-config", type=Path, required=True)
    parser.add_argument("--restore-integrity", type=Path, required=True)
    parser.add_argument("--classification-source", type=Path, required=True)
    parser.add_argument("--classification-manifest", type=Path, required=True)
    parser.add_argument("--classification-policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument(
        "--passphrase-fd",
        type=int,
        required=True,
        help="Already-open file descriptor containing exactly one passphrase line.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output: Path | None = None
    output_created = False
    completed = False
    try:
        backup_dir = require_private_backup_directory(args.backup_dir)
        metadata = load_json(args.metadata, require_private=True)
        policy = load_json(args.classification_policy)
        contracts = {
            "project-config": load_json(args.project_config, require_private=True),
            "restore-integrity": load_json(args.restore_integrity, require_private=True),
            "classification-source": load_json(args.classification_source, require_private=True),
            "classification-manifest": load_json(args.classification_manifest, require_private=True),
        }
        passphrase = read_passphrase_fd(args.passphrase_fd)
        try:
            plaintext_artifacts = {}
            for artifact_name in REQUIRED_ENCRYPTED_ARTIFACTS:
                validate_encryption_packet_profile(backup_dir / artifact_name)
                plaintext_artifacts[artifact_name] = measure_decrypted_artifact(
                    backup_dir / artifact_name,
                    passphrase,
                )
            for artifact_name, kind in CONTRACT_ARTIFACTS.items():
                encrypted_contract = decrypt_json(backup_dir / artifact_name, passphrase)
                if canonical_json_bytes(encrypted_contract) != canonical_json_bytes(contracts[kind]):
                    raise RecoveryToolingError(
                        "Encrypted recovery contract does not match its reviewed plaintext input"
                    )
                if plaintext_artifacts[artifact_name]["plaintext_sha256"] != sha256_bytes(
                    canonical_json_bytes(contracts[kind])
                ):
                    raise RecoveryToolingError(
                        "Encrypted recovery contract is not canonical JSON"
                    )
            manifest = build_backup_manifest(
                metadata,
                backup_dir,
                contracts,
                policy,
                plaintext_artifacts,
            )
            require_exact_inventory(backup_dir, include_manifest=False)
            output = backup_dir / BACKUP_MANIFEST_NAME
            encrypt_json(manifest, output, passphrase)
            output_created = True
            require_exact_inventory(backup_dir, include_manifest=True)
            verification = verify_backup_set(backup_dir, passphrase, policy)
        finally:
            passphrase = b""
        print(
            "Encrypted backup manifest created: "
            f"backup_set_id={manifest['backup_set_id']} "
            f"artifacts={len(manifest['artifacts']) + 1} "
            f"manifest_sha256={verification['manifest_sha256']}"
        )
        completed = True
        return 0
    except RecoveryToolingError as exc:
        print(f"Recovery tooling refused: {exc}", file=sys.stderr)
        return 2
    finally:
        if output_created and not completed and output is not None:
            output.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
