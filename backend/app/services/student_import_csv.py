import csv
import io
import re
import uuid
from typing import Any, Optional

from fastapi import HTTPException, status

from app.core.upload_limits import (
    CSV_IMPORT_MAX_BYTES,
    CSV_IMPORT_MAX_CELL_CHARS,
    CSV_IMPORT_MAX_COLUMNS,
    CSV_IMPORT_MAX_ROWS,
)

from app.schemas.student import CsvImportIssue, STUDENT_STATUSES
from app.services.student_import_headers import (
    auto_map_csv_header,
    is_payment_status_header,
    normalize_header,
)


VALID_STATUSES = STUDENT_STATUSES
STATUS_ALIASES = {
    "current": "active",
    "frozen": "paused",
    "hold": "paused",
    "on hold": "paused",
    "overdue": "paused",
    "trial": "trialing",
}
BELT_COLOR_PRESETS = {
    "white": "#F5F5F5",
    "yellow": "#FACC15",
    "gold": "#EAB308",
    "orange": "#F97316",
    "green": "#22C55E",
    "blue": "#3B82F6",
    "purple": "#A855F7",
    "brown": "#92400E",
    "red": "#EF4444",
    "black": "#111827",
    "gray": "#6B7280",
    "grey": "#6B7280",
}
BELT_IMPORT_ORDER = [
    "white",
    "yellow",
    "gold",
    "orange",
    "green",
    "blue",
    "purple",
    "brown",
    "red",
    "black",
    "gray",
    "grey",
]
COMMON_IMPORT_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%m-%d-%y",
    "%m.%d.%Y",
    "%m.%d.%y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%B %d %Y",
    "%b %d %Y",
)
CSV_IMPORT_ENCODINGS = ("utf-8-sig", "cp1252")
CSV_IMPORT_TARGET_FIELDS = {
    "full_name",
    "legal_first_name",
    "legal_last_name",
    "preferred_name",
    "date_of_birth",
    "email",
    "phone",
    "status",
    "membership_start_date",
    "program_id",
    "current_belt_rank_id",
    "notes",
    "tags",
    "address_line1",
    "address_city",
    "address_state",
    "address_zip",
    "emergency_contact_name",
    "emergency_contact_phone",
    "emergency_contact_relation",
    "guardian_name",
    "guardian_email",
    "guardian_phone",
    "guardian_relation",
}

csv.field_size_limit(max(csv.field_size_limit(), CSV_IMPORT_MAX_CELL_CHARS + 1))


def csv_import_error(status_code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=detail)


def decode_csv_import_content(content: bytes) -> str:
    if content.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in content[:200]:
        try:
            text = content.decode("utf-16")
            if text.count("\x00") <= max(1, len(text) // 100):
                return text
        except UnicodeDecodeError:
            pass

    for encoding in CSV_IMPORT_ENCODINGS:
        try:
            text = content.decode(encoding)
        except UnicodeDecodeError:
            continue
        if text.count("\x00") > max(1, len(text) // 100):
            continue
        return text

    raise csv_import_error(
        status.HTTP_400_BAD_REQUEST,
        "Koaryu could not read this CSV. Export it again as a UTF-8 CSV file and try again.",
    )


def is_blank_csv_row(row: list[str]) -> bool:
    return all(not str(value or "").strip() for value in row)


def validate_csv_import_cell(value: Any, *, line_number: int, column_name: str) -> str:
    normalized = "" if value is None else str(value)
    if len(normalized) > CSV_IMPORT_MAX_CELL_CHARS:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            f"Row {line_number} has a value that is too long in '{column_name}'. Shorten that cell and try again.",
        )
    return normalized


def validate_csv_import_mapping(
    mapping: dict[str, str],
    *,
    headers: Optional[list[str]] = None,
) -> None:
    if len(mapping) > CSV_IMPORT_MAX_COLUMNS:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            f"This import mapping has too many columns. Keep imports to {CSV_IMPORT_MAX_COLUMNS} columns or fewer.",
        )

    if headers is not None:
        header_set = set(headers)
        unknown_columns = [column for column in mapping if column not in header_set]
        if unknown_columns:
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                "This import mapping includes a column that is not present in the uploaded CSV.",
            )

    mapped_targets: dict[str, str] = {}
    for csv_column, target_field in mapping.items():
        if not target_field:
            continue

        if target_field not in CSV_IMPORT_TARGET_FIELDS:
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                "This import mapping includes an unsupported Koaryu field.",
            )

        if target_field == "status" and is_payment_status_header(csv_column):
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                f'"{csv_column}" is billing/payment data and cannot be mapped to Student Status. Leave it unmapped or map a roster status column instead.',
            )

        previous_column = mapped_targets.get(target_field)
        if previous_column:
            if target_field == "notes":
                continue
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                f'This import maps both "{previous_column}" and "{csv_column}" to the same Koaryu field. Choose one CSV column and set the other to "Skip this column."',
            )
        mapped_targets[target_field] = csv_column


NAME_PARTICLES = {
    "da",
    "das",
    "de",
    "del",
    "di",
    "dos",
    "du",
    "la",
    "le",
    "saint",
    "st",
    "van",
    "von",
}
NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def normalize_import_name_token(token: str) -> str:
    return re.sub(r"[^a-z]+", "", token.lower())


def split_import_full_name(raw_value: Any) -> tuple[Optional[str], Optional[str]]:
    if raw_value is None:
        return None, None

    value = str(raw_value).strip()
    if not value:
        return None, None

    if "," in value:
        last_name, first_name = [part.strip() for part in value.split(",", 1)]
        if first_name and last_name:
            return first_name, last_name

    parts = value.split()
    if len(parts) < 2:
        return value, None

    last_start = len(parts) - 1
    while last_start > 0 and normalize_import_name_token(parts[last_start - 1]) in NAME_PARTICLES:
        last_start -= 1

    if normalize_import_name_token(parts[-1]) in NAME_SUFFIXES and len(parts) > 2:
        last_start = max(last_start - 1, 1)

    return " ".join(parts[:last_start]), " ".join(parts[last_start:])


def make_import_issue(
    code: str,
    message: str,
    *,
    severity: str = "error",
    field: Optional[str] = None,
    value: Optional[str] = None,
    suggested_action: Optional[str] = None,
) -> CsvImportIssue:
    return CsvImportIssue(
        code=code,
        severity=severity,
        field=field,
        value=value,
        message=message,
        suggested_action=suggested_action,
    )


def infer_belt_color_hex(name: str) -> str:
    tokens = set(normalize_header(name).split())
    for token, color_hex in BELT_COLOR_PRESETS.items():
        if token in tokens:
            return color_hex
    return "#FFFFFF"


def belt_import_sort_key(name: str) -> tuple[int, str]:
    tokens = set(normalize_header(name).split())
    for index, token in enumerate(BELT_IMPORT_ORDER):
        if token in tokens:
            return (index, name.lower())
    return (len(BELT_IMPORT_ORDER), name.lower())


def format_program_label(raw_program_value: Optional[str]) -> str:
    if not raw_program_value:
        return "this program"
    value = raw_program_value.strip()
    if not value:
        return "this program"
    try:
        uuid.UUID(value)
    except ValueError:
        return value
    return "this program"


def parse_student_csv(content: bytes) -> tuple[list[str], list[dict]]:
    if not content:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            "Upload a CSV file with a header row and at least one student row.",
        )
    if len(content) > CSV_IMPORT_MAX_BYTES:
        raise csv_import_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"This CSV is too large. Upload a file under {CSV_IMPORT_MAX_BYTES // (1024 * 1024)} MB.",
        )

    text = decode_csv_import_content(content)
    try:
        reader = csv.reader(io.StringIO(text), strict=True)
        raw_headers = next(reader, None)
    except csv.Error as exc:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            f"Koaryu could not parse the CSV header: {exc}",
        ) from exc

    if not raw_headers or is_blank_csv_row(raw_headers):
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            "This CSV needs a header row before Koaryu can import students.",
        )

    if len(raw_headers) > CSV_IMPORT_MAX_COLUMNS:
        raise csv_import_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"This CSV has too many columns. Keep imports to {CSV_IMPORT_MAX_COLUMNS} columns or fewer.",
        )

    headers: list[str] = []
    seen_headers: set[str] = set()
    for index, raw_header in enumerate(raw_headers, start=1):
        header = validate_csv_import_cell(raw_header, line_number=1, column_name=f"column {index}").strip()
        if not header:
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                f"Column {index} is missing a header name.",
            )
        header_key = normalize_header(header).casefold()
        if header_key in seen_headers:
            raise csv_import_error(
                status.HTTP_400_BAD_REQUEST,
                f"Duplicate CSV header '{header}' found. Rename or remove the duplicate column and try again.",
            )
        seen_headers.add(header_key)
        headers.append(header)

    rows: list[dict] = []
    try:
        for line_number, raw_row in enumerate(reader, start=2):
            if is_blank_csv_row(raw_row):
                continue
            if len(rows) >= CSV_IMPORT_MAX_ROWS:
                raise csv_import_error(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    f"This CSV has too many student rows. Split it into files with {CSV_IMPORT_MAX_ROWS} rows or fewer.",
                )
            if len(raw_row) > len(headers):
                raise csv_import_error(
                    status.HTTP_400_BAD_REQUEST,
                    f"Row {line_number} has more values than the header row. Check for an extra comma or missing quote.",
                )
            padded_row = raw_row + [""] * (len(headers) - len(raw_row))
            rows.append({
                header: validate_csv_import_cell(value, line_number=line_number, column_name=header).strip()
                for header, value in zip(headers, padded_row)
            })
    except csv.Error as exc:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            f"Koaryu could not parse this CSV near row {reader.line_num}. Check for an unclosed quote or broken row.",
        ) from exc

    if not rows:
        raise csv_import_error(
            status.HTTP_400_BAD_REQUEST,
            "This CSV does not include any student rows.",
        )

    return headers, rows
