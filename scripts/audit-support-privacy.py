#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from html import unescape
from html.parser import HTMLParser
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


HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$")
LINE_CONTINUATION_RE = re.compile(r"\\\r?\n[ \t]*")
MARKDOWN_ESCAPE_RE = re.compile(r"\\(?=[\\`*{}\[\]()#+.!_>~\-])")


def _fence_start(line: str) -> tuple[str, int] | None:
    stripped = line.lstrip(" ")
    indent = len(line) - len(stripped)
    if indent > 3 or not stripped or stripped[0] not in {"`", "~"}:
        return None
    fence_char = stripped[0]
    fence_length = len(stripped) - len(stripped.lstrip(fence_char))
    if fence_length < 3:
        return None
    return fence_char, fence_length


def _is_fence_close(line: str, fence_char: str, fence_length: int) -> bool:
    stripped = line.lstrip(" ")
    indent = len(line) - len(stripped)
    closing_length = len(stripped) - len(stripped.lstrip(fence_char))
    return indent <= 3 and closing_length >= fence_length and not stripped[closing_length:].strip()


def _heading_key(line: str) -> str | None:
    if line.startswith("\t"):
        return None
    stripped = line.lstrip(" ")
    if len(line) - len(stripped) > 3:
        return None
    match = HEADING_RE.fullmatch(stripped.rstrip("\r\n"))
    if not match:
        return None
    heading_text = re.sub(r"[ \t]+#+[ \t]*$", "", match.group(2))
    return f"{match.group(1)} {heading_text}"


def _strip_indented_code_prefix(line: str) -> str | None:
    column = 0
    for index, character in enumerate(line):
        if character == " ":
            column += 1
        elif character == "\t":
            column += 4 - (column % 4)
        else:
            return None
        if column >= 4:
            return line[index + 1 :]
    return None


def section_between(text: str, start_heading: str, end_heading: str) -> str:
    lines = text.splitlines(keepends=True)
    start_lines = [index for index, line in enumerate(lines) if _heading_key(line) == start_heading]
    end_lines = [index for index, line in enumerate(lines) if _heading_key(line) == end_heading]

    if not start_lines:
        raise ValueError(f"Missing heading: {start_heading}")
    if len(start_lines) != 1:
        raise ValueError(f"Ambiguous heading: {start_heading}")
    if not end_lines:
        raise ValueError(f"Missing heading after {start_heading}: {end_heading}")
    if len(end_lines) != 1:
        raise ValueError(f"Ambiguous heading after {start_heading}: {end_heading}")

    start_line = start_lines[0]
    end_line = end_lines[0]
    if end_line <= start_line:
        raise ValueError(f"Heading must follow {start_heading}: {end_heading}")
    return "".join(lines[start_line:end_line])


def assert_contains(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"{label} must mention {needle}.")


def assert_excludes(text: str, needles: tuple[str, ...], label: str) -> None:
    normalized_text = text.casefold()
    matches = [needle for needle in needles if needle.casefold() in normalized_text]
    if matches:
        raise AssertionError(f"{label} must not include raw support-ticket marker(s): {', '.join(matches)}.")


def _balanced_delimiter_end(text: str, start: int, opener: str, closer: str) -> int | None:
    depth = 0
    index = start
    while index < len(text):
        character = text[index]
        if character == "\\":
            index += 2
            continue
        if character == opener:
            depth += 1
        elif character == closer:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _markdown_link_labels(text: str) -> str:
    output: list[str] = []
    index = 0
    while index < len(text):
        if text[index] != "[":
            output.append(text[index])
            index += 1
            continue

        label_end = _balanced_delimiter_end(text, index, "[", "]")
        if label_end is None:
            output.append(text[index])
            index += 1
            continue

        destination_start = label_end + 1
        destination_end: int | None = None
        if destination_start < len(text) and text[destination_start] == "(":
            destination_end = _balanced_delimiter_end(text, destination_start, "(", ")")
        elif destination_start < len(text) and text[destination_start] == "[":
            destination_end = _balanced_delimiter_end(text, destination_start, "[", "]")

        if destination_end is None:
            output.append(text[index])
            index += 1
            continue

        if output and output[-1] == "!":
            output.pop()
        output.append(_markdown_link_labels(text[index + 1 : label_end]))
        index = destination_end + 1
    return "".join(output)


class _VisibleHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _html_visible_text(text: str) -> str:
    parser = _VisibleHTMLParser()
    parser.feed(text)
    parser.close()
    return "".join(parser.parts)


def assert_excludes_raw_references(text: str, label: str) -> None:
    decoded = unescape(text)
    collapsed = LINE_CONTINUATION_RE.sub("", decoded)
    visible = _markdown_link_labels(collapsed)
    visible = MARKDOWN_ESCAPE_RE.sub("", visible)
    visible = _html_visible_text(visible)
    visible = visible.replace("[", "").replace("]", "")
    visible = visible.replace("*", "").replace("~", "").replace("`", "")

    markers = RAW_ENDPOINT_MARKERS + RAW_TABLE_MARKERS + RAW_FIELD_MARKERS
    scan_forms = {text.casefold(), decoded.casefold(), collapsed.casefold(), visible.casefold()}
    matches = {
        marker
        for marker in markers
        if any(marker.casefold() in scan_form for scan_form in scan_forms)
    }

    delimiter_stripped = visible.replace("_", "")
    matches.update(
        marker
        for marker in markers
        if marker.replace("_", "").casefold() in delimiter_stripped.casefold()
    )
    if matches:
        raise AssertionError(
            f"{label} must not include raw support-ticket reference(s): {', '.join(sorted(matches))}."
        )


def executable_code(text: str) -> str:
    blocks: list[str] = []
    active_fence_char: str | None = None
    active_fence_length = 0
    active_lines: list[str] = []

    for line in text.splitlines():
        if active_fence_char is None:
            fence = _fence_start(line)
            if fence is not None:
                active_fence_char, active_fence_length = fence
                active_lines = []
            elif (indented_code := _strip_indented_code_prefix(line)) is not None:
                blocks.append(indented_code)
            continue

        if _is_fence_close(line, active_fence_char, active_fence_length):
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
        assert_excludes_raw_references(daily_automation, "Daily automation runbook")
    except Exception as exc:
        failures.append(str(exc))

    try:
        assert_contains(helper, "support_triage_digest", "Support triage digest helper")
        assert_contains(helper, "--confirm-sanitized-linked-query", "Support triage digest helper")
        assert_excludes_raw_references(helper, "Support triage digest helper")
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
