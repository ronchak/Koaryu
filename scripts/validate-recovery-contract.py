#!/usr/bin/env python3
"""Validate one secret-free or locked Koaryu recovery contract."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from recovery_tooling import RecoveryToolingError, load_json, validate_contract


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = SCRIPT_DIR.parent / "config" / "recovery" / "production-data-classification-policy.json"
PRIVATE_KINDS = {
    "backup-metadata",
    "project-config",
    "restore-integrity",
    "classification-source",
    "classification-manifest",
    "provider-receipt",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate a Koaryu recovery JSON contract.")
    parser.add_argument(
        "--kind",
        required=True,
        choices=sorted(PRIVATE_KINDS),
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--classification-policy", type=Path, default=DEFAULT_POLICY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        payload = load_json(args.input, require_private=True)
        policy = load_json(args.classification_policy) if args.kind.startswith("classification-") else None
        validate_contract(args.kind, payload, policy=policy)
        print(f"Recovery contract valid: kind={args.kind}")
        return 0
    except RecoveryToolingError as exc:
        print(f"Recovery tooling refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
