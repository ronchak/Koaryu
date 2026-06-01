from __future__ import annotations

import re


CSV_PAYMENT_STATUS_TOKENS = {
    "account",
    "balance",
    "billing",
    "dues",
    "fee",
    "fees",
    "invoice",
    "paid",
    "payment",
    "subscription",
    "autopay",
    "auto",
    "tuition",
}


def normalize_header(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", header.strip().lower()).strip()


def compact_header(header: str) -> str:
    return normalize_header(header).replace(" ", "")


def is_payment_status_header(header: str) -> bool:
    tokens = set(normalize_header(header).split())
    compact = compact_header(header)
    return (
        "status" in tokens
        and bool(tokens & CSV_PAYMENT_STATUS_TOKENS)
    ) or any(f"{token}status" in compact for token in CSV_PAYMENT_STATUS_TOKENS)


RAW_CSV_FIELD_ALIASES: dict[str, str] = {
    "first name": "legal_first_name",
    "first_names": "legal_first_name",
    "student first name": "legal_first_name",
    "given name": "legal_first_name",
    "given": "legal_first_name",
    "child": "legal_first_name",
    "forename": "legal_first_name",
    "full student name": "full_name",
    "student full name": "full_name",
    "student name": "full_name",
    "full name": "full_name",
    "last name": "legal_last_name",
    "last_names": "legal_last_name",
    "student last name": "legal_last_name",
    "surname": "legal_last_name",
    "family name": "legal_last_name",
    "preferred name": "preferred_name",
    "preferred first name": "preferred_name",
    "nickname": "preferred_name",
    "nick name": "preferred_name",
    "dob": "date_of_birth",
    "date of birth": "date_of_birth",
    "birth date": "date_of_birth",
    "birthdate": "date_of_birth",
    "birthday": "date_of_birth",
    "student birthday": "date_of_birth",
    "email": "email",
    "email address": "email",
    "student email": "email",
    "phone": "phone",
    "phone number": "phone",
    "mobile": "phone",
    "mobile number": "phone",
    "cell": "phone",
    "cell phone": "phone",
    "cellphone": "phone",
    "telephone": "phone",
    "account status": "",
    "billing status": "",
    "invoice status": "",
    "paid status": "",
    "payment status": "",
    "subscription status": "",
    "autopay status": "",
    "auto pay status": "",
    "tuition status": "",
    "status": "status",
    "student status": "status",
    "notes": "notes",
    "note": "notes",
    "tags": "tags",
    "tag": "tags",
    "labels": "tags",
    "program": "program_id",
    "program name": "program_id",
    "student program": "program_id",
    "membership program": "program_id",
    "current belt": "current_belt_rank_id",
    "current belt rank": "current_belt_rank_id",
    "current rank": "current_belt_rank_id",
    "rank": "current_belt_rank_id",
    "rank belt": "current_belt_rank_id",
    "rank/belt": "current_belt_rank_id",
    "belt rank": "current_belt_rank_id",
    "guardian name": "guardian_name",
    "guardian full name": "guardian_name",
    "parent name": "guardian_name",
    "parent full name": "guardian_name",
    "parent guardian name": "guardian_name",
    "guardian email": "guardian_email",
    "parent email": "guardian_email",
    "guardian phone": "guardian_phone",
    "guardian phone number": "guardian_phone",
    "guardian mobile": "guardian_phone",
    "parent phone": "guardian_phone",
    "parent phone number": "guardian_phone",
    "parent mobile": "guardian_phone",
    "relation": "guardian_relation",
    "guardian relation": "guardian_relation",
    "guardian relationship": "guardian_relation",
    "parent relation": "guardian_relation",
    "parent relationship": "guardian_relation",
    "membership start date": "membership_start_date",
    "membership date": "membership_start_date",
    "enrollment date": "membership_start_date",
    "enrolment date": "membership_start_date",
    "start date": "membership_start_date",
    "join date": "membership_start_date",
    "joined on": "membership_start_date",
    "member since": "membership_start_date",
    "address": "address_line1",
    "address line 1": "address_line1",
    "street address": "address_line1",
    "city": "address_city",
    "state": "address_state",
    "province": "address_state",
    "zip": "address_zip",
    "zip code": "address_zip",
    "postal code": "address_zip",
    "emergency contact name": "emergency_contact_name",
    "emergency name": "emergency_contact_name",
    "emergency contact phone": "emergency_contact_phone",
    "emergency phone": "emergency_contact_phone",
    "emergency contact relation": "emergency_contact_relation",
    "emergency relation": "emergency_contact_relation",
}

CSV_FIELD_ALIASES: dict[str, str] = {
    normalize_header(alias): field for alias, field in RAW_CSV_FIELD_ALIASES.items()
}
COMPACT_CSV_FIELD_ALIASES: dict[str, str] = {
    compact_header(alias): field for alias, field in RAW_CSV_FIELD_ALIASES.items()
}


def infer_csv_field_from_tokens(tokens: set[str]) -> str:
    if not tokens:
        return ""

    if "hold" in tokens:
        return ""

    if "guardian" in tokens or "parent" in tokens:
        if {"email", "mail"} & tokens:
            return "guardian_email"
        if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
            return "guardian_phone"
        if {"relation", "relationship"} & tokens:
            return "guardian_relation"
        if {"name", "contact"} & tokens:
            return "guardian_name"

    if "emergency" in tokens:
        if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
            return "emergency_contact_phone"
        if {"relation", "relationship"} & tokens:
            return "emergency_contact_relation"
        if {"name", "contact"} & tokens:
            return "emergency_contact_name"

    if "dob" in tokens or "birthday" in tokens or {"birth", "date"} <= tokens:
        return "date_of_birth"

    if (
        {"full", "name"} <= tokens
        or {"student", "name"} <= tokens
        or {"student", "full", "name"} <= tokens
    ):
        return "full_name"

    if {"first", "name"} <= tokens or {"given", "name"} <= tokens or "forename" in tokens:
        return "legal_first_name"
    if "given" in tokens or "child" in tokens:
        return "legal_first_name"

    if {"last", "name"} <= tokens or {"family", "name"} <= tokens or "surname" in tokens:
        return "legal_last_name"

    if {"preferred", "name"} <= tokens or "nickname" in tokens or {"nick", "name"} <= tokens:
        return "preferred_name"

    if {"membership", "start", "date"} <= tokens or {"membership", "date"} <= tokens:
        return "membership_start_date"
    if {"enrollment", "date"} <= tokens or {"enrolment", "date"} <= tokens:
        return "membership_start_date"
    if {"join", "date"} <= tokens or {"member", "since"} <= tokens:
        return "membership_start_date"
    if "start" in tokens and "date" in tokens and "class" not in tokens and "belt" not in tokens:
        return "membership_start_date"

    if "program" in tokens or "track" in tokens:
        return "program_id"

    if "order" in tokens and ("belt" in tokens or "rank" in tokens):
        return ""

    if "belt" in tokens and ("current" in tokens or "rank" in tokens):
        return "current_belt_rank_id"
    if "rank" in tokens and not ({"class", "attendance", "order", "sort"} & tokens):
        return "current_belt_rank_id"

    if {"email", "mail"} & tokens:
        return "email"

    if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
        return "phone"

    if "status" in tokens and not (tokens & CSV_PAYMENT_STATUS_TOKENS):
        return "status"

    if "notes" in tokens or "note" in tokens:
        return "notes"

    if "tags" in tokens or "tag" in tokens or "labels" in tokens:
        return "tags"

    if "address" in tokens:
        return "address_line1"

    if "city" in tokens:
        return "address_city"

    if "state" in tokens or "province" in tokens:
        return "address_state"

    if "zip" in tokens or ("postal" in tokens and "code" in tokens):
        return "address_zip"

    return ""


def auto_map_csv_header(header: str) -> str:
    normalized = normalize_header(header)
    if not normalized:
        return ""

    if normalized in CSV_FIELD_ALIASES:
        return CSV_FIELD_ALIASES[normalized]

    compacted = compact_header(header)
    if compacted in COMPACT_CSV_FIELD_ALIASES:
        return COMPACT_CSV_FIELD_ALIASES[compacted]

    return infer_csv_field_from_tokens(set(normalized.split()))
