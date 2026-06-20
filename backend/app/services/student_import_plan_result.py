from __future__ import annotations

from typing import Any

from app.schemas.student import (
    CsvImportActionOptions,
    CsvImportResult,
    CsvImportRow,
    CsvImportSetupIssue,
    CsvImportWarning,
)


def build_import_result(
    rows: list[dict[str, Any]],
    *,
    total_rows: int,
) -> CsvImportResult:
    issue_rows: list[CsvImportRow] = []
    valid_rows = 0
    error_rows = 0
    normalized_status_rows: list[int] = []
    normalized_status_values: set[str] = set()
    unresolved_belt_rows: list[int] = []
    unresolved_belt_values: set[str] = set()
    setup_buckets: dict[str, dict[str, Any]] = {
        "missing_program": {"row_numbers": [], "values": set(), "severity": "warning"},
        "ambiguous_program": {"row_numbers": [], "values": set(), "severity": "error"},
        "missing_belt_ladder": {"row_numbers": [], "values": set(), "severity": "warning"},
        "missing_belt": {"row_numbers": [], "values": set(), "severity": "warning"},
        "ambiguous_belt": {"row_numbers": [], "values": set(), "severity": "error"},
        "ambiguous_belt_ladder": {"row_numbers": [], "values": set(), "severity": "error"},
    }

    for row in rows:
        if row["is_valid"]:
            valid_rows += 1
        else:
            error_rows += 1

        if row["issues"]:
            error_messages = [
                issue.message for issue in row["issues"] if issue.severity == "error"
            ]
            warning_messages = [
                issue.message for issue in row["issues"] if issue.severity == "warning"
            ]
            issue_rows.append(CsvImportRow(
                row_number=row["row_number"],
                data=row["data"],
                issues=row["issues"],
                errors=error_messages,
                warnings=warning_messages,
                is_valid=row["is_valid"],
            ))

        for issue in row["issues"]:
            if issue.code == "normalized_status":
                normalized_status_rows.append(row["row_number"])
                if issue.value:
                    normalized_status_values.add(issue.value)
            if (
                issue.code in {"missing_belt", "missing_belt_ladder"}
                and row["is_valid"]
                and not row.get("pending_belt_name")
            ):
                unresolved_belt_rows.append(row["row_number"])
                if issue.value:
                    unresolved_belt_values.add(issue.value)
            bucket = setup_buckets.get(issue.code)
            if bucket is not None:
                bucket["row_numbers"].append(row["row_number"])
                if issue.value:
                    bucket["values"].add(issue.value)
                if issue.severity == "error":
                    bucket["severity"] = "error"

    warnings: list[CsvImportWarning] = []
    if normalized_status_rows:
        warnings.append(CsvImportWarning(
            code="normalized_status",
            message="Some student statuses will be normalized during import.",
            row_numbers=normalized_status_rows,
            field="status",
            values=sorted(normalized_status_values),
        ))
    if unresolved_belt_rows:
        warnings.append(CsvImportWarning(
            code="import_without_belt",
            message="Some students will be imported without a current belt until your ladder is configured.",
            row_numbers=unresolved_belt_rows,
            field="current_belt_rank_id",
            values=sorted(unresolved_belt_values),
            suggested_action="Open Belt Tracker after import to finish assigning belts.",
        ))

    setup_issues: list[CsvImportSetupIssue] = []
    can_create_missing_belts = any(
        row.get("unresolved_belt_value")
        and (row.get("belt_creation_target_ladder_id") or row.get("belt_creation_requires_new_ladder"))
        for row in rows
    )
    if setup_buckets["missing_program"]["row_numbers"]:
        severity = setup_buckets["missing_program"]["severity"]
        setup_issues.append(CsvImportSetupIssue(
            code="missing_program",
            severity=severity,
            message=(
                "This CSV references programs that are not set up in this studio yet."
                if severity == "error"
                else "Some programs are missing today and will be created during import."
            ),
            row_numbers=setup_buckets["missing_program"]["row_numbers"],
            values=sorted(setup_buckets["missing_program"]["values"]),
            suggested_action="Create missing programs during import or remove the Program mapping.",
        ))
    if setup_buckets["ambiguous_program"]["row_numbers"]:
        setup_issues.append(CsvImportSetupIssue(
            code="ambiguous_program",
            severity="error",
            message="Some Program values match multiple programs in this studio.",
            row_numbers=setup_buckets["ambiguous_program"]["row_numbers"],
            values=sorted(setup_buckets["ambiguous_program"]["values"]),
            suggested_action="Clean up duplicate programs or remove the Program mapping for those rows.",
        ))
    if setup_buckets["missing_belt_ladder"]["row_numbers"]:
        severity = setup_buckets["missing_belt_ladder"]["severity"]
        if can_create_missing_belts:
            missing_belt_ladder_message = (
                "It looks like some programs do not have belt ladders set up yet, but Koaryu can create them during import."
            )
        elif severity == "error":
            missing_belt_ladder_message = (
                "It looks like your belt ladder is not set up yet, so current belt values cannot be matched."
            )
        else:
            missing_belt_ladder_message = (
                "Your belt ladder is not set up yet. Students can still be imported without current belts."
            )
        setup_issues.append(CsvImportSetupIssue(
            code="missing_belt_ladder",
            severity=severity,
            message=missing_belt_ladder_message,
            row_numbers=setup_buckets["missing_belt_ladder"]["row_numbers"],
            values=sorted(setup_buckets["missing_belt_ladder"]["values"]),
            suggested_action=(
                "Turn on 'Create missing belts' to create ladders for those programs during import."
                if can_create_missing_belts
                else "Open Belt Tracker and configure your ladder."
            ),
        ))
    if setup_buckets["missing_belt"]["row_numbers"]:
        severity = setup_buckets["missing_belt"]["severity"]
        if can_create_missing_belts:
            missing_belt_message = (
                "Some current belt values do not match their program ladders yet, but Koaryu can create them during import."
            )
        elif severity == "error":
            missing_belt_message = (
                "Some current belt values do not match the belt ladder configured for this studio."
            )
        else:
            missing_belt_message = (
                "Some current belt values do not match this studio's ladder, but those students can still import without belts."
            )
        setup_issues.append(CsvImportSetupIssue(
            code="missing_belt",
            severity=severity,
            message=missing_belt_message,
            row_numbers=setup_buckets["missing_belt"]["row_numbers"],
            values=sorted(setup_buckets["missing_belt"]["values"]),
            suggested_action=(
                "Turn on 'Create missing belts' to add these ranks to the matching program ladders during import."
                if can_create_missing_belts
                else "Open Belt Tracker to add or reconcile the missing belt names."
            ),
        ))
    if setup_buckets["ambiguous_belt"]["row_numbers"]:
        setup_issues.append(CsvImportSetupIssue(
            code="ambiguous_belt",
            severity="error",
            message="Some current belt values match multiple belt ranks in this studio.",
            row_numbers=setup_buckets["ambiguous_belt"]["row_numbers"],
            values=sorted(setup_buckets["ambiguous_belt"]["values"]),
            suggested_action="Resolve duplicate belt rank names or remove the Current Belt mapping for those rows.",
        ))
    if setup_buckets["ambiguous_belt_ladder"]["row_numbers"]:
        setup_issues.append(CsvImportSetupIssue(
            code="ambiguous_belt_ladder",
            severity="error",
            message="Some programs have multiple belt ladders, so Koaryu cannot safely decide where new belts belong.",
            row_numbers=setup_buckets["ambiguous_belt_ladder"]["row_numbers"],
            values=sorted(setup_buckets["ambiguous_belt_ladder"]["values"]),
            suggested_action="Reduce each program to one ladder or assign current belts manually after import.",
        ))

    actions_available = CsvImportActionOptions(
        can_create_missing_programs=bool(setup_buckets["missing_program"]["row_numbers"]),
        can_create_missing_belts=can_create_missing_belts,
        can_import_without_unresolved_belt=bool(
            setup_buckets["missing_belt"]["row_numbers"]
            or setup_buckets["missing_belt_ladder"]["row_numbers"]
        ),
        belt_tracker_href=(
            "/belt-tracker"
            if setup_buckets["missing_belt"]["row_numbers"]
            or setup_buckets["missing_belt_ladder"]["row_numbers"]
            or setup_buckets["ambiguous_belt"]["row_numbers"]
            else None
        ),
    )

    return CsvImportResult(
        total_rows=total_rows,
        valid_rows=valid_rows,
        error_rows=error_rows,
        rows=issue_rows,
        errors=[row for row in issue_rows if not row.is_valid],
        warnings=warnings,
        setup_issues=setup_issues,
        actions_available=actions_available,
        imported_without_belt_count=len(unresolved_belt_rows),
        normalized_status_count=len(normalized_status_rows),
    )
