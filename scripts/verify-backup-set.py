#!/usr/bin/env python3
"""Verify Koaryu encrypted artifacts and optional provider-origin evidence."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from recovery_tooling import (
    RecoveryToolingError,
    load_json,
    read_passphrase_fd,
    verify_backup_set,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = SCRIPT_DIR.parent / "config" / "recovery" / "production-data-classification-policy.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a canonical Koaryu encrypted backup set.")
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--classification-policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--passphrase-fd", type=int, required=True)
    parser.add_argument("--provider-receipt", type=Path)
    parser.add_argument("--known-local-source", type=Path)
    parser.add_argument("--expected-manifest-sha256")
    args = parser.parse_args()
    if bool(args.provider_receipt) != bool(args.known_local_source):
        parser.error("--provider-receipt and --known-local-source must be supplied together")
    if args.provider_receipt and not args.expected_manifest_sha256:
        parser.error("provider-origin verification requires --expected-manifest-sha256")
    return args


def main() -> int:
    args = parse_args()
    try:
        policy = load_json(args.classification_policy)
        receipt = load_json(args.provider_receipt, require_private=True) if args.provider_receipt else None
        passphrase = read_passphrase_fd(args.passphrase_fd)
        try:
            result = verify_backup_set(
                args.backup_dir,
                passphrase,
                policy,
                receipt=receipt,
                known_local_source=args.known_local_source,
                expected_manifest_sha256=args.expected_manifest_sha256,
            )
        finally:
            passphrase = b""
        print(
            "Backup set verified: "
            f"backup_set_id={result['backup_set_id']} "
            f"artifacts={result['artifact_count']} "
            f"provider_origin={'yes' if result['provider_origin_verified'] else 'no'}"
        )
        return 0
    except RecoveryToolingError as exc:
        print(f"Recovery tooling refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
