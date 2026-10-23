#!/usr/bin/env python3
"""Verify Koaryu MCP using actual native Auth, PostgREST and disposable PG17.

Supply trusted local Auth/PostgREST binaries. The proof creates its own database,
keys and synthetic owners; no hosted target or existing account is accepted.
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from mcp_oauth_native_scenarios import Scenarios
from mcp_oauth_native_stack import ROOT, NativeStack, private_json


def main():
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-binary", type=Path, required=True)
    parser.add_argument("--postgrest-binary", type=Path, required=True)
    parser.add_argument("--postgres-bin", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument(
        "--auth-source-revision",
        help="Source revision supplied with the native Auth build",
    )
    args = parser.parse_args()
    evidence = args.evidence_dir or Path(tempfile.gettempdir()) / (
        "koaryu-mcp-oauth." + secrets.token_hex(6)
    )
    # Evidence contains private synthetic keys. It may live under an ignored
    # developer directory, never in an ordinary tracked source directory.
    if evidence.resolve().is_relative_to(ROOT):
        ignored = subprocess.run(
            ["git", "check-ignore", "--quiet", str(evidence)], cwd=ROOT, check=False
        )
        if ignored.returncode != 0:
            parser.error("Evidence inside the repository must be ignored by Git")
    candidate = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    binaries = {
        name: hashlib.sha256(path.resolve(strict=True).read_bytes()).hexdigest()
        for name, path in (
            ("auth", args.auth_binary),
            ("postgrest", args.postgrest_binary),
        )
    }
    print("Starting owned native OAuth verification for " + candidate, flush=True)
    try:
        with NativeStack(
            args.auth_binary, args.postgrest_binary, args.postgres_bin, evidence
        ) as stack:
            private_json(
                stack.evidence / "candidate.json",
                {
                    "sha": candidate,
                    "auth_source_revision": args.auth_source_revision,
                    "binary_sha256": binaries,
                    "boundary": "real native Auth/PostgREST/Koaryu backend on owned Unix-only PG17",
                },
            )
            count = Scenarios(stack).run()
    except KeyboardInterrupt:
        print(
            "Native OAuth verification stopped; owned resources cleaned up",
            file=sys.stderr,
        )
        return 130
    except Exception as exc:  # noqa: BLE001 - report CLI failures after owned cleanup.
        print(
            f"FAIL native OAuth verification: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        print("Private synthetic evidence: " + str(evidence), file=sys.stderr)
        return 1
    print(
        f"PASS native OAuth verification: {count} cases; owned processes and cluster cleaned up",
        flush=True,
    )
    print("Private synthetic evidence: " + str(evidence), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
