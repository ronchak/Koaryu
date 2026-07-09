#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNBOOK = ROOT / "docs" / "support-triage.md"
DIGEST_HELPER = ROOT / "scripts" / "support-triage-digest.sh"

RAW_ENDPOINT_MARKERS = (
    "/api/v1/internal/support/tickets",
    "support_triage_list_tickets",
    "SUPPORT_TICKET_COLUMNS",
)

RAW_FIELD_MARKERS = (
    "requester_email",
    "subject",
    "details",
    "page_url",
    "user_agent",
    "browser_context",
)


def section_between(text: str, start_heading: str, end_heading: str) -> str:
    start = text.find(start_heading)
    if start == -1:
        raise ValueError(f"Missing heading: {start_heading}")
    end = text.find(end_heading, start + len(start_heading))
    if end == -1:
        raise ValueError(f"Missing heading after {start_heading}: {end_heading}")
    return text[start:end]


def assert_contains(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"{label} must mention {needle}.")


def assert_excludes(text: str, needles: tuple[str, ...], label: str) -> None:
    matches = [needle for needle in needles if needle in text]
    if matches:
        raise AssertionError(f"{label} must not include raw support-ticket marker(s): {', '.join(matches)}.")


def main() -> int:
    failures: list[str] = []

    try:
        runbook = RUNBOOK.read_text(encoding="utf-8")
        daily_automation = section_between(runbook, "## Daily Automation", "## Verification")
        assert_contains(daily_automation, "support_triage_digest", "Daily automation runbook")
        assert_contains(daily_automation, "sanitized", "Daily automation runbook")
        assert_excludes(daily_automation, RAW_ENDPOINT_MARKERS, "Daily automation runbook")
    except Exception as exc:
        failures.append(str(exc))

    try:
        helper = DIGEST_HELPER.read_text(encoding="utf-8")
        assert_contains(helper, "support_triage_digest", "Support triage digest helper")
        assert_contains(helper, "--confirm-sanitized-linked-query", "Support triage digest helper")
        assert_excludes(helper, RAW_ENDPOINT_MARKERS + RAW_FIELD_MARKERS, "Support triage digest helper")
    except Exception as exc:
        failures.append(str(exc))

    if failures:
        for failure in failures:
            print(f"support privacy audit failed: {failure}", file=sys.stderr)
        return 1

    print("support privacy audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
