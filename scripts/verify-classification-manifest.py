#!/usr/bin/env python3
"""Verify totality, uniqueness, and partition invariants for classification."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from recovery_tooling import (
    RecoveryToolingError,
    load_json,
    verify_classification_manifest,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = SCRIPT_DIR.parent / "config" / "recovery" / "production-data-classification-policy.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a Koaryu classification manifest.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        source = load_json(args.source, require_private=True)
        manifest = load_json(args.manifest, require_private=True)
        policy = load_json(args.policy)
        verify_classification_manifest(source, manifest, policy)
        counts = manifest["totals"]["classification_counts"]
        print(
            "Classification manifest verified: "
            f"records={manifest['totals']['source_count']} "
            f"partition={json.dumps(counts, sort_keys=True, separators=(',', ':'))}"
        )
        return 0
    except RecoveryToolingError as exc:
        print(f"Classification verification refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
