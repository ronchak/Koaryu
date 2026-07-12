#!/usr/bin/env python3
"""Validate and canonically encrypt one Koaryu recovery JSON contract."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from recovery_tooling import (
    RecoveryToolingError,
    canonical_json_bytes,
    decrypt_json,
    encrypt_json,
    load_json,
    measure_decrypted_artifact,
    read_passphrase_fd,
    sha256_bytes,
    validate_contract,
    validate_encryption_packet_profile,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = (
    SCRIPT_DIR.parent
    / "config"
    / "recovery"
    / "production-data-classification-policy.json"
)
KIND_TO_ARTIFACT = {
    "project-config": "project-config-manifest.json.gpg",
    "restore-integrity": "restore-integrity-manifest.json.gpg",
    "classification-source": "classification-source.json.gpg",
    "classification-manifest": "record-classification-manifest.json.gpg",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and stream canonical JSON directly into a recovery artifact.",
    )
    parser.add_argument("--kind", choices=sorted(KIND_TO_ARTIFACT), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--classification-policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--passphrase-fd", type=int, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    expected_name = KIND_TO_ARTIFACT[args.kind]
    output_created = False
    completed = False
    passphrase = b""
    try:
        if args.output.name != expected_name:
            raise RecoveryToolingError(
                "Encrypted recovery contract output must use its canonical artifact name"
            )
        payload = load_json(args.input, require_private=True)
        policy = (
            load_json(args.classification_policy)
            if args.kind.startswith("classification-")
            else None
        )
        validate_contract(args.kind, payload, policy=policy)
        canonical = canonical_json_bytes(payload)
        passphrase = read_passphrase_fd(args.passphrase_fd)
        encrypt_json(payload, args.output, passphrase)
        output_created = True
        validate_encryption_packet_profile(args.output)
        measurement = measure_decrypted_artifact(args.output, passphrase)
        if (
            measurement["plaintext_size_bytes"] != len(canonical)
            or measurement["plaintext_sha256"] != sha256_bytes(canonical)
            or canonical_json_bytes(decrypt_json(args.output, passphrase)) != canonical
        ):
            raise RecoveryToolingError(
                "Encrypted recovery contract does not contain its validated canonical JSON"
            )
        print(
            "Encrypted recovery contract created: "
            f"kind={args.kind} artifact={expected_name}"
        )
        completed = True
        return 0
    except RecoveryToolingError as exc:
        print(f"Recovery contract encryption refused: {exc}", file=sys.stderr)
        return 2
    finally:
        passphrase = b""
        if output_created and not completed:
            args.output.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
