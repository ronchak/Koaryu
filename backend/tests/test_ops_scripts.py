from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


def _load_connect_smoke_module():
    script_path = ROOT_DIR / "scripts" / "verify-connect-webhook-smoke.py"
    spec = importlib.util.spec_from_file_location("verify_connect_webhook_smoke", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_connect_smoke_signs_with_first_configured_secret(monkeypatch):
    module = _load_connect_smoke_module()
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", " whsec_first ,\n whsec_second ")

    assert module._connect_webhook_secret() == "whsec_first"


def test_support_triage_digest_fails_when_supabase_cli_is_missing(tmp_path):
    script_path = ROOT_DIR / "scripts" / "support-triage-digest.sh"
    result = subprocess.run(
        ["/bin/bash", str(script_path), "--confirm-sanitized-linked-query"],
        capture_output=True,
        env={**os.environ, "PATH": str(tmp_path)},
        text=True,
    )

    assert result.returncode == 127
    assert "Supabase CLI is required" in result.stderr


def test_account_support_verifier_honors_local_target(tmp_path):
    script_path = ROOT_DIR / "scripts" / "verify-supabase-account-support.sh"
    call_log = tmp_path / "calls.txt"
    fake_supabase = tmp_path / "supabase"
    fake_supabase.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$*\" >> \"$CALL_LOG\"\n",
        encoding="utf-8",
    )
    fake_supabase.chmod(0o755)

    result = subprocess.run(
        ["/bin/bash", str(script_path)],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "CALL_LOG": str(call_log),
            "SUPABASE_DB_TARGET": "local",
        },
        text=True,
    )

    assert result.returncode == 0
    calls = call_log.read_text(encoding="utf-8").splitlines()
    assert len(calls) == 3
    assert all(call.startswith("db query --local --file ") for call in calls)
