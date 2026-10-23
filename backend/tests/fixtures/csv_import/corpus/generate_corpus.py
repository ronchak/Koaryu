"""Deterministic synthetic CSV bytes and identity truth; Python 3.11 stdlib only.

Pipeline oracle snapshots in scenarios.json are captured by the pytest module's
--capture-oracle command, never by a second implementation of Koaryu's parser.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import unicodedata
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE_ID_ALIASES = [
    "Student ID",
    "Member ID",
    "Member #",
    "Member Number",
    "Legacy Account #",
    "Account #",
    "Account Number",
    "ID",
]
FIRST_NAMES = ["Zelava", "Mioren", "Chloélune", "Évarin", "Ava-Grace", "Téoquin", "Iñara"]
LAST_NAMES = [
    "Quillfen",
    "de la Vey",
    "van Lumen",
    "O'Vel",
    "Solquill Jr",
    "Rivfen Sr",
    "Velquill III",
]
STREETS = ["Imaginary Quill Way", "Invented Lantern Lane", "Fictional Reed Street"]
CITIES = ["Testhaven", "Samplemere", "Fixtureford"]
DOMAINS = ["example.com", "example.net", "example.org", "example.invalid"]
STATUSES = ["Active", "Current", "Trial", "Frozen", "On Hold", "Overdue", "Cancelled", "Uncharted"]
DATE_STYLES = [
    "iso",
    "us",
    "two_digit",
    "dotted",
    "month",
    "excel",
    "datetime",
    "blank",
    "year_only",
    "invalid_month",
    "future",
    "earliest",
]
IDENTITY_FIELDS = (
    "source_system",
    "source_id",
    "legal_first_name",
    "legal_last_name",
    "preferred_name",
    "date_of_birth",
    "email",
    "phone",
)
GUARDIAN_FIELDS = ("guardian_name", "guardian_email", "guardian_phone")
FAMILIES = [
    "twins",
    "three_siblings",
    "step_siblings",
    "parent_child",
    "unrelated_same_name",
    "missing_dob",
    "repeated_formatting",
    "repeated_email",
    "archived_reappears",
    "sibling_email",
    "conflicting_dob_email",
    "guardian_spelling",
    "guardian_same_email_different_parents",
    "guardian_no_email",
    "guardian_placeholder",
    "staff_guardian",
]


def name_key(value):
    original = unicodedata.normalize("NFKD", value or "")
    plain = "".join(c for c in original if not unicodedata.combining(c)).casefold()
    tokens = re.findall(r"[^\W_]+", plain)
    if tokens and tokens[-1] in {"jr", "sr", "ii", "iii", "iv"}:
        tokens.pop()
    return "".join(tokens)


def email_key(value):
    return (value or "").strip().lower() or None


def phone_key(value):
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits[-10:] if len(digits) >= 7 else None


def phone(index):
    number = f"{100 + index % 100:04d}"
    return [
        f"(202) 555-{number}",
        f"202.555.{number}",
        f"+1 202 555 {number}",
        f"202555{number}",
        f"202-555-{number}",
    ][index % 5]


def birth_date(index, style):
    value = date(1950 + index % 76, 1 + index % 12, 1 + index % 28)
    two_digit_value = value.replace(year=2000 + index % 26)
    return {
        "iso": value.isoformat(),
        "us": value.strftime("%m/%d/%Y"),
        "two_digit": two_digit_value.strftime("%m/%d/%y"),
        "dotted": value.strftime("%m.%d.%Y"),
        "month": f"{['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][value.month - 1]} {value.day}, {value.year}",
        "excel": str((value - date(1899, 12, 30)).days),
        "datetime": value.isoformat() + "T12:34:56Z",
        "blank": "",
        "year_only": "2014",
        "invalid_month": "2014-13-03",
        "future": "2026-12-31",
        "earliest": "1950-01-01",
    }[style]


def birth_truth(index, style):
    """Canonical dates authored alongside the fixture's display date formats."""
    if style in {"blank", "year_only", "invalid_month"}:
        return None
    if style == "future":
        return "2026-12-31"
    if style == "earliest":
        return "1950-01-01"
    year = 2000 + index % 26 if style == "two_digit" else 1950 + index % 76
    return date(year, 1 + index % 12, 1 + index % 28).isoformat()


def record(index, seed=0, *, mixed=True):
    first = FIRST_NAMES[index % len(FIRST_NAMES)] + f"{index:05d}"
    last = LAST_NAMES[(index + seed) % len(LAST_NAMES)]
    return {
        "first": first,
        "last": last,
        "preferred": "Zee" if index % 2 else first,
        "dob": birth_date(
            index + seed % 76, DATE_STYLES[index % len(DATE_STYLES)] if mixed else "iso"
        ),
        "_birth_date": birth_truth(
            index + seed % 76, DATE_STYLES[index % len(DATE_STYLES)] if mixed else "iso"
        ),
        "email": f"synthetic.{seed}.{index}@{DOMAINS[index % 4]}",
        "phone": phone(index),
        "status": STATUSES[index % len(STATUSES)] if mixed else "Active",
        "guardian": f"Testjordan{index:05d} Quillfen",
        "guardian_first": f"Testjordan{index:05d}",
        "guardian_last": "Quillfen",
        "guardian_email": f"guardian.{seed}.{index}@example.invalid",
        "guardian_phone": phone(index + 31),
        "guardian_relation": "parent",
        "program": [
            "Moon Forms",
            "moon forms",
            "Moon-Forms",
            "MOON FORMS!",
            "10000000-0000-4000-8000-000000000001",
            "",
        ][index % 6],
        "belt": ["White Belt", "WHITE", "Yellow Belt", "20000000-0000-4000-8000-000000000002", ""][
            index % 5
        ],
        "joined": "2025-01-15",
        "address": f"{1 + index} {STREETS[index % 3]}",
        "city": CITIES[index % 3],
        "state": "ZZ",
        "zip": "00000",
        "emergency": f"Testmior{index:05d} Fixturefen",
        "emergency_phone": phone(index + 52),
        "emergency_relation": "invented contact",
        "notes": "Synthetic only; “curly quotes”, café; line one\nline two",
        "source_id": f"SYN-{seed}-{index:05d}",
        "tuition": "123.45",
        "payment": "Overdue",
        "balance": "12.34",
        "attendance": "2026-09-01",
        "classes": str(index % 30),
    }


def student(
    first, last, dob="2014-09-03", email=None, phone_value=None, *, archived=False, guardians=None
):
    return {
        "key": "s1",
        "legal_first_name": first,
        "legal_last_name": last,
        "preferred_name": first,
        "date_of_birth": dob,
        "email": email,
        "phone": phone_value,
        "archived": archived,
        "guardians": guardians or [],
    }


def guardian(
    first="Jordan", last="Smith", email="family@example.invalid", phone_value="202-555-0198"
):
    return {
        "key": "g1",
        "first_name": first,
        "last_name": last,
        "email": email,
        "phone": phone_value,
    }


def family_records(spec):
    """Truth uses explicit invented households, never surname/contact-only identity."""
    kind = spec["variant"]
    rows = [record(i, spec["seed"], mixed=False) for i in range(spec["row_count"])]
    for row in rows:
        row.update(guardian="", guardian_email="", guardian_phone="")

    def set_row(i, first, last="Quillfen", dob="2014-09-03", **values):
        rows[i].update(
            first=first,
            last=last,
            preferred="UnrelatedPreferred",
            dob=dob,
            _birth_date=dob or None,
            **values,
        )

    roster = []
    if kind == "twins":
        set_row(0, "Testnova")
        roster = [student("Testluma", "Quillfen", guardians=[guardian()])]
        rows[0].update(
            guardian="Jordan Smith",
            guardian_email="family@example.invalid",
            guardian_phone=phone(98),
        )
    elif kind in {"three_siblings", "step_siblings", "sibling_email"}:
        for i, first in enumerate(["Testnova", "Testluma", "Testvero"]):
            set_row(
                i,
                first,
                "Otherfen" if kind == "step_siblings" and i else "Quillfen",
                f"201{1 + i}-09-03",
                guardian="Jordan Smith",
                guardian_email="family@example.invalid",
                guardian_phone=phone(98),
            )
        if kind == "sibling_email":
            rows[1]["email"] = rows[0]["email"]
        roster = [student("Testolder", "Quillfen", "2008-09-03")]
    elif kind == "parent_child":
        set_row(0, "Testarden", "Quillfen Jr", "2014-09-03")
        roster = [student("Testarden", "Quillfen Sr", "1978-09-03")]
    elif kind == "unrelated_same_name":
        set_row(0, "Testarden", dob="2014-09-03")
        roster = [student("Testarden", "Quillfen", "1980-09-03")]
    elif kind == "missing_dob":
        set_row(0, "Testarden", dob="", email="shared@example.invalid")
        set_row(1, "Testarden", dob="2014-09-03", email="shared@example.invalid")
        roster = [student("Testarden", "Quillfen", None, "shared@example.invalid")]
    elif kind == "repeated_formatting":
        set_row(0, "Ava-Grace", "O'Neill")
        set_row(1, "Ava Grace", "ONeill")
        roster = [student("Ava-Grace", "O'Neill")]
    elif kind == "repeated_email":
        set_row(0, "Testarden", email="one@example.invalid")
        set_row(1, "Testarden", email="two@example.invalid")
        roster = [student("Testarden", "Quillfen", email="one@example.invalid")]
    elif kind == "archived_reappears":
        set_row(0, "Testarden")
        roster = [student("Testarden", "Quillfen", archived=True)]
    elif kind == "conflicting_dob_email":
        set_row(0, "Testarden", email="conflict@example.invalid")
        roster = [student("Testarden", "Quillfen", "2012-09-03", "conflict@example.invalid")]
    elif kind == "guardian_spelling":
        rows[0].update(guardian="Jordan Smith", guardian_email="family@example.invalid")
        rows[1].update(guardian="J. Smith", guardian_email="FAMILY@example.invalid")
    elif kind == "guardian_same_email_different_parents":
        rows[0].update(guardian="Jordan Smith", guardian_email="family@example.invalid")
        rows[1].update(guardian="Mioren Quill", guardian_email="family@example.invalid")
    elif kind == "guardian_no_email":
        rows[0].update(guardian="Jordan Smith", guardian_phone=phone(98))
        rows[1].update(guardian="Jordan Smith", guardian_phone="+1 202 555 0198")
        rows[2].update(guardian="Jordan Smith", guardian_phone="")
    elif kind in {"guardian_placeholder", "staff_guardian"}:
        for i, row in enumerate(rows):
            row.update(
                guardian="Testcoach Quill"
                if kind == "staff_guardian"
                else f"Testparent{i} Family{i}",
                guardian_email="staff@example.invalid"
                if kind == "staff_guardian"
                else "placeholder@example.invalid",
                guardian_phone=phone(98),
            )
    elif kind in {"missing_dob_phone", "missing_dob_name", "archived_possible"}:
        contact_phone = phone(98) if kind != "missing_dob_name" else ""
        set_row(0, "Testarden", dob="", email="", phone=contact_phone)
        if kind != "archived_possible":
            set_row(1, "Testarden", email="", phone=contact_phone)
        roster = [
            student(
                "Testarden",
                "Quillfen",
                None if kind == "missing_dob_name" else "2014-09-03",
                phone_value=contact_phone,
                archived=kind == "archived_possible",
            )
        ]
    elif kind in {"guardian_link_name_phone", "guardian_email_first"}:
        rows[0].update(
            guardian="Jordan Quill" if kind == "guardian_email_first" else "Jordan Smith",
            guardian_email="family@example.invalid"
            if kind == "guardian_email_first"
            else "other@example.invalid",
            guardian_phone=phone(98),
        )
        roster = [student("Testunrelated", "Otherfen", guardians=[guardian()])]
    elif kind == "preferred_no_identity":
        set_row(0, "Testnova")
        rows[0]["preferred"] = "Testarden"
        roster = [student("Testarden", "Quillfen")]
    return rows, roster


def script_records(spec):
    """Invented script-native identities; no transliteration equivalence is inferred."""
    numerals = [
        "一",
        "二",
        "三",
        "四",
        "五",
        "六",
        "七",
        "八",
        "九",
        "十",
        "十一",
        "十二",
        "十三",
        "十四",
        "十五",
        "十六",
        "十七",
        "十八",
        "十九",
        "二十",
        "二十一",
        "二十二",
        "二十三",
        "二十四",
        "二十五",
        "二十六",
    ]
    paired = spec["variant"] == "reupload"
    seed = spec["seed"] // 10 if paired else spec["seed"]

    def make_row(index):
        row = record(index, seed, mixed=False)
        first = ("测试曦" if paired else "测试备用") + numerals[index]
        row.update(
            first=first,
            last="虚构",
            preferred=first,
            guardian="",
            guardian_email="",
            guardian_phone="",
        )
        if paired:
            row.update(
                guardian=f"测试监护{numerals[index]} 虚构",
                guardian_email=f"scripts.guardian.{index}@example.invalid",
                guardian_phone=phone(index + 31),
            )
        return row

    rows = [make_row(i) for i in range(spec.get("base_rows", spec["row_count"]))]
    roster = []

    def set_row(index, first, last, dob="2014-09-03", **values):
        rows[index].update(
            first=first, last=last, preferred=first, dob=dob, _birth_date=dob, **values
        )

    kind = spec["variant"]
    if kind in {"cjk_in_file", "cjk_existing"}:
        set_row(
            0,
            "测试曦",
            "虚构",
            guardian="测试监护 虚构",
            guardian_email="scripts.family@example.invalid",
            guardian_phone=phone(98),
        )
        if kind == "cjk_in_file":
            set_row(1, "测试曦", "虚构")
        else:
            roster = [
                student(
                    "测试曦",
                    "虚构",
                    guardians=[guardian("测试监护", "虚构", "scripts.family@example.invalid")],
                )
            ]
    elif kind == "cyrillic_siblings":
        for index, first in enumerate(("Тестмира", "Тестлюна")):
            set_row(
                index,
                first,
                "Вымышленная",
                f"201{index + 2}-09-03",
                guardian="Тестродитель Вымышленная",
                guardian_email="scripts.siblings@example.invalid",
                guardian_phone=phone(98),
            )
        roster = [student("Тестстаршая", "Вымышленная", "2008-09-03")]
    elif kind == "greek_parent_child":
        set_row(
            0,
            "Δοκιμήρα",
            "Φαντασίου Jr",
            guardian="Δοκιμαστής Φαντασίου",
            guardian_email="scripts.shared@example.invalid",
        )
        roster = [
            student(
                "Δοκιμήρα",
                "Φαντασίου Sr",
                "1978-09-03",
                guardians=[guardian("Άλλος", "Γονέας", "scripts.shared@example.invalid")],
            )
        ]
    elif kind in {"arabic_diacritics", "arabic_tatweel"}:
        set_row(0, "تَجْرِيبَا" if kind == "arabic_diacritics" else "تَـجْرِيبَا", "خَيَالِي")
        set_row(1, "تجريبا", "خيالي")
    elif kind == "mixed_repeat":
        set_row(0, "Testmira", "虚构")
        set_row(1, "Testmira", "虚构")
    elif kind == "transliteration_limit":
        set_row(0, "测试曦", "虚构", email="scripts.same.person@example.invalid", phone=phone(98))
        set_row(1, "CeshiXi", "Xugou", email="scripts.same.person@example.invalid", phone=phone(98))
    elif kind == "reupload":
        if spec.get("pair_of"):
            rows = rows[:-3]
            for index in range(6):
                rows[index].update(
                    preferred=f"更正{numerals[index]}", status="Paused", notes="合成更正"
                )
            for index in range(6, 12):
                rows[index]["phone"] = "+1 " + phone_key(rows[index]["phone"])
                rows[index]["dob"] = date.fromisoformat(rows[index]["dob"]).strftime("%m/%d/%Y")
                rows[index]["email"] = rows[index]["email"].upper()
            rows += [make_row(spec["base_rows"] + index) for index in range(2)]
    else:
        raise ValueError(f"Unknown script scenario: {kind}")
    assert len(rows) == spec["row_count"]
    return rows, roster


def source_id_records(spec):
    rows = [record(i, spec["seed"], mixed=False) for i in range(3)]
    roster = []
    variant = spec["variant"]
    if variant == "corrected":
        old = student("Testformer", "Fixturequill")
        old.update(source_system="csv", source_id=rows[0]["source_id"])
        roster = [old]
        rows[0].update(first="Testcorrected", last="Newquill")
    elif variant == "repeated":
        rows[1]["source_id"] = rows[0]["source_id"]
    elif variant == "absent":
        old = student("Testother", "Fixturequill")
        old.update(source_system="csv", source_id="SYN-absent")
        roster = [old]
    elif variant == "partial":
        rows[1]["source_id"] = "  "
        rows[2]["source_id"] = ""
    elif variant == "multiple":
        for row in rows:
            row["other_id"] = "OTHER-" + row["source_id"]
    elif variant == "overlong":
        rows[0]["source_id"] = "X" * 121
        rows[1]["source_id"] = "Y" * 120
        rows[2]["source_id"] = "  trimmed-id  "
    return rows, roster


def records_for(spec):
    if spec["scenario"] == "source_identity":
        return source_id_records(spec)
    if spec["scenario"] == "family_scripts":
        return script_records(spec)
    if spec["scenario"] in {"family_identity", "identity_controls"}:
        return family_records(spec)
    if spec["scenario"] == "reupload_pair":
        rows = [record(i, spec["seed"] // 10, mixed=False) for i in range(spec["base_rows"])]
        if spec.get("pair_of"):
            # Six corrected rows, three removed, two added, and six reformatted.
            rows = rows[:-3]
            for i in range(6):
                rows[i].update(
                    preferred=f"Corrected{i}", status="Paused", notes="Synthetic correction"
                )
            for i in range(6, 12):
                rows[i]["phone"] = "+1 " + phone_key(rows[i]["phone"])
                rows[i]["dob"] = date.fromisoformat(rows[i]["dob"]).strftime("%m/%d/%Y")
                rows[i]["email"] = rows[i]["email"].upper()
            rows += [
                record(spec["base_rows"] + i, spec["seed"] // 10, mixed=False) for i in range(2)
            ]
        return rows, []
    rows = [
        record(i, spec["seed"], mixed=spec["scenario"] not in {"size_boundary", "size_medium"})
        for i in range(spec["row_count"])
    ]
    if spec["scenario"] == "dialect_grid":
        rows[0]["first"] = ""
        rows[1]["last"] = ""
    if spec.get("variant") == "large":
        for row in rows:
            row["notes"] = "Synthetic padding " + "x" * 60
    if spec.get("variant") == "too_large":
        for row in rows:
            row["notes"] = "Synthetic padding " + "x" * 31980
    if spec.get("variant") == "max_cell":
        rows[0]["notes"] = "x" * 32000
    return rows, []


def columns_for(spec, catalogue):
    dialect = catalogue["dialects"][spec["dialect"]]
    columns = [list(c) for c in dialect["columns"]]
    if spec["scenario"] == "source_identity":
        columns = [["First Name", "first"], ["Last Name", "last"], ["DOB", "dob"]]
        if spec["variant"] == "multiple":
            columns += [
                [alias, "source_id" if alias == "Student ID" else "other_id"]
                for alias in reversed(SOURCE_ID_ALIASES)
            ]
        else:
            columns.append([SOURCE_ID_ALIASES[spec["alias_index"]], "source_id"])
    if spec.get("variant") == "large":
        columns = [
            ["First Name", "first"],
            ["Last Name", "last"],
            ["DOB", "dob"],
            ["Notes", "notes"],
        ]
    if spec.get("variant") in {"max_columns", "too_many_columns"}:
        columns += [[f"Synthetic extra {i}", "unused"] for i in range(100 - len(columns))]
        if spec["variant"] == "too_many_columns":
            # Repeating a skipped header keeps auto_mapping within 100 dictionary
            # keys. The parser rejects 101 physical columns before checking names.
            columns.append(["Synthetic extra 0", "unused"])
    if spec.get("variant") == "duplicate_header":
        columns.append(["first_name", "first"])
    if spec.get("variant") == "missing_header_name":
        columns.append(["", "unused"])
    return columns


def content_for(spec, catalogue):
    """Return bytes, literal header list, and independently authored roster truth."""
    if spec["id"] == "mapping_duplicate_email":
        return (
            b"First Name,Last Name,Email,Student Email\nTestava,Fixturequill,testava@example.invalid,testava.alt@example.invalid\n",
            ["First Name", "Last Name", "Email", "Student Email"],
            [],
        )
    if spec["id"] == "mapping_separate_guardian_names":
        return (
            b"First Name,Last Name,Guardian First Name,Guardian Last Name,Guardian Email\nTestava,Fixturequill,Testjordan,Fixturequill,testjordan@example.invalid\n",
            [
                "First Name",
                "Last Name",
                "Guardian First Name",
                "Guardian Last Name",
                "Guardian Email",
            ],
            [],
        )
    dialect = catalogue["dialects"][spec["dialect"]]
    columns = columns_for(spec, catalogue)
    headers = [column[0] for column in columns]
    rows, roster = records_for(spec)
    ending = "\r\n" if spec["line_ending"] == "crlf" else "\n"
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=dialect.get("delimiter", ","), lineterminator=ending)
    writer.writerow(headers)
    for i, row in enumerate(rows):
        row = dict(row)
        fmt = dialect.get("name_format", "separate")
        if fmt == "last_first":
            row["full"] = f"{row['last']}, {row['first']}"
        else:
            extra = " Mior" if fmt == "middle" else ' "Zee"' if fmt == "nickname" else ""
            row["full"] = f"{row['first']}{extra} {row['last']}".strip()
        values = [row.get(source, "") for _, source in columns]
        if spec.get("variant") == "fewer_cells" and i % 2:
            values = values[:2]
        if spec.get("variant") == "trailing_commas":
            values[-2:] = ["", ""]
        if spec.get("variant") == "extra_cells" and i == 0:
            values.append("extra")
        writer.writerow(values)
        if spec.get("variant") == "blank_rows" and i % 2 == 0:
            writer.writerow([])
            writer.writerow([" "] * len(headers))
    text = stream.getvalue()
    if spec.get("variant") == "malformed_quote":
        text = ending.join([text.split(ending)[0], '"unclosed', ""])
    if spec.get("variant") == "header_only":
        text = text.split(ending)[0] + ending
    if spec.get("variant") == "empty":
        text, headers = "", []
    content = (
        b"\xff\xfe" + text.encode("utf-16-le")
        if spec["encoding"] == "utf-16"
        else text.encode(spec["encoding"])
    )
    return content, headers, roster


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def read_json(path):
    """Read a plain JSON document or its deterministic gzip sibling."""
    path = Path(path)
    compressed = path.with_suffix(path.suffix + ".gz")
    if path.exists():
        if compressed.exists():
            raise ValueError(f"Ambiguous JSON storage: {path}")
        return json.loads(path.read_bytes())
    return json.loads(gzip.decompress(compressed.read_bytes()))


def write_json(path, value):
    """Compact first; gzip only above 1 MB, without filename or timestamp headers."""
    path = Path(path)
    compressed = path.with_suffix(path.suffix + ".gz")
    payload = json_bytes(value)
    if len(payload) > 1_000_000:
        stream = io.BytesIO()
        with gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0) as writer:
            writer.write(payload)
        compressed.write_bytes(stream.getvalue())
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(payload)
        compressed.unlink(missing_ok=True)


def compact_oracle_rows(rows):
    return [row for row in rows if not row["valid"] or row["error_codes"] or row.get("notes")]


def oracle_rows(spec):
    rows = spec["oracle"]["rows"]
    if spec["oracle"]["parse"] != "ok":
        assert not rows
        return []
    stored = {row["row_number"]: row for row in rows}
    assert len(stored) == len(rows)
    assert set(stored) <= set(range(2, spec["row_count"] + 2))
    return [
        stored.get(number, {"row_number": number, "valid": True, "error_codes": []})
        for number in range(2, spec["row_count"] + 2)
    ]


def full_name_truth(row, fmt):
    """Legal-name facts for these finite fixture templates, including malformed names.

    This is not a general full-name parser. Missing-name grid cases explicitly
    encode the accepted interpretation of the corpus's seven surname templates.
    """
    first, last = row["first"], row["last"]
    if fmt == "last_first" and first and last:
        return first, last
    if fmt == "last_first" and not last:
        return ",", first
    if fmt in {"middle", "nickname"}:
        token = "Mior" if fmt == "middle" else '"Zee"'
        return (f"{first} {token}".strip(), last) if last else (first, token)
    if not first:
        value = last + ("," if fmt == "last_first" else "")
        if value.startswith(("de la ", "van ")):
            return None, value
        if " " in value:
            return tuple(value.rsplit(" ", 1))
        return value, None
    return first, last or None


def truth_data_for(spec, catalogue):
    """Derive expected mapped data from synthetic source facts, never snapshots.

    Only date/status display forms and the finite name templates need semantic
    transformations. Ignored columns, padding and framing follow the authored
    layout. The live pipeline is checked against every field of this result.
    """
    if spec["oracle"]["parse"] != "ok":
        return []
    dialect = catalogue["dialects"][spec["dialect"]]
    rows, _ = records_for(spec)
    columns = columns_for(spec, catalogue)
    if spec["id"] == "mapping_duplicate_email":
        rows = [{"first": "Testava", "last": "Fixturequill", "email": "testava@example.invalid"}]
        columns = [
            ["First Name", "first"],
            ["Last Name", "last"],
            ["Email", "email"],
            ["Student Email", "unused"],
        ]
    elif spec["id"] == "mapping_separate_guardian_names":
        rows = [
            {
                "first": "Testava",
                "last": "Fixturequill",
                "guardian_first": "Testjordan",
                "guardian_email": "testjordan@example.invalid",
            }
        ]
        columns = [
            ["First Name", "first"],
            ["Last Name", "last"],
            ["Guardian First Name", "guardian_first"],
            ["Guardian Last Name", "unused"],
            ["Guardian Email", "guardian_email"],
        ]
    aliases = {
        "current": "active",
        "frozen": "paused",
        "on hold": "paused",
        "overdue": "paused",
        "trial": "trialing",
    }
    result = []
    for index, row in enumerate(rows):
        mapped = {}
        if dialect.get("delimiter") == ";":
            target = next(iter(spec["oracle"]["mapping"].values()))
            mapped[target] = f"{row['first']};{row['last']}".strip()
        else:
            for position, (header, source) in enumerate(columns):
                target = spec["oracle"]["mapping"].get(header, "")
                value = "full" if source == "full" else row.get(source, "").strip()
                if spec.get("variant") == "fewer_cells" and index % 2 and position >= 2:
                    value = ""
                if spec.get("variant") == "trailing_commas" and position >= len(columns) - 2:
                    value = ""
                if not target or not value:
                    continue
                if target == "full_name":
                    first, last = full_name_truth(row, dialect["name_format"])
                    if first:
                        mapped["legal_first_name"] = first
                    if last:
                        mapped["legal_last_name"] = last
                elif target == "date_of_birth":
                    mapped[target] = row.get("_birth_date") or value
                elif target == "status":
                    mapped[target] = aliases.get(value.lower(), value.lower())
                else:
                    mapped[target] = value
        if mapped.get("source_id"):
            mapped["source_system"] = "csv"
        result.append(mapped)
    return result


def truth_plans(spec, catalogue):
    rows, data = oracle_rows(spec), truth_data_for(spec, catalogue)
    assert len(rows) == len(data)
    return [{**row, "data": value} for row, value in zip(rows, data)]


def default_label(number, data):
    return {
        "row_number": number,
        "valid": True,
        "error_codes": [],
        "duplicate": {"class": "none", "of_row": None, "of_existing": None, "reasons": []},
        "guardian": {
            "class": "new" if guardian_from_data(data) else "none",
            "of_row": None,
            "of_existing": None,
            "reasons": [],
        },
    }


def is_default_label(row):
    return (
        row["valid"]
        and not row["error_codes"]
        and not row.get("notes")
        and row["duplicate"]
        == {"class": "none", "of_row": None, "of_existing": None, "reasons": []}
        and row["guardian"]["class"] in {"none", "new"}
        and row["guardian"]["of_row"] is None
        and row["guardian"]["of_existing"] is None
        and not row["guardian"]["reasons"]
    )


def expanded_rows(entry, catalogue):
    spec = next(spec for spec in catalogue["files"] if spec["id"] == entry["id"])
    stored = {row["row_number"]: row for row in entry["expected"]["rows"]}
    if entry["expected"]["parse"] != "ok":
        assert not stored
        return []
    data = truth_data_for(spec, catalogue)
    assert len(data) == entry["row_count"]
    numbers = range(2, entry["row_count"] + 2)
    assert set(stored) <= set(numbers)
    return [stored.get(number, default_label(number, data[number - 2])) for number in numbers]


def expand_manifest(manifest, catalogue):
    # Copy only containers that change, preserving the exact accepted schema.
    return {
        **manifest,
        "files": [
            {**entry, "expected": {**entry["expected"], "rows": expanded_rows(entry, catalogue)}}
            for entry in manifest["files"]
        ],
    }


def corrected_mapping(auto_mapping, valid):
    if valid:
        return dict(auto_mapping)
    seen = set()
    result = {}
    for header, target in auto_mapping.items():
        result[header] = "" if target and target in seen else target
        if target:
            seen.add(target)
    return result


def identity(plan):
    data = plan["data"]
    result = {key: data.get(key) or None for key in IDENTITY_FIELDS}
    if "invalid_date_of_birth" in plan["error_codes"]:
        result["date_of_birth"] = None
    return result


def guardian_from_data(data):
    raw = (data.get("guardian_name") or "").strip()
    if not raw:
        return None
    first, _, last = raw.partition(" ")
    return {
        "first_name": first,
        "last_name": last.strip(),
        "email": data.get("guardian_email") or None,
        "phone": data.get("guardian_phone") or None,
    }


def imported_roster(plans):
    result = []
    for plan in plans:
        if not plan["valid"]:
            continue
        data = dict(plan["data"])
        contact = guardian_from_data(data)
        row = plan["row_number"]
        if contact:
            contact["key"] = f"g{row}"
        result.append(
            {
                **data,
                **identity(plan),
                "key": f"s{row}",
                "archived": False,
                "guardians": [contact] if contact else [],
            }
        )
    return result


def student_candidate(row, other, *, of_row=None, of_existing=None):
    # Callers index candidates by legal names. Preferred names never enter it.
    same_source_id = bool(row.get("source_system") and row.get("source_id")) and (
        row.get("source_system"),
        row.get("source_id"),
    ) == (other.get("source_system"), other.get("source_id"))
    if not same_source_id and (
        name_key(row.get("legal_first_name")),
        name_key(row.get("legal_last_name")),
    ) != (
        name_key(other.get("legal_first_name")),
        name_key(other.get("legal_last_name")),
    ):
        return None
    left, right = row.get("date_of_birth"), other.get("date_of_birth")
    same_email = email_key(row.get("email")) is not None and email_key(
        row.get("email")
    ) == email_key(other.get("email"))
    if same_source_id:
        confidence, reasons = "strong", ["source_id"]
    elif left and right:
        if left == right:
            confidence, reasons = "strong", ["name", "date_of_birth"]
        elif same_email:
            confidence, reasons = "possible", ["name", "email", "birth_date_conflict"]
        else:
            confidence, reasons = "different_person", []
    elif same_email:
        confidence, reasons = "strong", ["name", "email"]
    elif phone_key(row.get("phone")) and phone_key(row.get("phone")) == phone_key(
        other.get("phone")
    ):
        confidence, reasons = "possible", ["name", "phone"]
    else:
        confidence, reasons = "possible", ["name"]
    rank = 4 if same_source_id else {"strong": 3, "possible": 2, "different_person": 1}[confidence]
    if other.get("archived") and confidence != "different_person":
        label, reasons = "archived_match", reasons + [confidence]
    elif confidence == "different_person":
        label = confidence
    else:
        label = ("in_file_" if of_row is not None else "existing_") + confidence
    return rank, {"class": label, "of_row": of_row, "of_existing": of_existing, "reasons": reasons}


def guardian_candidate(row, other, *, of_row=None, of_existing=None):
    first = name_key(row.get("first_name")) == name_key(other.get("first_name"))
    last = name_key(row.get("last_name")) == name_key(other.get("last_name"))
    same_email = email_key(row.get("email")) is not None and email_key(
        row.get("email")
    ) == email_key(other.get("email"))
    shared = "in_file_shared" if of_row is not None else "link_existing"
    if same_email and (first or last):
        rank, label, reasons = 4, shared, ["email", "first_name" if first else "last_name"]
    elif (
        first
        and last
        and phone_key(row.get("phone"))
        and phone_key(row.get("phone")) == phone_key(other.get("phone"))
    ):
        rank, label, reasons = 3, shared, ["name", "phone"]
    elif same_email:
        rank, label, reasons = 2, "separate_contact", ["email", "name_mismatch"]
    elif first and last:
        rank, label, reasons = 1, "separate_contact", ["name"]
    else:
        return None
    return rank, {"class": label, "of_row": of_row, "of_existing": of_existing, "reasons": reasons}


def labels_for(plans, roster):
    students = defaultdict(list)
    source_ids = defaultdict(list)
    contacts_email, contacts_name = defaultdict(list), defaultdict(list)

    def add_student(value, row=None, key=None):
        names = (name_key(value.get("legal_first_name")), name_key(value.get("legal_last_name")))
        students[names].append((value, row, key))
        if value.get("source_system") and value.get("source_id"):
            source_ids[(value["source_system"], value["source_id"])].append((value, row, key))

    def add_contact(value, row=None, key=None):
        candidate = (value, row, key)
        contacts_email[email_key(value.get("email"))].append(candidate)
        contacts_name[(name_key(value.get("first_name")), name_key(value.get("last_name")))].append(
            candidate
        )

    for value in roster:
        add_student(value, key=value["key"])
        for contact in value["guardians"]:
            add_contact(contact, key=contact["key"])
    labels = []
    for plan in plans:
        row = identity(plan)
        row_number = plan["row_number"]
        candidates = students[(name_key(row["legal_first_name"]), name_key(row["legal_last_name"]))]
        candidates = candidates + [
            item
            for item in source_ids.get((row.get("source_system"), row.get("source_id")), [])
            if item not in candidates
        ]
        # Earlier rows first, in ascending row number. Stable max preserves ties.
        ordered = sorted(candidates, key=lambda c: (c[1] is None, c[1] or 0))
        in_file, existing = [], []
        for other, prior_row, key in ordered:
            match = student_candidate(row, other, of_row=prior_row, of_existing=key)
            if match:
                (in_file if prior_row is not None else existing).append(match)
        chosen_in = max(in_file, key=lambda c: c[0], default=None)
        chosen_existing = max(existing, key=lambda c: c[0], default=None)
        chosen = max(
            [c for c in (chosen_in, chosen_existing) if c], key=lambda c: c[0], default=None
        )
        duplicate = (
            dict(chosen[1])
            if chosen
            else {"class": "none", "of_row": None, "of_existing": None, "reasons": []}
        )
        if chosen_in and chosen_existing:
            duplicate.update(in_file=chosen_in[1], existing=chosen_existing[1])
        contact = guardian_from_data(plan["data"])
        guardian_label = {
            "class": "none" if contact is None else "new",
            "of_row": None,
            "of_existing": None,
            "reasons": [],
        }
        if contact:
            possible = (
                contacts_email.get(email_key(contact.get("email")), [])
                if email_key(contact.get("email"))
                else []
            )
            possible = possible + contacts_name.get(
                (name_key(contact["first_name"]), name_key(contact["last_name"])), []
            )
            possible = sorted(possible, key=lambda c: (c[1] is None, c[1] or 0))
            matches = [
                guardian_candidate(contact, value, of_row=prior_row, of_existing=key)
                for value, prior_row, key in possible
            ]
            best = max([m for m in matches if m], key=lambda m: m[0], default=None)
            if best:
                guardian_label = best[1]
            add_contact(contact, row=row_number)
        labels.append(
            {
                "row_number": row_number,
                "valid": plan["valid"],
                "error_codes": plan["error_codes"],
                "duplicate": duplicate,
                "guardian": guardian_label,
                **({"notes": plan["notes"]} if plan.get("notes") else {}),
            }
        )
        if plan["valid"]:
            add_student(row, row=row_number)
    return labels


def manifest_entry(spec, catalogue):
    content, _, truth_roster = content_for(spec, catalogue)
    oracle = spec["oracle"]
    roster = truth_roster
    if spec.get("pair_of"):
        first = next(item for item in catalogue["files"] if item["id"] == spec["pair_of"])
        roster = imported_roster(truth_plans(first, catalogue))
    expected = {key: value for key, value in oracle.items() if key != "rows"}
    expected["existing_roster"] = roster
    expected["rows"] = [
        row for row in labels_for(truth_plans(spec, catalogue), roster) if not is_default_label(row)
    ]
    return {
        **{
            k: spec[k]
            for k in ("id", "scenario", "dialect", "encoding", "line_ending", "seed", "row_count")
        },
        **({"variant": spec["variant"]} if "variant" in spec else {}),
        **({"pair_of": spec["pair_of"]} if spec.get("pair_of") else {}),
        "path": f"files/{spec['id']}.csv",
        "materialized": len(content) <= 1024 * 1024,
        "byte_count": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "expected": expected,
    }


def generate(out, only=None):
    catalogue = read_json(ROOT / "scenarios.json")
    out = Path(out)
    (out / "files").mkdir(parents=True, exist_ok=True)
    if only:
        specs = [spec for spec in catalogue["files"] if spec["id"] == only]
        if len(specs) != 1:
            raise ValueError(f"Unknown file id: {only}")
        (out / "files" / f"{only}.csv").write_bytes(content_for(specs[0], catalogue)[0])
        return
    entries = []
    for spec in catalogue["files"]:
        entry = manifest_entry(spec, catalogue)
        entries.append(entry)
        target = out / entry["path"]
        if entry["materialized"]:
            target.write_bytes(content_for(spec, catalogue)[0])
        elif target.exists():
            target.unlink()
    largest = sorted(
        (entry for entry in entries if not entry["materialized"]),
        key=lambda e: (-e["byte_count"], e["id"]),
    )[:3]
    for entry in entries:
        entry["slow"] = entry in largest
    write_json(
        out / "manifest.json",
        {
            "version": 1,
            "synthetic": True,
            "generator": "generate_corpus.py",
            "business_date_for_notes": catalogue["business_date_for_notes"],
            "files": entries,
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--out", type=Path)
    destination.add_argument("--expand", type=Path, help="write readable plain JSON for review")
    parser.add_argument("--document", choices=("manifest", "scenarios"), default="manifest")
    parser.add_argument("--only")
    args = parser.parse_args()
    if args.expand:
        if args.only:
            parser.error("--only requires --out")
        catalogue = read_json(ROOT / "scenarios.json")
        document = (
            expand_manifest(read_json(ROOT / "manifest.json"), catalogue)
            if args.document == "manifest"
            else catalogue
        )
        args.expand.write_text(
            json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
    else:
        generate(args.out, args.only)
