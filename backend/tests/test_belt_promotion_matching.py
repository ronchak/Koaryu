from types import SimpleNamespace
from unittest.mock import MagicMock, call

import pytest

from app.services.belt_eligibility import BeltEligibilityCalculator


STUDIO_ID = "11111111-1111-1111-1111-111111111111"
NEWER = "2026-10-10T00:00:00Z"
OLDER = "2026-09-01T00:00:00Z"


def context(key, student_id="student", membership_id=None, program_id=None):
    return {
        "context_key": key,
        "student": {"id": student_id},
        "membership_id": membership_id,
        "program_id": program_id,
    }


def promotion(student_id="student", membership_id=None, program_id=None, promoted_at=NEWER):
    return {
        "student_id": student_id,
        "student_program_membership_id": membership_id,
        "program_id": program_id,
        "promoted_at": promoted_at,
    }


def calculator_with_pages(*pages):
    client = MagicMock()
    query = client.table.return_value
    for method in ("select", "eq", "in_", "order", "range"):
        getattr(query, method).return_value = query
    query.execute.side_effect = [SimpleNamespace(data=page) for page in pages]
    return BeltEligibilityCalculator(client), client, query


@pytest.mark.parametrize("strict", [False, True])
def test_latest_matching_row_wins_across_membership_program_and_legacy_contexts(strict):
    calculator, _, _ = calculator_with_pages(
        [
            promotion("other-student"),
            promotion(membership_id="old-membership", program_id="program"),
            promotion(membership_id="membership", program_id="other-program", promoted_at=OLDER),
            promotion(
                membership_id="second-membership", program_id="second-program", promoted_at=OLDER
            ),
            promotion(promoted_at=OLDER),
            promotion("null-date", promoted_at=None),
            promotion("null-date", promoted_at=OLDER),
        ]
    )

    assert calculator._fetch_latest_promotions_by_context(
        STUDIO_ID,
        [
            context("member", membership_id="membership", program_id="program"),
            context("second", membership_id="second-membership", program_id="second-program"),
            context("legacy"),
            context("legacy-with-program", program_id="unmatched-program"),
            context("unmatched", membership_id="unmatched", program_id="unmatched"),
            context("null", "null-date"),
        ],
        strict=strict,
    ) == {
        "member": NEWER,
        "second": OLDER,
        "legacy": OLDER,
        "legacy-with-program": OLDER,
        "null": None,
    }


@pytest.mark.parametrize("bad_row", [None, 7, "scalar", True])
@pytest.mark.parametrize("before_match", [False, True])
@pytest.mark.parametrize("strict", [False, True])
def test_malformed_rows_keep_strict_validation_and_non_strict_early_match(
    bad_row, before_match, strict
):
    rows = [bad_row, promotion()] if before_match else [promotion(), bad_row]
    calculator, _, query = calculator_with_pages(rows)

    if strict:
        with pytest.raises(ValueError, match="Invalid candidate facts"):
            calculator._fetch_latest_promotions_by_context(
                STUDIO_ID, [context("match")], strict=True
            )
    elif before_match:
        with pytest.raises(AttributeError):
            calculator._fetch_latest_promotions_by_context(STUDIO_ID, [context("match")])
    else:
        assert calculator._fetch_latest_promotions_by_context(STUDIO_ID, [context("match")]) == {
            "match": NEWER
        }
    assert query.execute.call_count == 1


@pytest.mark.parametrize("student_id", [[], {}, 7, False])
@pytest.mark.parametrize("strict", [False, True])
def test_unsupported_student_id_is_compared_without_hashing(student_id, strict):
    calculator, _, query = calculator_with_pages([promotion(student_id), promotion()])

    assert calculator._fetch_latest_promotions_by_context(
        STUDIO_ID, [context("match")], strict=strict
    ) == {"match": NEWER}
    assert query.execute.call_count == 1


@pytest.mark.parametrize("student_id", [None, "", [], {}])
def test_empty_context_student_id_stays_excluded(student_id):
    calculator, _, query = calculator_with_pages([promotion()])

    assert calculator._fetch_latest_promotions_by_context(
        STUDIO_ID, [context("excluded", student_id), context("match")]
    ) == {"match": NEWER}
    query.in_.assert_called_once_with("student_id", ["student"])


def test_later_unmatched_context_still_visits_malformed_row():
    calculator, _, _ = calculator_with_pages([promotion(), None])

    with pytest.raises(AttributeError):
        calculator._fetch_latest_promotions_by_context(
            STUDIO_ID,
            [
                context("matched"),
                context("unmatched", membership_id="member", program_id="program"),
            ],
        )


@pytest.mark.parametrize("strict", [False, True])
def test_malformed_later_page_keeps_eager_page_validation_but_lazy_matching(strict):
    calculator, _, query = calculator_with_pages([promotion()] * 1000, [None])

    if strict:
        with pytest.raises(ValueError, match="Invalid candidate facts"):
            calculator._fetch_latest_promotions_by_context(
                STUDIO_ID, [context("match")], strict=True
            )
    else:
        assert calculator._fetch_latest_promotions_by_context(STUDIO_ID, [context("match")]) == {
            "match": NEWER
        }
    assert query.range.call_args_list == [call(0, 999), call(1000, 1999)]


def test_queries_pages_and_first_context_key_match_survive_student_chunks():
    students = [f"student-{index:03d}" for index in range(101)]
    contexts = [context(student, student) for student in reversed(students)]
    contexts[0]["context_key"] = contexts[-1]["context_key"] = "shared"
    contexts.append(context("second-context", students[0], program_id="legacy-program"))
    calculator, client, query = calculator_with_pages(
        [promotion(students[0], program_id="other-program")] * 1000,
        [promotion(students[99]), promotion(students[0])],
        [promotion(students[100], promoted_at=OLDER)],
    )

    assert calculator._fetch_latest_promotions_by_context(STUDIO_ID, contexts) == {
        students[99]: NEWER,
        "shared": NEWER,
        "second-context": NEWER,
    }
    assert client.table.call_args_list == [call("promotions")] * 3
    assert (
        query.select.call_args_list
        == [call("student_id, student_program_membership_id, program_id, promoted_at")] * 3
    )
    assert query.eq.call_args_list == [call("studio_id", STUDIO_ID)] * 3
    assert query.in_.call_args_list == [
        call("student_id", students[:100]),
        call("student_id", students[:100]),
        call("student_id", students[100:]),
    ]
    assert query.order.call_args_list == [call("promoted_at", desc=True)] * 3
    assert query.range.call_args_list == [call(0, 999), call(1000, 1999), call(0, 999)]
