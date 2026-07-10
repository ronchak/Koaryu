from __future__ import annotations

import importlib.util
import os
import runpy
import subprocess
import sys
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


def test_support_privacy_audit_passes_current_runbook_and_helper():
    script_path = ROOT_DIR / "scripts" / "audit-support-privacy.py"
    result = subprocess.run(
        [sys.executable, str(script_path)],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "support privacy audit passed" in result.stdout


def _support_privacy_audit_functions():
    script_path = ROOT_DIR / "scripts" / "audit-support-privacy.py"
    return runpy.run_path(str(script_path))


def test_support_privacy_audit_rejects_raw_ticket_sql_in_automation_commands():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """\n```sql
SELECT requester_email, details FROM public.support_tickets;
```\n"""
    runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](runbook, helper)

    assert any("public.support_tickets" in failure for failure in failures)
    assert any("requester_email" in failure for failure in failures)


def test_support_privacy_audit_rejects_raw_endpoint_in_automation_commands():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """\n```bash
curl https://koaryu.onrender.com/api/v1/internal/support/tickets
```\n"""
    runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](runbook, helper)

    assert any("/api/v1/internal/support/tickets" in failure for failure in failures)


def test_support_privacy_audit_allows_privacy_warnings_in_explanatory_prose():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    warning = (
        "Never query public.support_tickets or public.support_ticket_events for "
        "requester_email, details, page_url, user_agent, or browser_context in this automation.\n\n"
    )
    runbook = runbook.replace("## Verification", f"{warning}## Verification")

    assert audit["audit_texts"](runbook, helper) == []


def test_support_triage_digest_helper_uses_sanitized_rpc_only(tmp_path):
    script_path = ROOT_DIR / "scripts" / "support-triage-digest.sh"
    call_log = tmp_path / "calls.txt"
    fake_supabase = tmp_path / "supabase"
    fake_supabase.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$*\" >> \"$CALL_LOG\"\n",
        encoding="utf-8",
    )
    fake_supabase.chmod(0o755)

    result = subprocess.run(
        ["/bin/bash", str(script_path), "--confirm-sanitized-linked-query", "--limit", "7"],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "CALL_LOG": str(call_log),
        },
        text=True,
    )

    assert result.returncode == 0
    calls = call_log.read_text(encoding="utf-8").splitlines()
    assert calls == ["db query --linked SELECT public.support_triage_digest(7) AS digest;"]


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
