#!/usr/bin/env python3
"""Copy the pure domain catalog into the browser's sample-only preview bundle."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.workflow_catalog import get_workflow_catalog  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    destination = ROOT / "frontend/src/lib/generated/workflow-preview-catalog.json"
    expected = json.dumps(get_workflow_catalog(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.check:
        if not destination.exists() or destination.read_text(encoding="utf-8") != expected:
            print("Workflow preview catalog differs. Run npm run generate:workflow-preview-catalog.")
            return 1
        print("Workflow preview catalog matches the domain catalog.")
        return 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(expected, encoding="utf-8")
    print("Generated frontend/src/lib/generated/workflow-preview-catalog.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
