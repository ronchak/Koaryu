#!/usr/bin/env python3
"""Classify a privacy-safe exact-snapshot inventory; never mutate source data."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from recovery_tooling import (
    RecoveryToolingError,
    build_classification_manifest,
    load_json,
    write_private_json,
)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_POLICY = SCRIPT_DIR.parent / "config" / "recovery" / "production-data-classification-policy.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a fail-closed classification manifest from a privacy-safe snapshot inventory.",
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        source = load_json(args.input, require_private=True)
        policy = load_json(args.policy)
        manifest = build_classification_manifest(source, policy)
        write_private_json(args.output, manifest)
        counts = manifest["totals"]["classification_counts"]
        print(
            "Classification manifest created: "
            f"records={manifest['totals']['source_count']} "
            f"partition={json.dumps(counts, sort_keys=True, separators=(',', ':'))}"
        )
        return 0
    except RecoveryToolingError as exc:
        print(f"Classification refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
