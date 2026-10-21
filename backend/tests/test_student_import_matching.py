from __future__ import annotations

import pytest

from app.services.student_import_matching import (
    build_duplicate_review,
    decision_names_match,
    email_key,
    match_rows,
    name_key,
    phone_key,
)


def planned(row_number: int, **data):
    return {"row_number": row_number, "data": data, "is_valid": True, "issues": []}


def existing(key: str, first: str, last: str, **extra):
    entry = {
        "key": key,
        "legal_first_name": first,
        "legal_last_name": last,
        "preferred_name": extra.pop("preferred_name", None),
        "date_of_birth": extra.pop("date_of_birth", None),
        "email": extra.pop("email", None),
        "phone": extra.pop("phone", None),
        "archived": extra.pop("archived", False),
        "guardians": extra.pop("guardians", []),
    }
    entry.update(extra)
    return entry


def guardian(key: str, first: str, last: str, email=None, phone=None):
    return {"key": key, "first_name": first, "last_name": last, "email": email, "phone": phone}


class Decision:
    def __init__(self, action, matched_student_id=None, of_row=None):
        self.action = action
        self.matched_student_id = matched_student_id
        self.of_row = of_row


def test_keys_normalize_accents_punctuation_suffixes_emails_and_phones():
    assert name_key("Ava-Grace") == name_key("Ava Grace") == name_key("AVAGRACE")
    assert name_key("O'Neill") == name_key("ONeill") == "oneill"
    assert name_key("José") == name_key("Jose")
    assert name_key("Smith Jr.") == name_key("Smith") == "smith"
    assert name_key("Sr") == "sr"
    assert name_key(None) == "" and name_key("   ") == ""
    assert email_key("  Jordan@Example.COM ") == "jordan@example.com"
    assert email_key("") is None
    assert phone_key("(415) 555-0198") == phone_key("+1 415 555 0198") == "4155550198"
    assert phone_key("555-01") is None


def test_twins_and_siblings_are_never_the_same_student():
    roster = [
        existing(
            "s1",
            "Mia",
            "Smith",
            date_of_birth="2016-04-01",
            email="jordan.smith@example.org",
            phone="(925) 555-4109",
            guardians=[
                guardian("g1", "Jordan", "Smith", "jordan.smith@example.org", "925-555-4109")
            ],
        )
    ]
    rows = [
        # Twin: same surname and birth date, different first name.
        planned(
            2,
            legal_first_name="Max",
            legal_last_name="Smith",
            date_of_birth="2016-04-01",
            email="jordan.smith@example.org",
            guardian_name="Jordan Smith",
            guardian_email="jordan.smith@example.org",
            guardian_phone="(925) 555-4109",
        ),
        # Sibling sharing guardian email, phone and surname, and the family email as student email.
        planned(
            3,
            legal_first_name="Leo",
            legal_last_name="Smith",
            date_of_birth="2013-09-12",
            email="jordan.smith@example.org",
            phone="925-555-4109",
            guardian_name="Jordan Smith",
            guardian_email="jordan.smith@example.org",
        ),
    ]
    matches = match_rows(rows, roster)
    assert [m.duplicate_class for m in matches] == ["none", "none"]
    assert all(m.of_existing_key is None and m.of_row is None for m in matches)
    assert matches[0].guardian_class == "link_existing"
    assert matches[0].guardian_of_existing_key == "g1"
    assert matches[0].guardian_reasons == ["email", "first_name", "last_name"]
    # Row 3 shares its guardian with row 2 first (earlier rows compare first) and with the roster.
    assert matches[1].guardian_class == "in_file_shared"
    assert matches[1].guardian_of_row == 2
    assert matches[1].guardian_of_existing_key == "g1"


def test_step_siblings_with_different_surnames_share_a_guardian_but_stay_separate_students():
    rows = [
        planned(
            2,
            legal_first_name="Noah",
            legal_last_name="Patel",
            guardian_name="Rina Patel",
            guardian_email="rina.patel@example.com",
        ),
        planned(
            3,
            legal_first_name="Zoe",
            legal_last_name="Kaur",
            guardian_name="Rina Patel",
            guardian_email="rina.patel@example.com",
        ),
    ]
    matches = match_rows(rows, [])
    assert matches[1].duplicate_class == "none"
    assert matches[1].guardian_class == "in_file_shared" and matches[1].guardian_of_row == 2


def test_senior_and_junior_with_different_birth_dates_are_different_people():
    roster = [existing("s1", "Carlos", "Reyes Sr.", date_of_birth="1980-02-02")]
    rows = [
        planned(
            2, legal_first_name="Carlos", legal_last_name="Reyes Jr", date_of_birth="2012-02-02"
        )
    ]
    (match,) = match_rows(rows, roster)
    assert match.duplicate_class == "different_person"
    assert match.reasons == ["name", "birth_date_conflict"]
    assert match.of_existing_key == "s1"
    assert not match.is_flagged and not match.requires_decision


def test_same_name_with_one_birth_date_missing_is_a_possible_match_defaulting_to_create():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03", phone="415-555-6644")]
    (by_name,) = match_rows([planned(2, legal_first_name="Ava", legal_last_name="Nguyen")], roster)
    assert by_name.duplicate_class == "existing_possible" and by_name.reasons == ["name"]
    assert by_name.suggested_action == "create" and not by_name.requires_decision
    (by_phone,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", phone="(415) 555-6644")],
        roster,
    )
    assert by_phone.reasons == ["name", "phone"] and by_phone.duplicate_class == "existing_possible"


def test_same_name_and_email_with_conflicting_birth_dates_is_possible_not_strong():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03", email="ava@example.net")]
    (match,) = match_rows(
        [
            planned(
                2,
                legal_first_name="Ava",
                legal_last_name="Nguyen",
                date_of_birth="2014-03-06",
                email="AVA@example.net",
            )
        ],
        roster,
    )
    assert match.duplicate_class == "existing_possible"
    assert match.reasons == ["name", "email", "birth_date_conflict"]


def test_strong_match_by_name_and_birth_date_or_name_and_email():
    roster = [
        existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03"),
        existing("s2", "Thu", "Nguyen", email="thu@example.net"),
    ]
    matches = match_rows(
        [
            planned(
                2, legal_first_name="ava", legal_last_name="NGUYEN", date_of_birth="2014-06-03"
            ),
            planned(3, legal_first_name="Thu", legal_last_name="Nguyen", email="Thu@Example.net"),
        ],
        roster,
    )
    assert matches[0].duplicate_class == "existing_strong"
    assert matches[0].reasons == ["name", "date_of_birth"] and matches[0].of_existing_key == "s1"
    assert matches[0].suggested_action == "skip" and matches[0].requires_decision
    assert matches[1].duplicate_class == "existing_strong" and matches[1].reasons == [
        "name",
        "email",
    ]


def test_archived_student_match_requires_a_decision_and_keeps_confidence():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03", archived=True)]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")],
        roster,
    )
    assert match.duplicate_class == "archived_match"
    assert match.reasons == ["name", "date_of_birth", "strong"]
    assert match.suggested_action == "decide" and match.requires_decision
    review = build_duplicate_review(match)
    assert review["suggested_action"] == "decide"
    assert review["candidates"][0]["archived"] is True
    assert review["candidates"][0]["reasons"] == ["same name", "same birth date"]


def test_active_match_outranks_archived_match_at_equal_confidence():
    roster = [
        existing("old", "Ava", "Nguyen", date_of_birth="2014-06-03", archived=True),
        existing("live", "Ava", "Nguyen", date_of_birth="2014-06-03"),
    ]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")],
        roster,
    )
    assert match.duplicate_class == "existing_strong" and match.of_existing_key == "live"
    assert [c.existing_key for c in match.candidates] == ["live", "old"]


def test_in_file_repeat_with_different_formatting_points_at_the_earliest_row():
    rows = [
        planned(
            2, legal_first_name="Ava-Grace", legal_last_name="O'Neill", date_of_birth="2014-09-03"
        ),
        planned(3, legal_first_name="Mateo", legal_last_name="García"),
        planned(
            4, legal_first_name="Ava Grace", legal_last_name="ONeill", date_of_birth="2014-09-03"
        ),
        planned(
            5, legal_first_name="AVAGRACE", legal_last_name="oneill", date_of_birth="2014-09-03"
        ),
    ]
    matches = match_rows(rows, [])
    assert [m.duplicate_class for m in matches] == [
        "none",
        "none",
        "in_file_strong",
        "in_file_strong",
    ]
    assert matches[2].of_row == 2 and matches[3].of_row == 2
    assert matches[3].suggested_action == "skip"


def test_in_file_match_names_the_class_when_roster_also_matches_and_keeps_both_references():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03")]
    rows = [
        planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    matches = match_rows(rows, roster)
    assert matches[0].duplicate_class == "existing_strong" and matches[0].of_existing_key == "s1"
    assert matches[1].duplicate_class == "in_file_strong"
    assert matches[1].of_row == 2 and matches[1].of_existing_key == "s1"


def test_rows_completed_by_receipt_match_later_rows_through_their_import_row_number():
    roster = [
        existing(
            "11111111-1111-4111-8111-111111111111",
            "Ava",
            "Nguyen",
            date_of_birth="2014-06-03",
            import_row_number=2,
        )
    ]
    rows = [
        {"row_number": 2, "completed": True, "data": {}, "is_valid": True, "issues": []},
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    matches = match_rows(rows, roster)
    assert matches[0].duplicate_class == "none"
    assert matches[1].duplicate_class == "in_file_strong" and matches[1].of_row == 2
    assert matches[1].of_existing_key is None


def test_guardian_email_without_name_overlap_is_a_separate_contact():
    roster = [
        existing(
            "s1", "Mia", "Lopez", guardians=[guardian("g1", "Maria", "Lopez", "family@example.com")]
        )
    ]
    (match,) = match_rows(
        [
            planned(
                2,
                legal_first_name="Diego",
                legal_last_name="Ortiz",
                guardian_name="Carlos Ortiz",
                guardian_email="family@example.com",
            )
        ],
        roster,
    )
    assert match.duplicate_class == "none"
    assert match.guardian_class == "separate_contact"
    assert match.guardian_reasons == ["email", "name_mismatch"]
    assert match.guardian_of_existing_key == "g1"
    review = build_duplicate_review(match)
    assert review["candidates"] == []
    assert review["family_context"] == [
        "Guardian details partly match Mia Lopez (an existing student); treated as a separate contact"
    ]


def test_guardian_name_and_phone_link_and_name_only_stays_separate():
    roster = [
        existing(
            "s1", "Mia", "Lopez", guardians=[guardian("g1", "Maria", "Lopez", None, "415-555-0100")]
        )
    ]
    (linked,) = match_rows(
        [
            planned(
                2,
                legal_first_name="Diego",
                legal_last_name="Lopez",
                guardian_name="Maria Lopez",
                guardian_phone="(415) 555-0100",
            )
        ],
        roster,
    )
    assert linked.guardian_class == "link_existing" and linked.guardian_reasons == ["name", "phone"]
    (separate,) = match_rows(
        [
            planned(
                2, legal_first_name="Diego", legal_last_name="Lopez", guardian_name="Maria Lopez"
            )
        ],
        roster,
    )
    assert separate.guardian_class == "separate_contact" and separate.guardian_reasons == ["name"]
    (fresh,) = match_rows(
        [planned(2, legal_first_name="Diego", legal_last_name="Lopez", guardian_name="Ana Ruiz")],
        roster,
    )
    assert fresh.guardian_class == "new" and build_duplicate_review(fresh) is None


def test_guardian_signals_alone_never_identify_a_student_and_preferred_name_is_ignored():
    roster = [
        existing(
            "s1",
            "Mia",
            "Smith",
            preferred_name="Mimi",
            date_of_birth="2016-04-01",
            guardians=[guardian("g1", "Jordan", "Smith", "jordan@example.org", "925-555-4109")],
        )
    ]
    (match,) = match_rows(
        [
            planned(
                2,
                legal_first_name="Mimi",
                legal_last_name="Smith",
                preferred_name="Mia",
                date_of_birth="2016-04-01",
                guardian_name="Jordan Smith",
                guardian_email="jordan@example.org",
                guardian_phone="925-555-4109",
            )
        ],
        roster,
    )
    assert match.duplicate_class == "none"
    assert match.guardian_class == "link_existing"


def test_rows_without_names_or_with_unparsed_birth_dates_do_not_match_or_crash():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03")]
    matches = match_rows(
        [
            planned(2, legal_first_name="Ava"),
            planned(
                3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="not a date"
            ),
        ],
        roster,
    )
    assert matches[0].duplicate_class == "none"
    assert matches[1].duplicate_class == "existing_possible" and matches[1].reasons == ["name"]


@pytest.mark.parametrize(
    "decision, expected",
    [
        (None, False),
        (Decision("skip", matched_student_id="s1"), True),
        (Decision("skip", matched_student_id="s2"), False),
        (Decision("skip", of_row=2), True),
        (Decision("skip", of_row=9), False),
        (Decision("create", matched_student_id="s1"), True),
    ],
)
def test_decision_must_name_what_execution_found(decision, expected):
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03")]
    rows = [
        planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    match = match_rows(rows, roster)[1]
    assert decision_names_match(decision, match) is expected
