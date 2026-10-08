#!/usr/bin/env python3
"""Check frozen V57 retention before creating a database or replaying history."""

import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
import v57_retained_function_verification as verification

path = "supabase/migrations/20261005105341_automation_workflow_graph_v57.sql"
accepted = subprocess.check_output(
    ["git", "show", verification.BASE + ":" + path], cwd=ROOT
).decode()
print(
    json.dumps(
        verification.verify_retained_sources(accepted, (ROOT / path).read_bytes().decode()),
        sort_keys=True,
    )
)
