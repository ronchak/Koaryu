from __future__ import annotations

import re
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Optional

from app.schemas.student import CsvImportIssue, CsvImportOptions
from app.services.student_import_csv import (
    COMMON_IMPORT_DATE_FORMATS,
    STATUS_ALIASES,
    VALID_STATUSES,
    format_program_label,
    make_import_issue,
    normalize_header,
    split_import_full_name,
)


def parse_import_date(
    raw_value: Optional[str],
    field_label: str,
) -> tuple[Optional[str], Optional[str]]:
    if raw_value is None:
        return None, None

    value = raw_value.strip()
    if not value:
        return None, None

    candidates = [value]
    if "T" in value:
        candidates.append(value.split("T", 1)[0])
    if " " in value:
        candidates.append(value.split(" ", 1)[0])

    for candidate in candidates:
        if re.fullmatch(r"\d{5}(?:\.0+)?", candidate):
            serial_value = int(float(candidate))
            if 10_000 <= serial_value <= 60_000:
                return (date(1899, 12, 30) + timedelta(days=serial_value)).isoformat(), None

        try:
            return date.fromisoformat(candidate).isoformat(), None
        except ValueError:
            pass

        for fmt in COMMON_IMPORT_DATE_FORMATS:
            try:
                return datetime.strptime(candidate, fmt).date().isoformat(), None
            except ValueError:
                continue

    return None, f"Invalid {field_label}: '{raw_value}'"


def resolve_belt_rank_reference(
    raw_value: Optional[str],
    *,
    resolved_program_id: Optional[str],
    raw_program_value: Optional[str],
    belt_rank_lookup: dict[str, Any],
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    if raw_value is None:
        return None, None, None

    value = raw_value.strip()
    if not value:
        return None, None, None

    program_label = format_program_label(raw_program_value)
    if raw_program_value and not resolved_program_id:
        return None, "missing", (
            f"Current belt '{raw_value}' could not be matched until {program_label} is set up in this studio."
        )

    try:
        parsed_uuid = str(uuid.UUID(value))
    except ValueError:
        parsed_uuid = None

    if parsed_uuid:
        if parsed_uuid not in belt_rank_lookup["id_lookup"]:
            return None, "missing", f"Current belt '{raw_value}' was not found in this studio"

        if resolved_program_id:
            belt_meta = belt_rank_lookup["rank_meta"].get(parsed_uuid) or {}
            belt_program_id = belt_meta.get("program_id")
            sole_ladder_id = belt_rank_lookup.get("sole_ladder_id")
            belt_ladder_id = belt_meta.get("ladder_id")
            if belt_program_id == resolved_program_id:
                return parsed_uuid, None, None
            if belt_program_id is None and sole_ladder_id and belt_ladder_id == sole_ladder_id:
                return parsed_uuid, None, None
            if belt_program_id != resolved_program_id:
                return None, "missing", (
                    f"Current belt '{raw_value}' does not belong to the ladder for {program_label}."
                )
        return parsed_uuid, None, None

    normalized_name = normalize_header(value)
    if not normalized_name:
        return None, None, None

    if resolved_program_id:
        program_rank_ids = (
            belt_rank_lookup.get("program_rank_name_lookup", {})
            .get(resolved_program_id, {})
            .get(normalized_name, [])
        )
        if len(program_rank_ids) == 1:
            return program_rank_ids[0], None, None
        if len(program_rank_ids) > 1:
            return None, "ambiguous", (
                f"Current belt '{raw_value}' matches multiple belt ranks in the ladder for {program_label}."
            )

        program_ladders = belt_rank_lookup.get("ladders_by_program", {}).get(resolved_program_id, [])
        if not program_ladders:
            sole_ladder_id = belt_rank_lookup.get("sole_ladder_id")
            unscoped_ladder_ids = belt_rank_lookup.get("unscoped_ladder_ids", [])
            if sole_ladder_id and len(unscoped_ladder_ids) == 1 and unscoped_ladder_ids[0] == sole_ladder_id:
                unscoped_rank_ids = belt_rank_lookup.get("unscoped_rank_name_lookup", {}).get(normalized_name, [])
                if len(unscoped_rank_ids) == 1:
                    return unscoped_rank_ids[0], None, None
                if len(unscoped_rank_ids) > 1:
                    return None, "ambiguous", (
                        f"Current belt '{raw_value}' matches multiple belt ranks in the default ladder for {program_label}."
                    )
            if not program_ladders:
                return None, "missing", (
                    f"Current belt '{raw_value}' was not found because {program_label} does not have a belt ladder yet."
                )

        return None, "missing", (
            f"Current belt '{raw_value}' was not found in the belt ladder for {program_label}."
        )

    global_rank_ids = belt_rank_lookup.get("name_to_rank_ids", {}).get(normalized_name, [])
    if len(global_rank_ids) > 1:
        return None, "ambiguous", f"Current belt '{raw_value}' matches multiple belt ranks in this studio"
    if len(global_rank_ids) == 1:
        return global_rank_ids[0], None, None

    return None, "missing", f"Current belt '{raw_value}' was not found in this studio"


def classify_belt_creation_target(
    *,
    resolved_program_id: Optional[str],
    pending_program_name: Optional[str],
    raw_program_value: Optional[str],
    options: CsvImportOptions,
    belt_rank_lookup: dict[str, Any],
) -> dict[str, Any]:
    if resolved_program_id:
        ladders = belt_rank_lookup.get("ladders_by_program", {}).get(resolved_program_id, [])
        if len(ladders) == 1:
            ladder_id = ladders[0]
            ladder_name = (
                (belt_rank_lookup.get("ladder_meta", {}).get(ladder_id) or {}).get("name")
                or "the matching ladder"
            )
            return {
                "mode": "existing_ladder",
                "ladder_id": ladder_id,
                "ladder_name": ladder_name,
                "program_label": format_program_label(raw_program_value),
            }
        if len(ladders) == 0:
            return {
                "mode": "create_program_ladder",
                "program_label": format_program_label(raw_program_value),
            }
        return {
            "mode": "ambiguous_program_ladder",
            "program_label": format_program_label(raw_program_value),
        }

    if pending_program_name and options.create_missing_programs:
        return {
            "mode": "create_program_and_ladder",
            "program_label": pending_program_name.strip(),
        }

    if raw_program_value:
        return {
            "mode": "program_missing",
            "program_label": format_program_label(raw_program_value),
        }

    return {
        "mode": "program_required",
        "program_label": "this row",
    }


def resolve_named_import_reference(
    raw_value: Optional[str],
    *,
    label: str,
    id_lookup: set[str],
    name_lookup: dict[str, str],
    ambiguous_names: set[str],
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    if raw_value is None:
        return None, None, None

    value = raw_value.strip()
    if not value:
        return None, None, None

    try:
        parsed_uuid = str(uuid.UUID(value))
    except ValueError:
        parsed_uuid = None

    if parsed_uuid:
        if parsed_uuid in id_lookup:
            return parsed_uuid, None, None
        return None, "missing", f"{label} '{raw_value}' was not found in this studio"

    normalized_name = normalize_header(value)
    if normalized_name in ambiguous_names:
        return None, "ambiguous", f"{label} '{raw_value}' matches multiple records in this studio"

    resolved_id = name_lookup.get(normalized_name)
    if resolved_id:
        return resolved_id, None, None

    return None, "missing", f"{label} '{raw_value}' was not found in this studio"


def append_import_note(existing: Optional[str], note: str) -> str:
    base = (existing or "").strip()
    if not base:
        return note
    if note in base:
        return base
    return f"{base}\n{note}"


def normalize_import_status(
    raw_value: Optional[str],
    options: CsvImportOptions,
    issues: list[CsvImportIssue],
) -> Optional[str]:
    if raw_value is None:
        return None

    value = raw_value.strip().lower()
    if not value:
        return None

    if options.status_alias_mode == "normalize" and value in STATUS_ALIASES:
        normalized = STATUS_ALIASES[value]
        issues.append(make_import_issue(
            "normalized_status",
            f"Status '{raw_value}' will be imported as '{normalized}'.",
            severity="warning",
            field="status",
            value=raw_value,
        ))
        return normalized

    if value not in VALID_STATUSES:
        issues.append(make_import_issue(
            "invalid_status",
            f'Koaryu does not recognize "{raw_value}" as a student status. Use Active, Trialing, Paused, Inactive, or Canceled, or skip the Status column.',
            field="status",
            value=raw_value,
        ))
        return value

    return value


def build_import_row_plan(
    raw_row: dict,
    mapping: dict[str, str],
    *,
    options: CsvImportOptions,
    program_lookup: Optional[tuple[set[str], dict[str, str], set[str]]] = None,
    belt_rank_lookup: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    mapped: dict = {}
    row_issues: list[CsvImportIssue] = []
    plan: dict[str, Any] = {
        "data": mapped,
        "issues": row_issues,
        "pending_program_name": None,
        "pending_belt_name": None,
        "belt_creation_target_ladder_id": None,
        "belt_creation_requires_new_ladder": False,
        "resolved_program_id": None,
        "resolved_belt_rank_id": None,
        "unresolved_belt_value": None,
    }
    target_counts: dict[str, int] = defaultdict(int)
    for koaryu_field in mapping.values():
        if koaryu_field:
            target_counts[koaryu_field] += 1

    for csv_col, koaryu_field in mapping.items():
        if not koaryu_field:
            continue

        raw_value = raw_row.get(csv_col, "")
        value = raw_value.strip() if isinstance(raw_value, str) else raw_value
        if value in ("", None):
            continue
        if koaryu_field == "full_name":
            first_name, last_name = split_import_full_name(value)
            if first_name and not mapped.get("legal_first_name"):
                mapped["legal_first_name"] = first_name
            if last_name and not mapped.get("legal_last_name"):
                mapped["legal_last_name"] = last_name
            continue
        if koaryu_field == "notes" and target_counts.get("notes", 0) > 1:
            mapped["notes"] = append_import_note(
                mapped.get("notes"),
                f"{csv_col}: {value}",
            )
            continue
        mapped[koaryu_field] = value

    if not mapped.get("legal_first_name"):
        row_issues.append(make_import_issue(
            "missing_first_name",
            "Missing required field: first name",
            field="legal_first_name",
        ))
    if not mapped.get("legal_last_name"):
        row_issues.append(make_import_issue(
            "missing_last_name",
            "Missing required field: last name",
            field="legal_last_name",
        ))

    if mapped.get("status") and isinstance(mapped["status"], str):
        mapped["status"] = normalize_import_status(mapped["status"], options, row_issues)

    if "tags" in mapped and isinstance(mapped["tags"], str):
        mapped["tags"] = [t.strip() for t in mapped["tags"].split(",") if t.strip()]

    for field_name, field_label in (
        ("date_of_birth", "date of birth"),
        ("membership_start_date", "membership start date"),
    ):
        if field_name not in mapped:
            continue
        parsed_date, date_error = parse_import_date(mapped.get(field_name), field_label)
        if date_error:
            row_issues.append(make_import_issue(
                f"invalid_{field_name}",
                date_error,
                field=field_name,
                value=mapped.get(field_name),
            ))
        elif parsed_date:
            mapped[field_name] = parsed_date

    raw_program = mapped.get("program_id") if isinstance(mapped.get("program_id"), str) else None
    if program_lookup and mapped.get("program_id"):
        program_id, program_error_code, program_error = resolve_named_import_reference(
            mapped.get("program_id"),
            label="Program",
            id_lookup=program_lookup[0],
            name_lookup=program_lookup[1],
            ambiguous_names=program_lookup[2],
        )
        if program_error_code == "ambiguous":
            row_issues.append(make_import_issue(
                "ambiguous_program",
                program_error or "Program matches multiple records in this studio",
                field="program_id",
                value=raw_program,
                suggested_action="Choose the correct Program column value or clean up duplicate programs in this studio.",
            ))
        elif program_error_code == "missing":
            if options.create_missing_programs:
                plan["pending_program_name"] = raw_program
                row_issues.append(make_import_issue(
                    "missing_program",
                    f"Program '{raw_program}' will be created during import.",
                    severity="warning",
                    field="program_id",
                    value=raw_program,
                ))
            else:
                row_issues.append(make_import_issue(
                    "missing_program",
                    program_error or f"Program '{raw_program}' was not found in this studio",
                    field="program_id",
                    value=raw_program,
                    suggested_action="Turn on 'Create missing programs' or remove the Program mapping.",
                ))
        elif program_id:
            plan["resolved_program_id"] = program_id

    if belt_rank_lookup and mapped.get("current_belt_rank_id"):
        raw_belt = mapped.get("current_belt_rank_id")
        belt_rank_id, belt_rank_error_code, belt_rank_error = resolve_belt_rank_reference(
            mapped.get("current_belt_rank_id"),
            resolved_program_id=plan.get("resolved_program_id"),
            raw_program_value=raw_program,
            belt_rank_lookup=belt_rank_lookup,
        )
        if belt_rank_error_code == "ambiguous":
            row_issues.append(make_import_issue(
                "ambiguous_belt",
                belt_rank_error or "Current belt matches multiple belt ranks in this studio",
                field="current_belt_rank_id",
                value=raw_belt,
                suggested_action="Set up clearer belt ladders or remove the Current Belt mapping for this import.",
            ))
        elif belt_rank_error_code == "missing":
            plan["unresolved_belt_value"] = raw_belt
            belt_creation_target = classify_belt_creation_target(
                resolved_program_id=plan.get("resolved_program_id"),
                pending_program_name=plan.get("pending_program_name"),
                raw_program_value=raw_program,
                options=options,
                belt_rank_lookup=belt_rank_lookup,
            )
            target_mode = belt_creation_target["mode"]
            plan["belt_creation_target_ladder_id"] = belt_creation_target.get("ladder_id")
            plan["belt_creation_requires_new_ladder"] = target_mode in {
                "create_program_ladder",
                "create_program_and_ladder",
            }
            no_ladder_setup = belt_rank_lookup["ladder_count"] == 0
            issue_code = (
                "missing_belt_ladder"
                if no_ladder_setup or target_mode in {"create_program_ladder", "create_program_and_ladder"}
                else "missing_belt"
            )
            issue_message = (
                f"Current belt '{raw_belt}' could not be matched because this studio does not have a belt ladder set up yet."
                if no_ladder_setup
                else belt_rank_error or f"Current belt '{raw_belt}' was not found in this studio"
            )
            if options.create_missing_belts and target_mode == "existing_ladder":
                plan["pending_belt_name"] = str(raw_belt).strip()
                row_issues.append(make_import_issue(
                    "missing_belt",
                    f"Current belt '{raw_belt}' will be created in '{belt_creation_target['ladder_name']}' during import.",
                    severity="warning",
                    field="current_belt_rank_id",
                    value=raw_belt,
                ))
            elif options.create_missing_belts and target_mode in {"create_program_ladder", "create_program_and_ladder"}:
                plan["pending_belt_name"] = str(raw_belt).strip()
                row_issues.append(make_import_issue(
                    "missing_belt_ladder",
                    f"Current belt '{raw_belt}' will be created in a new ladder for {belt_creation_target['program_label']} during import.",
                    severity="warning",
                    field="current_belt_rank_id",
                    value=raw_belt,
                ))
            elif target_mode == "ambiguous_program_ladder":
                row_issues.append(make_import_issue(
                    "ambiguous_belt_ladder",
                    f"{belt_creation_target['program_label']} has multiple belt ladders, so Koaryu cannot safely auto-create '{raw_belt}'.",
                    field="current_belt_rank_id",
                    value=raw_belt,
                    suggested_action="Choose one ladder for this program in Belt Tracker before importing current belts.",
                ))
            elif target_mode == "program_required":
                if options.import_without_unresolved_belt:
                    row_issues.append(make_import_issue(
                        issue_code,
                        f"{issue_message} Map the Program column if you want Koaryu to create the right ladder and belt automatically. The student can still be imported without a current belt.",
                        severity="warning",
                        field="current_belt_rank_id",
                        value=raw_belt,
                        suggested_action="Map the Program column or set up the ladder manually in Belt Tracker.",
                    ))
                else:
                    row_issues.append(make_import_issue(
                        issue_code,
                        f"{issue_message} Map the Program column if you want Koaryu to create the right ladder and belt automatically.",
                        field="current_belt_rank_id",
                        value=raw_belt,
                        suggested_action="Map the Program column or set up the ladder manually in Belt Tracker.",
                    ))
            elif options.import_without_unresolved_belt:
                row_issues.append(make_import_issue(
                    issue_code,
                    f"{issue_message} The student can still be imported without a current belt.",
                    severity="warning",
                    field="current_belt_rank_id",
                    value=raw_belt,
                    suggested_action=(
                        "Turn on 'Create missing belts' or set up the belt ladder in Belt Tracker to match these students later."
                        if target_mode in {"existing_ladder", "create_program_ladder", "create_program_and_ladder"}
                        else "Set up the belt ladder in Belt Tracker to match these students later."
                    ),
                ))
            else:
                row_issues.append(make_import_issue(
                    issue_code,
                    (
                        f"No belt ladder is set up for {belt_creation_target['program_label']} yet."
                        if target_mode in {"create_program_ladder", "create_program_and_ladder"}
                        else issue_message
                    ),
                    field="current_belt_rank_id",
                    value=raw_belt,
                    suggested_action=(
                        "Turn on 'Create missing belts' or open Belt Tracker and add the missing belt ladder or belt ranks."
                        if target_mode in {"existing_ladder", "create_program_ladder", "create_program_and_ladder"}
                        else "Open Belt Tracker and add the missing ladder or belt ranks."
                    ),
                ))
        elif belt_rank_id:
            plan["resolved_belt_rank_id"] = belt_rank_id

    resolved_program_id = plan.get("resolved_program_id")
    resolved_belt_rank_id = plan.get("resolved_belt_rank_id")
    if resolved_program_id and resolved_belt_rank_id and belt_rank_lookup:
        belt_meta = belt_rank_lookup["rank_meta"].get(resolved_belt_rank_id) or {}
        belt_program_id = belt_meta.get("program_id")
        if belt_program_id and belt_program_id != resolved_program_id:
            row_issues.append(make_import_issue(
                "belt_program_mismatch",
                "The selected Program and Current Belt belong to different ladders.",
                field="current_belt_rank_id",
                value=mapped.get("current_belt_rank_id"),
                suggested_action="Verify the Program mapping or remove the Current Belt mapping for this row.",
            ))

    plan["is_valid"] = not any(issue.severity == "error" for issue in row_issues)
    return plan
