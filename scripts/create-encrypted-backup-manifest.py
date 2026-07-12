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
    authenticate_encrypted_artifact,
    build_backup_manifest,
    canonical_json_bytes,
    decrypt_json,
    encrypt_json,
    load_json,
    read_passphrase_fd,
    require_private_backup_directory,
    sha256_file,
    validate_encryption_packet_profile,
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
        manifest = build_backup_manifest(metadata, backup_dir, contracts, policy)
        passphrase = read_passphrase_fd(args.passphrase_fd)
        try:
            for artifact_name in REQUIRED_ENCRYPTED_ARTIFACTS:
                validate_encryption_packet_profile(backup_dir / artifact_name)
            for artifact_name, kind in CONTRACT_ARTIFACTS.items():
                encrypted_contract = decrypt_json(backup_dir / artifact_name, passphrase)
                if canonical_json_bytes(encrypted_contract) != canonical_json_bytes(contracts[kind]):
                    raise RecoveryToolingError(
                        "Encrypted recovery contract does not match its reviewed plaintext input"
                    )
            for artifact_name in set(REQUIRED_ENCRYPTED_ARTIFACTS) - set(CONTRACT_ARTIFACTS):
                authenticate_encrypted_artifact(backup_dir / artifact_name, passphrase)
            output = backup_dir / BACKUP_MANIFEST_NAME
            encrypt_json(manifest, output, passphrase)
        finally:
            passphrase = b""
        print(
            "Encrypted backup manifest created: "
            f"backup_set_id={manifest['backup_set_id']} "
            f"artifacts={len(manifest['artifacts']) + 1} "
            f"manifest_sha256={sha256_file(output)}"
        )
        return 0
    except RecoveryToolingError as exc:
        print(f"Recovery tooling refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
