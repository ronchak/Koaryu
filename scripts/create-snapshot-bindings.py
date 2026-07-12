#!/usr/bin/env python3
"""Measure locked plaintext payloads and emit deterministic snapshot bindings."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from recovery_tooling import (
    SNAPSHOT_PAYLOAD_ARTIFACTS,
    RecoveryToolingError,
    compute_snapshot_digest,
    measure_private_file,
    write_private_json,
)


ARGUMENT_TO_ARTIFACT = {
    "roles": "roles.sql.gpg",
    "schema": "schema.sql.gpg",
    "data": "data.sql.gpg",
    "migration_history_schema": "migration-history-schema.sql.gpg",
    "migration_history_data": "migration-history-data.sql.gpg",
    "storage_objects": "storage-objects.tar.gpg",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create the canonical database snapshot digest from exact locked plaintext payloads.",
    )
    for argument in ARGUMENT_TO_ARTIFACT:
        parser.add_argument(f"--{argument.replace('_', '-')}", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        bindings = {}
        for argument, artifact_name in ARGUMENT_TO_ARTIFACT.items():
            measurement = measure_private_file(getattr(args, argument), encrypted=False)
            if measurement["size_bytes"] < 1:
                raise RecoveryToolingError("Snapshot payloads must not be empty")
            bindings[artifact_name] = {
                "plaintext_size_bytes": measurement["size_bytes"],
                "plaintext_sha256": measurement["sha256"],
            }
        output = {
            "schema_version": 1,
            "database_snapshot_digest": compute_snapshot_digest(bindings),
            "snapshot_artifacts": [
                {"name": name, **bindings[name]}
                for name in SNAPSHOT_PAYLOAD_ARTIFACTS
            ],
        }
        write_private_json(args.output, output)
        print(
            "Snapshot bindings created: "
            f"artifacts={len(bindings)} "
            f"database_snapshot_digest={output['database_snapshot_digest']}"
        )
        return 0
    except RecoveryToolingError as exc:
        print(f"Snapshot binding refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
