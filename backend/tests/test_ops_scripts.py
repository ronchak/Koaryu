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
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    assert "`subject`" in runbook
    assert "`summary_seed`" in runbook
    assert "`details withheld`" in runbook


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


def test_support_privacy_audit_rejects_uppercase_sql_in_tilde_postgresql_fence():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """\n~~~postgresql
SELECT REQUESTER_EMAIL, DETAILS FROM PUBLIC.SUPPORT_TICKETS;
~~~\n"""
    runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](runbook, helper)

    assert any("public.support_tickets" in failure for failure in failures)
    assert any("requester_email" in failure for failure in failures)


def test_support_privacy_audit_rejects_raw_ticket_sql_in_indented_code():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")

    for prefix in ("    ", "\t", " \t", "  \t", "   \t"):
        unsafe_block = f"\n{prefix}SELECT requester_email, details FROM public.support_tickets;\n"
        unsafe_runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")
        failures = audit["audit_texts"](unsafe_runbook, helper)

        assert any("public.support_tickets" in failure for failure in failures), repr(prefix)
        assert any("requester_email" in failure for failure in failures), repr(prefix)


def test_support_privacy_audit_ignores_fenced_heading_when_finding_section_end():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """
```text
## Verification
```
```sql
SELECT requester_email, details FROM public.support_tickets;
```
"""
    runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](runbook, helper)

    assert any("Ambiguous heading" in failure for failure in failures)


def test_support_privacy_audit_rejects_raw_ticket_sql_in_blockquoted_code():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_blocks = (
        """
> > ```sql
> > SELECT requester_email, details FROM public.support_tickets;
> > ```
""",
        "\n> >     SELECT requester_email, details FROM public.support_tickets;\n",
    )

    for unsafe_block in unsafe_blocks:
        unsafe_runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")
        failures = audit["audit_texts"](unsafe_runbook, helper)

        assert failures, unsafe_block


def test_support_privacy_audit_rejects_raw_references_in_inline_and_html_code():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_blocks = (
        "\nRun `SELECT requester_email, details FROM public.support_tickets;` nightly.\n",
        "\n<pre><code>SELECT requester_email, details FROM public.support_tickets;</code></pre>\n",
        "\n<pre><code>SELECT details FROM public.support_<em>tickets</em>;</code></pre>\n",
        "\n<pre><code>SELECT details FROM public.support&#95;tickets;</code></pre>\n",
        "\n<https://koaryu.onrender.com/api/v1/internal/support/tickets>\n",
        "\n<a href=\"/api/v1/internal/support/tickets\">raw queue</a>\n",
        '\n```bash\ncurl https://koaryu.onrender.com/api/v1/internal/support/"tickets"\n```\n',
        "\n```bash\ncurl https://koaryu.onrender.com/api/v1/internal/support/$'tickets'\n```\n",
        "\n```bash\ncurl https://koaryu.onrender.com/api/v1/internal/support/%74ickets\n```\n",
        "\n```bash\ncurl https://koaryu.onrender.com/api/v1/internal/support/%25252574ickets\n```\n",
        "\n`https:\\/\\/koaryu.onrender.com\\/api\\/v1\\/internal\\/support\\/tickets`\n",
        "\nQuery public.support_**tickets** and include requester_*email*.\n",
        "\nQuery public.[support_](https://example.invalid)tickets directly.\n",
        "\nQuery public.[support_](https://example.invalid/a_(b))tickets directly.\n",
        "\nQuery public.support\\_tickets directly.\n",
        "\nQuery public.support_<span title=\">\">tickets</span> directly.\n",
        """
```text
> ```
SELECT requester_email, details FROM public.support_tickets;
```
""",
    )

    for unsafe_block in unsafe_blocks:
        unsafe_runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")
        failures = audit["audit_texts"](unsafe_runbook, helper)

        assert failures, unsafe_block


def test_support_privacy_audit_rejects_ambiguous_heading_in_html_code():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """
<pre>
## Verification
</pre>
<pre><code>SELECT requester_email, details FROM public.support_tickets;</code></pre>
"""
    runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](runbook, helper)

    assert any("Ambiguous heading" in failure for failure in failures)


def test_support_privacy_audit_does_not_exempt_warning_prefixed_references():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_lines = (
        "Never mind: use /api/v1/internal/support/tickets directly.\n\n",
        "Do not wait: call support_triage_list_tickets now.\n\n",
        "Never query public.support_tickets unless the digest is unavailable.\n\n",
    )

    for unsafe_line in unsafe_lines:
        unsafe_runbook = runbook.replace("## Verification", f"{unsafe_line}## Verification")
        failures = audit["audit_texts"](unsafe_runbook, helper)

        assert failures


def test_support_privacy_audit_rejects_field_only_inline_and_html_commands():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_blocks = (
        "Run `SELECT requester_email, details FROM private_queue_view` nightly.\n\n",
        "<pre><code>read page_url and user_agent from private_queue_view</code></pre>\n\n",
        "Return requester_email in the digest.\n\n",
        "Output page_url nightly.\n\n",
        "Expose details to the operator.\n\n",
        "Log user_agent for debugging.\n\n",
        "Display browser_context in the report.\n\n",
        "Include the `subject` key in the daily output.\n\n",
        "Fetch the private queue view, then return `subject` key verbatim.\n\n",
    )

    for unsafe_block in unsafe_blocks:
        unsafe_runbook = runbook.replace("## Verification", f"{unsafe_block}## Verification")
        failures = audit["audit_texts"](unsafe_runbook, helper)

        assert failures


def test_support_privacy_audit_rejects_continuation_split_helper_reference():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_helper = helper + '\nprintf "%s" "/api/v1/internal/support/\\\ntickets"\n'

    failures = audit["audit_texts"](runbook, unsafe_helper)

    assert any("/api/v1/internal/support/tickets" in failure for failure in failures)


def test_support_privacy_audit_rejects_blockquoted_continuation_reference():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    unsafe_block = """
> ```bash
> curl https://koaryu.onrender.com/api/v1/internal/support/\\
> tickets
> ```
"""
    unsafe_runbook = runbook.replace("## Verification", f"{unsafe_block}\n## Verification")

    failures = audit["audit_texts"](unsafe_runbook, helper)

    assert any("/api/v1/internal/support/tickets" in failure for failure in failures)


def test_support_privacy_audit_allows_privacy_warnings_in_explanatory_prose():
    audit = _support_privacy_audit_functions()
    runbook = (ROOT_DIR / "docs" / "support-triage.md").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "scripts" / "support-triage-digest.sh").read_text(encoding="utf-8")
    warning = (
        "Never query the raw support tables or request full requester addresses, "
        "ticket descriptions, page locations, browser signatures, or client context.\n\n"
        "> Never bypass the sanitized digest to read private ticket content.\n\n"
        "This schedule is subject to change.\n\n"
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
    stdin_log = tmp_path / "stdin.sql"
    fake_supabase = tmp_path / "supabase"
    fake_supabase.write_text(
        "#!/bin/sh\n"
        "printf 'supabase %s\\n' \"$*\" >> \"$CALL_LOG\"\n"
        "printf '%s\\n' '{\"DB_URL\":\"postgresql://postgres:postgres@127.0.0.1:54322/postgres\"}'\n",
        encoding="utf-8",
    )
    fake_supabase.chmod(0o755)
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        "#!/bin/sh\n"
        "printf 'docker %s\\n' \"$*\" >> \"$CALL_LOG\"\n"
        "if [ \"$1\" = ps ]; then\n"
        "  printf 'fake_db\\t0.0.0.0:54322->5432/tcp\\n'\n"
        "else\n"
        "  printf '%s\\n' '-- koaryu contract boundary --' >> \"$STDIN_LOG\"\n"
        "  cat >> \"$STDIN_LOG\"\n"
        "fi\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    result = subprocess.run(
        ["/bin/bash", str(script_path)],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "CALL_LOG": str(call_log),
            "STDIN_LOG": str(stdin_log),
            "SUPABASE_DB_TARGET": "local",
        },
        text=True,
    )

    assert result.returncode == 0
    calls = call_log.read_text(encoding="utf-8").splitlines()
    assert calls.count("supabase status -o json") == 3
    assert len([call for call in calls if call.startswith("docker ps ")]) == 3
    docker_exec_calls = [call for call in calls if call.startswith("docker exec ")]
    assert len(docker_exec_calls) == 3
    assert all(
        "-i fake_db psql -U postgres -d postgres --no-psqlrc --set=ON_ERROR_STOP=1"
        in call
        for call in docker_exec_calls
    )
    forwarded_sql = stdin_log.read_text(encoding="utf-8")
    for contract_name in (
        "account_support_controls.sql",
        "belt_ladder_sync_smoke.sql",
        "support_triage_smoke.sql",
    ):
        contract = ROOT_DIR / "supabase" / "verification" / contract_name
        assert contract.read_text(encoding="utf-8") in forwarded_sql


def test_supabase_sql_runner_rejects_invalid_and_unconfigured_linked_targets(tmp_path):
    script_path = ROOT_DIR / "scripts" / "run-supabase-sql.sh"
    sql_file = ROOT_DIR / "supabase" / "verification" / "support_triage_smoke.sql"

    invalid_target = subprocess.run(
        ["/bin/bash", str(script_path), str(sql_file)],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "SUPABASE_DB_TARGET": "production",
        },
        text=True,
    )
    assert invalid_target.returncode == 2
    assert "must be 'linked' or 'local'" in invalid_target.stderr

    missing_linked_url = subprocess.run(
        ["/bin/bash", str(script_path), str(sql_file)],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "SUPABASE_DB_TARGET": "linked",
            "SUPABASE_DB_URL": "",
        },
        text=True,
    )
    assert missing_linked_url.returncode == 2
    assert "SUPABASE_DB_URL is required" in missing_linked_url.stderr


def _run_local_sql_runner_with_container_output(tmp_path, container_output):
    script_path = ROOT_DIR / "scripts" / "run-supabase-sql.sh"
    sql_file = ROOT_DIR / "supabase" / "verification" / "support_triage_smoke.sql"
    fake_supabase = tmp_path / "supabase"
    fake_supabase.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' '{\"DB_URL\":\"postgresql://postgres:postgres@127.0.0.1:54322/postgres\"}'\n",
        encoding="utf-8",
    )
    fake_supabase.chmod(0o755)
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = ps ]; then\n"
        "  printf '%s' \"$CONTAINER_OUTPUT\"\n"
        "fi\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    return subprocess.run(
        ["/bin/bash", str(script_path), str(sql_file)],
        capture_output=True,
        env={
            **os.environ,
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "SUPABASE_DB_TARGET": "local",
            "CONTAINER_OUTPUT": container_output,
        },
        text=True,
    )


def test_supabase_sql_runner_fails_closed_on_missing_or_ambiguous_local_container(tmp_path):
    missing = _run_local_sql_runner_with_container_output(tmp_path, "")
    assert missing.returncode == 1
    assert "exactly one local Supabase database container" in missing.stderr

    ambiguous = _run_local_sql_runner_with_container_output(
        tmp_path,
        "db_one\\t0.0.0.0:54322->5432/tcp\\n"
        "db_two\\t0.0.0.0:54322->5432/tcp\\n",
    )
    assert ambiguous.returncode == 1
    assert "exactly one local Supabase database container" in ambiguous.stderr
