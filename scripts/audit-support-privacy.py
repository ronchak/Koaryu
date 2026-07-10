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

RAW_TABLE_MARKERS = (
    "public.support_tickets",
    "public.support_ticket_events",
    "support_tickets",
    "support_ticket_events",
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
    normalized_text = text.casefold()
    matches = [needle for needle in needles if needle.casefold() in normalized_text]
    if matches:
        raise AssertionError(f"{label} must not include raw support-ticket marker(s): {', '.join(matches)}.")


def executable_code(text: str) -> str:
    blocks: list[str] = []
    active_fence_char: str | None = None
    active_fence_length = 0
    active_lines: list[str] = []

    for line in text.splitlines():
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if active_fence_char is None:
            if indent > 3 or not stripped or stripped[0] not in {"`", "~"}:
                continue
            fence_char = stripped[0]
            fence_length = len(stripped) - len(stripped.lstrip(fence_char))
            if fence_length >= 3:
                active_fence_char = fence_char
                active_fence_length = fence_length
                active_lines = []
            continue

        closing = line.lstrip(" ")
        closing_indent = len(line) - len(closing)
        closing_length = len(closing) - len(closing.lstrip(active_fence_char))
        if (
            closing_indent <= 3
            and closing_length >= active_fence_length
            and not closing[closing_length:].strip()
        ):
            blocks.append("\n".join(active_lines))
            active_fence_char = None
            active_fence_length = 0
            active_lines = []
            continue
        active_lines.append(line)

    if active_fence_char is not None:
        blocks.append("\n".join(active_lines))
    return "\n".join(blocks)


def audit_texts(runbook: str, helper: str) -> list[str]:
    failures: list[str] = []

    try:
        daily_automation = section_between(runbook, "## Daily Automation", "## Verification")
        daily_commands = executable_code(daily_automation)
        assert_contains(daily_automation, "support_triage_digest", "Daily automation runbook")
        assert_contains(daily_automation, "sanitized", "Daily automation runbook")
        assert_contains(daily_commands, "support_triage_digest", "Daily automation commands")
        assert_excludes(
            daily_commands,
            RAW_ENDPOINT_MARKERS + RAW_TABLE_MARKERS + RAW_FIELD_MARKERS,
            "Daily automation commands",
        )
    except Exception as exc:
        failures.append(str(exc))

    try:
        assert_contains(helper, "support_triage_digest", "Support triage digest helper")
        assert_contains(helper, "--confirm-sanitized-linked-query", "Support triage digest helper")
        assert_excludes(
            helper,
            RAW_ENDPOINT_MARKERS + RAW_TABLE_MARKERS + RAW_FIELD_MARKERS,
            "Support triage digest helper",
        )
    except Exception as exc:
        failures.append(str(exc))

    return failures


def main() -> int:
    failures = audit_texts(
        RUNBOOK.read_text(encoding="utf-8"),
        DIGEST_HELPER.read_text(encoding="utf-8"),
    )

    if failures:
        for failure in failures:
            print(f"support privacy audit failed: {failure}", file=sys.stderr)
        return 1

    print("support privacy audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
