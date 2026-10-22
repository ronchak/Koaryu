from __future__ import annotations

import pytest

from app.services.student_import_matching import (
    ROSTER_MATCH_LIMIT,
    build_duplicate_review,
    email_key,
    match_rows,
    name_key,
    phone_key,
    skip_target,
    unacknowledged_candidates,
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
    def __init__(
        self,
        action,
        matched_student_id=None,
        of_row=None,
        acknowledged_student_ids=(),
        acknowledged_rows=(),
    ):
        self.action = action
        self.matched_student_id = matched_student_id
        self.of_row = of_row
        self.acknowledged_student_ids = list(acknowledged_student_ids)
        self.acknowledged_rows = list(acknowledged_rows)


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
    assert matches[0].guardian_reasons == ["email", "first_name"]
    # Row 3 shares its guardian with row 2 first (earlier rows compare first); the roster
    # guardian stays in the candidate list but the RowMatch names one source only.
    assert matches[1].guardian_class == "in_file_shared"
    assert matches[1].guardian_of_row == 2
    assert matches[1].guardian_of_existing_key is None
    assert [c.existing_key for c in matches[1].guardian_candidates if c.source == "existing"] == [
        "g1"
    ]


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
    assert match.reasons == []
    assert match.of_existing_key == "s1" and match.of_row is None
    assert match.candidates[0].reasons == ["name", "birth_date_conflict"]
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


def test_in_file_match_names_the_class_when_roster_also_matches_and_keeps_the_other_candidate():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03")]
    rows = [
        planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    matches = match_rows(rows, roster)
    assert matches[0].duplicate_class == "existing_strong" and matches[0].of_existing_key == "s1"
    assert matches[1].duplicate_class == "in_file_strong"
    assert matches[1].of_row == 2 and matches[1].of_existing_key is None
    assert [(c.source, c.row_number, c.existing_key) for c in matches[1].candidates] == [
        ("row", 2, None),
        ("existing", None, "s1"),
    ]
    review = build_duplicate_review(matches[1])
    assert [(c["of_row"], c["student_id"]) for c in review["candidates"]] == [
        (2, None),
        (None, "s1"),
    ]


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


def test_guardian_class_is_none_without_a_guardian_and_new_without_a_match():
    roster = [
        existing(
            "s1", "Mia", "Lopez", guardians=[guardian("g1", "Maria", "Lopez", "m@example.com")]
        )
    ]
    matches = match_rows(
        [
            planned(2, legal_first_name="Diego", legal_last_name="Ortiz"),
            planned(
                3,
                legal_first_name="Diego",
                legal_last_name="Ortiz",
                guardian_name="Ana Ruiz",
                guardian_email="ana@example.org",
            ),
        ],
        roster,
    )
    assert matches[0].guardian_class == "none"
    assert matches[0].guardian_of_row is None and matches[0].guardian_of_existing_key is None
    assert matches[0].guardian_reasons == []
    assert matches[1].guardian_class == "new" and matches[1].guardian_reasons == []
    assert matches[1].duplicate_class == "in_file_possible" and matches[1].of_row == 2


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


def test_names_of_any_script_key_the_same_way():
    assert name_key("明 王") == name_key("明\u3000王") == name_key("明王") == "明王"
    assert name_key("Иван") == name_key("ИВАН") == name_key("иван")
    assert name_key("José 王") == name_key("jose王")
    assert name_key("Nguyễn") == name_key("Nguyen")
    roster = [existing("s1", "明", "王", date_of_birth="2014-06-03")]
    (cjk,) = match_rows(
        [planned(2, legal_first_name="明", legal_last_name="王", date_of_birth="2014-06-03")],
        roster,
    )
    assert cjk.duplicate_class == "existing_strong" and cjk.reasons == ["name", "date_of_birth"]
    (cyrillic,) = match_rows(
        [planned(2, legal_first_name="ИВАН", legal_last_name="Петров", email="ivan@example.net")],
        [existing("s2", "Иван", "петров", email="IVAN@example.net")],
    )
    assert cyrillic.duplicate_class == "existing_strong" and cyrillic.reasons == ["name", "email"]


def test_strong_match_is_found_behind_several_same_name_conflicts():
    """No lookup used for enforcement may be truncated."""
    roster = [
        existing("c1", "Ava", "Nguyen", date_of_birth="2001-01-01", email="ava@example.net"),
        existing("c2", "Ava", "Nguyen", date_of_birth="2002-02-02", email="ava@example.net"),
        existing("c3", "Ava", "Nguyen", date_of_birth="2003-03-03", email="ava@example.net"),
        existing("other", "Ava", "Nguyen", email="someone@example.org"),
        existing("s4", "Ava", "Nguyen", email="ava@example.net"),
    ]
    (match,) = match_rows(
        [
            planned(
                2,
                legal_first_name="Ava",
                legal_last_name="Nguyen",
                date_of_birth="2014-06-03",
                email="ava@example.net",
            )
        ],
        roster,
    )
    assert match.duplicate_class == "existing_strong" and match.of_existing_key == "s4"
    assert match.reasons == ["name", "email"]
    assert {c.existing_key for c in match.candidates} == {"c1", "c2", "c3", "other", "s4"}
    review = build_duplicate_review(match)
    assert review["candidates"][0]["student_id"] == "s4"
    assert len(review["candidates"]) == 5


def test_every_strong_or_archived_candidate_must_be_acknowledged():
    roster = [
        existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03"),
        existing("old", "Ava", "Nguyen", date_of_birth="2014-06-03", archived=True),
        existing("maybe", "Ava", "Nguyen"),
    ]
    rows = [
        planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    match = match_rows(rows, roster)[1]
    assert {(c.source, c.row_number or c.existing_key) for c in match.candidates} == {
        ("row", 2),
        ("existing", "s1"),
        ("existing", "old"),
        ("existing", "maybe"),
    }
    assert [c.existing_key or c.row_number for c in unacknowledged_candidates(match, None)] == [
        2,
        "s1",
        "old",
    ]
    partial = Decision("create", matched_student_id="s1", of_row=2)
    assert [c.existing_key for c in unacknowledged_candidates(match, partial)] == ["old"]
    full = Decision("create", matched_student_id="s1", of_row=2, acknowledged_student_ids=["old"])
    assert unacknowledged_candidates(match, full) == []
    # "maybe" is only a possible match; it never needs acknowledgement.


def test_skip_target_follows_the_best_overall_match_and_never_falls_back():
    roster = [existing("s1", "Ava", "Nguyen", date_of_birth="2014-06-03")]
    rows = [
        planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
        planned(3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"),
    ]
    first, second = match_rows(rows, roster)
    # Row 3's best match is the in-file row; naming only the roster student is no target.
    assert second.of_row == 2 and second.of_existing_key is None
    assert skip_target(second, None) is None
    assert skip_target(second, Decision("skip", matched_student_id="s1")) is None
    assert skip_target(second, Decision("skip", of_row=2)) == ("row", 2)
    assert skip_target(second, Decision("skip", matched_student_id="s1", of_row=2)) == ("row", 2)
    assert skip_target(second, Decision("skip", acknowledged_rows=[2])) == ("row", 2)
    assert skip_target(second, Decision("skip", of_row=9)) is None
    # Row 2's best match is the roster student.
    assert skip_target(first, Decision("skip", matched_student_id="s1")) == ("existing", "s1")
    assert skip_target(first, Decision("skip", of_row=2)) is None
    different = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="1980-01-01")],
        roster,
    )[0]
    assert different.duplicate_class == "different_person"
    assert skip_target(different, Decision("skip", matched_student_id="s1")) is None


def test_archived_match_is_surfaced_beside_an_active_plain_name_match():
    roster = [
        existing("live", "Ava", "Nguyen"),
        existing("old", "Ava", "Nguyen", archived=True),
    ]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")],
        roster,
    )
    assert match.duplicate_class == "existing_possible" and match.of_existing_key == "live"
    assert [(c.existing_key, c.archived, c.confidence) for c in match.candidates] == [
        ("live", False, "possible"),
        ("old", True, "possible"),
    ]
    assert match.suggested_action == "decide"
    review = build_duplicate_review(match)
    assert review["suggested_action"] == "decide"
    assert review["acknowledge_student_ids"] == ["old"]
    assert [c.existing_key for c in unacknowledged_candidates(match, None)] == ["old"]


def test_repeated_rows_name_only_the_earliest_copies():
    rows = [
        planned(n, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")
        for n in range(2, 10)
    ]
    matches = match_rows(rows, [])
    last = matches[-1]
    assert last.duplicate_class == "in_file_strong" and last.of_row == 2
    review = build_duplicate_review(last)
    # Earlier copies are bounded to the earliest few; each later copy was itself
    # reviewed against them, and the decision names exactly what was shown.
    assert [candidate["of_row"] for candidate in review["candidates"]] == [2, 3, 4, 5, 6]
    assert review["acknowledge_rows"] == [2, 3, 4, 5, 6]
    assert review["acknowledge_student_ids"] == []
    decision = Decision("skip", of_row=2, acknowledged_rows=review["acknowledge_rows"])
    assert unacknowledged_candidates(last, decision) == []
    assert skip_target(last, decision) == ("row", 2)


def test_review_shows_every_required_roster_match_beyond_the_display_cap():
    """Existing students are never bounded: every strong one is shown and named."""
    roster = [existing(f"s{n}", "Ava", "Nguyen", date_of_birth="2014-06-03") for n in range(7)]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")],
        roster,
    )
    review = build_duplicate_review(match)
    expected = [f"s{n}" for n in range(7)]
    assert [candidate["student_id"] for candidate in review["candidates"]] == expected
    assert review["acknowledge_student_ids"] == expected


def test_repeated_person_and_shared_guardian_stay_linear():
    """One person repeated on every row, sharing one placeholder guardian with a
    roster that also uses it everywhere, keeps per-row work and payload bounded."""
    count = 3000
    roster = [
        existing(
            f"s{n}",
            f"Kid{n}",
            "Roster",
            guardians=[guardian(f"g{n}", "Front", "Desk", email="office@dojo.test")],
        )
        for n in range(count)
    ]
    rows = [
        planned(
            n,
            legal_first_name="Ava",
            legal_last_name="Nguyen",
            date_of_birth="2014-06-03",
            email="ava@example.test",
            guardian_name="Front Desk",
            guardian_email="office@dojo.test",
        )
        for n in range(2, count + 2)
    ]
    matches = match_rows(rows, roster)
    assert max(len(match.candidates) for match in matches) <= 5
    assert max(len(match.guardian_candidates) for match in matches) <= 10
    reviews = [build_duplicate_review(match) for match in matches]
    assert max(len(review["acknowledge_rows"]) for review in reviews if review) <= 5
    assert all(match.of_row == 2 for match in matches[1:])


def test_strong_match_without_birth_date_is_not_crowded_out():
    """Earlier rows with a conflicting birth date fill the email bucket; a later
    row with the same email and no birth date is still found as strong."""
    rows = [
        planned(
            n,
            legal_first_name="Ava",
            legal_last_name="Nguyen",
            date_of_birth="2010-01-01",
            email="ava@example.test",
        )
        for n in range(2, 9)
    ]
    rows.append(planned(9, legal_first_name="Ava", legal_last_name="Nguyen", email="other@x.test"))
    rows.append(
        planned(10, legal_first_name="Ava", legal_last_name="Nguyen", email="ava@example.test")
    )
    rows.append(
        planned(
            11,
            legal_first_name="Ava",
            legal_last_name="Nguyen",
            date_of_birth="2014-06-03",
            email="ava@example.test",
        )
    )
    last = match_rows(rows, [])[-1]
    strong = [c.row_number for c in last.candidates if c.confidence == "strong"]
    assert strong == [10]
    assert last.duplicate_class == "in_file_strong" and last.of_row == 10
    assert build_duplicate_review(last)["acknowledge_rows"] == [10]


def test_retry_keeps_the_earliest_rows_whatever_order_receipts_arrive_in():
    """Receipt-backed rows of a retried run reach the index first and in roster
    order; the bounded index still keeps the earliest rows."""
    receipt_rows = [12, 7, 11, 4, 9, 2, 10, 5, 8, 6]
    roster = [
        existing(
            f"run{n}",
            "Ava",
            "Nguyen",
            date_of_birth="2014-06-03",
            import_row_number=n,
        )
        for n in receipt_rows
    ]
    (retried,) = [
        match
        for match in match_rows(
            [
                {"row_number": n, "completed": True, "data": {}, "is_valid": True, "issues": []}
                for n in receipt_rows
            ]
            + [
                planned(
                    3, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03"
                )
            ],
            roster,
        )
        if match.row_number == 3
    ]
    assert [c.row_number for c in retried.candidates] == [2]
    assert retried.duplicate_class == "in_file_strong" and retried.of_row == 2


def test_archived_match_behind_five_active_possibles_is_still_shown():
    """Active records outrank archived ones, but an archived match that must be
    acknowledged is never pushed off screen by the display cap."""
    # Five active records share the row's name and phone with different birth
    # dates (a shared-signal bucket is never truncated); one archived record
    # shares only the name and sorts last.
    roster = [
        existing(f"active{n}", "Ava", "Nguyen", date_of_birth=f"201{n}-01-01", phone="555-010-0100")
        for n in range(5)
    ] + [existing("old", "Ava", "Nguyen", archived=True)]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", phone="(555) 010-0100")],
        roster,
    )
    assert [candidate.confidence for candidate in match.candidates] == ["possible"] * 6
    review = build_duplicate_review(match)
    shown = [(candidate["student_id"], candidate["archived"]) for candidate in review["candidates"]]
    # The cap still holds at five, but the archived record takes one of the
    # slots instead of being pushed off the end by the fifth active record.
    assert len(shown) == 5
    assert shown[-1] == ("old", True)
    assert {student_id for student_id, _ in shown[:4]} == {f"active{n}" for n in range(4)}
    assert review["acknowledge_student_ids"] == ["old"]
    assert review["suggested_action"] == "decide"


def test_display_cap_still_trims_candidates_that_need_no_acknowledgement():
    roster = [
        existing(f"active{n}", "Ava", "Nguyen", date_of_birth=f"201{n}-01-01", phone="555-010-0100")
        for n in range(7)
    ]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", phone="(555) 010-0100")],
        roster,
    )
    assert [candidate.confidence for candidate in match.candidates] == ["possible"] * 7
    review = build_duplicate_review(match)
    assert len(review["candidates"]) == 5
    assert review["acknowledge_student_ids"] == []
    assert review["suggested_action"] == "create"


def test_every_archived_same_name_record_reaches_enforcement():
    """Archived records never collapse to a representative."""
    roster = [
        existing("s1", "Ava", "Nguyen", archived=True),
        existing("s2", "Ava", "Nguyen", archived=True),
        existing("s3", "Ava", "Nguyen", date_of_birth="2001-01-01", archived=True),
        existing("live", "Ava", "Nguyen"),
    ]
    (match,) = match_rows(
        [planned(2, legal_first_name="Ava", legal_last_name="Nguyen", date_of_birth="2014-06-03")],
        roster,
    )
    assert [(c.existing_key, c.archived, c.confidence) for c in match.candidates] == [
        ("live", False, "possible"),
        ("s1", True, "possible"),
        ("s2", True, "possible"),
        ("s3", True, "different_person"),
    ]
    assert match.suggested_action == "decide"
    assert build_duplicate_review(match)["acknowledge_student_ids"] == ["s1", "s2"]
    only_first = Decision("create", matched_student_id="s1", acknowledged_student_ids=["s1"])
    assert [c.existing_key for c in unacknowledged_candidates(match, only_first)] == ["s2"]
    both = Decision("create", matched_student_id="s1", acknowledged_student_ids=["s1", "s2"])
    assert unacknowledged_candidates(match, both) == []


def test_blocked_rows_are_never_a_target_for_later_rows():
    """A row that fails validation is never imported, so a later valid copy of
    the same person must not default to skipping against it."""
    blocked = planned(
        2,
        legal_first_name="Ava",
        legal_last_name="Nguyen",
        date_of_birth="2014-06-03",
        guardian_name="Jordan Nguyen",
        guardian_email="jordan@example.test",
    )
    blocked["is_valid"] = False
    later = planned(
        3,
        legal_first_name="Ava",
        legal_last_name="Nguyen",
        date_of_birth="2014-06-03",
        guardian_name="Jordan Nguyen",
        guardian_email="jordan@example.test",
    )
    first, second = match_rows([blocked, later], [])
    assert second.duplicate_class == "none" and second.candidates == []
    assert second.guardian_class == "new"
    assert build_duplicate_review(second) is None


def _copies(count, **extra):
    return [
        existing(f"copy{n:04d}", "Ava", "Nguyen", date_of_birth="2014-06-03", **extra)
        for n in range(count)
    ]


AVA_ROW = {"legal_first_name": "Ava", "legal_last_name": "Nguyen", "date_of_birth": "2014-06-03"}


def test_roster_matches_up_to_the_limit_are_all_listed_and_named():
    (match,) = match_rows([planned(2, **AVA_ROW)], _copies(ROSTER_MATCH_LIMIT))
    assert not match.roster_overflow
    review = build_duplicate_review(match)
    assert len(review["acknowledge_student_ids"]) == ROSTER_MATCH_LIMIT
    assert len(review["candidates"]) == ROSTER_MATCH_LIMIT


def test_more_roster_copies_than_the_limit_block_the_row_with_bounded_work():
    (match,) = match_rows([planned(2, **AVA_ROW)], _copies(ROSTER_MATCH_LIMIT + 1))
    assert match.roster_overflow
    assert len(match.candidates) <= ROSTER_MATCH_LIMIT


def test_a_copy_added_after_preview_trips_the_limit_instead_of_slipping_through():
    """Preview saw exactly the limit and the decision named all of them; one
    more copy created before execution must block the row, never be written past."""
    roster = _copies(ROSTER_MATCH_LIMIT)
    (preview,) = match_rows([planned(2, **AVA_ROW)], roster)
    assert not preview.roster_overflow
    roster.append(existing("late", "Ava", "Nguyen", date_of_birth="2014-06-03"))
    (execution,) = match_rows([planned(2, **AVA_ROW)], roster)
    assert execution.roster_overflow


def test_too_many_archived_same_name_records_block_the_row():
    roster = [
        existing(f"old{n:04d}", "Ava", "Nguyen", archived=True)
        for n in range(ROSTER_MATCH_LIMIT + 1)
    ]
    (match,) = match_rows([planned(2, **AVA_ROW)], roster)
    assert match.roster_overflow


def test_a_full_bucket_of_possible_matches_does_not_block_the_row():
    """Many same-name students sharing a phone but with other birth dates can
    only be possible matches, which need no acknowledgement."""
    roster = [
        existing(
            f"p{n:04d}",
            "Ava",
            "Nguyen",
            date_of_birth=f"19{50 + n:02d}-01-01",
            phone="4155550100",
        )
        for n in range(ROSTER_MATCH_LIMIT + 5)
    ]
    (match,) = match_rows([planned(2, **AVA_ROW, phone="(415) 555-0100")], roster)
    assert not match.roster_overflow


def test_rows_blocked_by_roster_overflow_are_never_in_file_targets():
    rows = [planned(2, **AVA_ROW), planned(3, **AVA_ROW)]
    first, second = match_rows(rows, _copies(ROSTER_MATCH_LIMIT + 1))
    assert first.roster_overflow and second.roster_overflow
    assert all(candidate.source == "existing" for candidate in second.candidates)


def test_identical_roster_and_file_copies_stay_linear():
    count = 1000
    matches = match_rows([planned(n, **AVA_ROW) for n in range(2, count + 2)], _copies(count))
    assert all(match.roster_overflow for match in matches)
    assert max(len(match.candidates) for match in matches) <= ROSTER_MATCH_LIMIT


def test_the_best_match_stays_on_screen_when_archived_matches_fill_the_cap():
    """An active possible match outranks five archived possible matches that all
    need acknowledging; it is the only valid skip target, so it is shown first."""
    roster = [existing("active", "Ava", "Nguyen")] + [
        existing(f"old{n}", "Ava", "Nguyen", archived=True) for n in range(5)
    ]
    (match,) = match_rows([planned(2, legal_first_name="Ava", legal_last_name="Nguyen")], roster)
    assert match.of_existing_key == "active" and match.suggested_action == "decide"
    review = build_duplicate_review(match)
    assert review["candidates"][0]["student_id"] == "active"
    assert {c["student_id"] for c in review["candidates"]} == {"active"} | {
        f"old{n}" for n in range(5)
    }
    first_shown = review["candidates"][0]["student_id"]
    decision = Decision(
        "skip",
        matched_student_id=first_shown,
        acknowledged_student_ids=review["acknowledge_student_ids"],
    )
    assert unacknowledged_candidates(match, decision) == []
    assert skip_target(match, decision) == ("existing", "active")
