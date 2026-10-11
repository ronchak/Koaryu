"""Pure Home builders, including fail-closed facts and role-shaped attention."""

from dataclasses import replace
from datetime import date
from itertools import product

import pytest

from app.schemas.belt import EligibilityEntry
from app.services.dashboard_home_sections import (
    DashboardHomeFactMismatch,
    build_needs_attention,
    build_promotions,
    default_home_preferences,
    entitled_home_panels,
    order_like_belt_tracker,
    reconcile_home_preferences,
    validate_dashboard_home_facts,
)
from app.services.dashboard_home_service import DASHBOARD_HOME_FACTS_FORMULA_VERSION
from app.services.dashboard_summary_cache import DashboardSummaryCacheKey

TODAY = date(2026, 10, 10)
STUDIO = "studio-1"


def home_key(*, visibility="billing_visible", studio_id=STUDIO):
    return DashboardSummaryCacheKey(
        studio_id=studio_id,
        visibility=visibility,
        timezone="UTC",
        local_date=TODAY,
        formula_version=DASHBOARD_HOME_FACTS_FORMULA_VERSION,
    )


def rpc_facts(key=None, *, agenda_available=True, contact_missing=1):
    key = key or home_key()
    visible = key.visibility == "billing_visible"
    return {
        "formula_version": "dashboard-summary-v1",
        "studio": {"id": key.studio_id, "name": "River City", "timezone": key.timezone},
        "timezone": key.timezone,
        "today": key.local_date.isoformat(),
        "students": {
            "total_students": 9,
            "active_students": 7,
            "trialing_students": 2,
            "on_hold_students": 1,
        },
        "operational": {
            "attendance_with_capacity": 7,
            "total_capacity": 74,
            "sessions_tracked": 9,
        },
        "schedule": {"today_sessions": 2},
        "today_schedule": {
            "available": agenda_available,
            "overflow_count": 0 if agenda_available else None,
            "rows": [
                {
                    "id": "s-1",
                    "name": "Kids",
                    "start_time": "16:00:00",
                    "end_time": "17:00:00",
                    "attendance_count": 4,
                    "capacity": 12,
                },
                {
                    "id": "s-2",
                    "name": "Adults",
                    "start_time": "18:00:00",
                    "end_time": "19:00:00",
                    "attendance_count": 0,
                    "capacity": None,
                },
            ]
            if agenda_available
            else [],
        },
        "inactivity": {"watch_14": 3},
        "emergency_contacts": {
            "available": True,
            "students_missing_contact_name": contact_missing,
        },
        "billing": {
            "can_view_billing": visible,
            "payment_attention_count": 2 if visible else None,
            "has_plans": False if visible else None,
            "payments_ready": True if visible else None,
            **({"amounts": {"available": False}} if visible else {}),
        },
        "setup": {
            "has_programs": True,
            "has_students": True,
            "has_belt_system": False,
            "has_weekly_classes": True,
            "has_tuition_plans": False if visible else None,
        },
        "recent_students": [
            {
                "id": "st-9",
                "display_name": "Mia Chen",
                "status": "trialing",
                "started_on": "2026-10-03",
            }
        ],
    }


def eligibility(student_id, *, name=None, rank="white", classes=10, days=10, **changes):
    return EligibilityEntry(
        **{
            "student_id": student_id,
            "student_name": name or student_id,
            "current_rank_id": rank,
            "current_rank_name": rank.title() if rank else None,
            "current_rank_color": "#FFFFFF" if rank else None,
            "next_rank_id": "next",
            "next_rank_name": "Yellow" if rank else "White",
            "next_rank_color": "#FFFF00" if rank else "#FFFFFF",
            "classes_since_promo": classes,
            "classes_required": 10,
            "days_at_rank": days,
            "days_required": 10,
            "classes_met": True,
            "time_met": True,
            "is_eligible": True,
            **changes,
        }
    )


def test_valid_facts_map_each_home_section_and_preserve_nullable_row_values():
    facts = validate_dashboard_home_facts(rpc_facts(), home_key(), materialization_attempted=True)
    assert facts.studio.model_dump() == {
        "id": STUDIO,
        "name": "River City",
        "timezone": "UTC",
        "today": "2026-10-10",
    }
    assert facts.active_students.model_dump() == {
        "total": 9,
        "active": 7,
        "trialing": 2,
        "on_hold": 1,
    }
    assert facts.attendance.model_dump() == {
        "window_days": 30,
        "sessions": 9,
        "seats_filled": 7,
        "capacity": 74,
    }
    assert facts.classes_today.total == 2 and facts.classes_today.overflow == 0
    assert facts.classes_today.rows[0].checked_in == 4
    assert facts.classes_today.rows[1].capacity is None
    assert facts.recent_students[0].name == "Mia Chen"
    assert facts.recent_students[0].started_on == "2026-10-03"
    assert facts.materialization_attempted


@pytest.mark.parametrize(
    "field",
    ["auth", "access_token", "authorization", "bearer_token", "generated_at", "user", "user_id"],
)
def test_identity_is_rejected_before_caching(field):
    raw = rpc_facts()
    raw[field] = "must never enter facts"
    with pytest.raises(DashboardHomeFactMismatch, match="identity"):
        validate_dashboard_home_facts(raw, home_key())


@pytest.mark.parametrize(
    "path,value,message",
    [
        (("formula_version",), "dashboard-home-facts-v1", "formula version"),
        (("timezone",), "America/Los_Angeles", "timezone"),
        (("today",), "2026-10-09", "local date"),
        (("studio",), None, "studio is invalid"),
        (("studio", "id"), "other-studio", "studio mismatch"),
        (("studio", "timezone"), "America/Los_Angeles", "studio timezone"),
        (("billing",), None, "billing is invalid"),
        (("billing", "can_view_billing"), False, "not billing-visible"),
        (("billing", "payment_attention_count"), True, "count is invalid"),
        (("billing", "payment_attention_count"), "2", "count is invalid"),
        (("billing", "has_plans"), None, "plan flag"),
        (("billing", "payments_ready"), None, "payment flag"),
        (("billing", "amounts"), {"available": True}, "amounts are invalid"),
        (("students", "total_students"), -1, "shape is invalid"),
        (("today_schedule", "overflow_count"), None, "no overflow count"),
    ],
)
def test_mismatched_or_invalid_facts_fail_closed(path, value, message):
    raw = rpc_facts()
    target = raw
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    with pytest.raises(DashboardHomeFactMismatch, match=message):
        validate_dashboard_home_facts(raw, home_key())


@pytest.mark.parametrize(
    "field,value",
    [
        ("can_view_billing", True),
        ("payment_attention_count", 1),
        ("has_plans", False),
        ("payments_ready", False),
        ("amounts", {"available": False}),
    ],
)
def test_hidden_billing_rejects_even_false_flags_and_unavailable_amounts(field, value):
    key = home_key(visibility="billing_hidden")
    raw = rpc_facts(key)
    raw["billing"][field] = value
    with pytest.raises(DashboardHomeFactMismatch, match="billing"):
        validate_dashboard_home_facts(raw, key)


def test_hidden_billing_never_builds_payments_even_for_a_visible_role():
    key = home_key(visibility="billing_hidden")
    facts = validate_dashboard_home_facts(rpc_facts(key), key)
    assert facts.payment_attention_count is None
    assert "billing" not in facts.incomplete_setup_steps
    assert "payments" not in [item.kind for item in build_needs_attention(facts, "admin").items]


@pytest.mark.parametrize(
    "role,kinds",
    [
        ("admin", ["payments", "setup", "away", "contact"]),
        ("front_desk", ["payments", "away", "contact"]),
        ("instructor", ["away"]),
        (None, []),
    ],
)
def test_attention_has_fixed_order_role_permissions_and_six_row_bound(role, kinds):
    facts = validate_dashboard_home_facts(rpc_facts(), home_key())
    items = build_needs_attention(facts, role, contact_student_id="st-1").items
    assert [item.kind for item in items] == kinds
    assert len(items) <= 6


def test_zero_attention_counts_and_completed_setup_are_dropped():
    facts = validate_dashboard_home_facts(rpc_facts(), home_key())
    facts = replace(
        facts,
        payment_attention_count=0,
        incomplete_setup_steps=(),
        away_count=0,
        missing_contact_count=0,
    )
    assert build_needs_attention(facts, "admin").items == []


@pytest.mark.parametrize("complete", list(product([False, True], repeat=5)))
def test_setup_counts_incomplete_steps_and_picks_first_in_product_order(complete):
    raw = rpc_facts()
    fields = [
        "has_programs",
        "has_students",
        "has_belt_system",
        "has_weekly_classes",
        "has_tuition_plans",
    ]
    steps = ["programs", "students", "belts", "classes", "billing"]
    raw["setup"] = dict(zip(fields, complete))
    facts = validate_dashboard_home_facts(raw, home_key())
    expected = [step for step, done in zip(steps, complete) if not done]
    assert facts.incomplete_setup_steps == tuple(expected)
    setup = [item for item in build_needs_attention(facts, "admin").items if item.kind == "setup"]
    assert len(setup) == bool(expected)
    if expected:
        assert setup[0].count == len(expected)
        assert setup[0].next_step == expected[0]


@pytest.mark.parametrize(
    "tuition,expected", [(None, ("billing",)), (False, ("billing",)), (True, ())]
)
def test_tuition_setup_is_complete_only_when_true(tuition, expected):
    raw = rpc_facts()
    raw["setup"] = {name: True for name in raw["setup"]}
    raw["setup"]["has_tuition_plans"] = tuition
    assert validate_dashboard_home_facts(raw, home_key()).incomplete_setup_steps == expected


@pytest.mark.parametrize(
    "count,student_id,expected", [(1, "st-1", "st-1"), (1, None, None), (2, "st-1", None)]
)
def test_contact_id_is_present_only_for_one_missing_contact(count, student_id, expected):
    facts = validate_dashboard_home_facts(rpc_facts(contact_missing=count), home_key())
    item = build_needs_attention(facts, "admin", contact_student_id=student_id).items[-1]
    wire = item.model_dump(mode="json")
    assert item.kind == "contact"
    if expected:
        assert wire["student_id"] == expected
    else:
        assert "student_id" not in wire


def test_unavailable_inputs_hide_agenda_and_contact_without_fabricating_zeroes():
    raw = rpc_facts(agenda_available=False)
    raw["emergency_contacts"]["available"] = False
    facts = validate_dashboard_home_facts(raw, home_key())
    assert facts.classes_today is None
    assert facts.missing_contact_count is None
    assert "contact" not in [item.kind for item in build_needs_attention(facts, "admin").items]


def test_agenda_is_bounded_and_maps_overflow():
    raw = rpc_facts()
    raw["schedule"]["today_sessions"] = 8
    raw["today_schedule"]["rows"] = [
        dict(raw["today_schedule"]["rows"][0], id=f"session-{i}") for i in range(5)
    ]
    raw["today_schedule"]["overflow_count"] = 3
    facts = validate_dashboard_home_facts(raw, home_key())
    assert (
        facts.classes_today.total,
        facts.classes_today.overflow,
        len(facts.classes_today.rows),
    ) == (8, 3, 5)
    raw["today_schedule"]["rows"].append(raw["today_schedule"]["rows"][0])
    with pytest.raises(DashboardHomeFactMismatch, match="shape is invalid"):
        validate_dashboard_home_facts(raw, home_key())


def test_promotions_follow_tracker_group_progress_and_name_order():
    entries = [
        eligibility("yellow", rank="yellow", classes=100),
        eligibility("white-low", name="Aaron", classes=10),
        eligibility("white-high", name="Zoe", classes=20),
        eligibility("lowercase", name="amy"),
        eligibility("uppercase", name="Amy"),
        eligibility("unranked", rank=None, classes=0),
        eligibility("days-high", name="Zack", days=30),
    ]
    ordered = order_like_belt_tracker(entries, ["white", "yellow"])
    assert [entry.student_id for entry in ordered] == [
        "unranked",
        "days-high",
        "white-high",
        "white-low",
        "uppercase",
        "lowercase",
        "yellow",
    ]
    assert [entry.student_id for entry in order_like_belt_tracker(entries, ["yellow", "white"])][
        :2
    ] == ["unranked", "yellow"]


def test_promotion_counts_include_approval_only_and_all_rows_before_six_row_cap():
    entries = [
        eligibility(
            f"ready-{i}",
            rank=None if i == 0 else "white",
            needs_approval=i % 2 == 0,
            is_eligible=i % 2 != 0,
        )
        for i in range(8)
    ]
    entries += [
        eligibility("classes-short", classes_met=False),
        eligibility("time-short", time_met=False),
    ]
    promotions = build_promotions(entries, ["white"])
    assert promotions.stats.model_dump() == {"ready_count": 8, "needs_approval": 4}
    rows = promotions.ready_to_promote.rows
    assert len(rows) == 6
    assert rows[0].student_id == "ready-0" and rows[0].from_ is None
    wire = rows[0].model_dump(mode="json", by_alias=True)
    assert "from_" not in wire and wire["from"] is None
    assert wire["to"] == {"name": "White", "color": "#FFFFFF"}
    assert wire["classes_at_rank"] == 10 and wire["needs_approval"] is True
    assert rows[1].from_.name == "White"


def test_empty_promotions_are_successful_empty_sections():
    result = build_promotions([], [])
    assert result.stats.model_dump() == {"ready_count": 0, "needs_approval": 0}
    assert result.ready_to_promote.rows == []


@pytest.mark.parametrize("changes", [{"next_rank_name": None}, {"current_rank_name": None}])
def test_malformed_ready_rank_names_fail_instead_of_returning_a_partial_list(changes):
    with pytest.raises(ValueError, match="rank"):
        build_promotions([eligibility("invalid", **changes)], ["white"])


@pytest.mark.parametrize(
    "role,order",
    [
        ("admin", ["follow_ups", "ready_to_promote", "recent_students"]),
        ("front_desk", ["follow_ups", "recent_students"]),
        ("instructor", ["ready_to_promote", "recent_students"]),
        (None, []),
    ],
)
def test_home_preferences_defaults_and_entitlements_per_role(role, order):
    assert entitled_home_panels(role) == tuple(order)
    assert default_home_preferences(role).model_dump() == {
        "version": 1,
        "order": order,
        "hidden": ["recent_students"] if order else [],
        "size": {},
    }


@pytest.mark.parametrize(
    "role,order,hidden",
    [
        (
            "admin",
            ["recent_students", "ready_to_promote", "follow_ups"],
            ["recent_students", "follow_ups"],
        ),
        ("front_desk", ["recent_students", "follow_ups"], ["recent_students", "follow_ups"]),
        ("instructor", ["recent_students", "ready_to_promote"], ["recent_students"]),
    ],
)
def test_home_preferences_role_change_filters_order_hidden_and_sizes(role, order, hidden):
    saved = {
        "version": 1,
        "order": ["recent_students", "ready_to_promote", "follow_ups"],
        "hidden": ["follow_ups", "ghost", "recent_students"],
        "size": {
            "follow_ups": "compact",
            "ready_to_promote": "expanded",
            "recent_students": "expanded",
        },
    }
    assert reconcile_home_preferences(saved, role).model_dump() == {
        "version": 1,
        "order": order,
        "hidden": hidden,
        "size": {},
    }
    assert saved["order"] == ["recent_students", "ready_to_promote", "follow_ups"]
    assert saved["hidden"] == ["follow_ups", "ghost", "recent_students"]


@pytest.mark.parametrize(
    "role,order,hidden",
    [
        (
            "admin",
            ["follow_ups", "ready_to_promote", "recent_students"],
            ["ready_to_promote", "recent_students"],
        ),
        ("front_desk", ["follow_ups", "recent_students"], ["recent_students"]),
        (
            "instructor",
            ["ready_to_promote", "recent_students"],
            ["ready_to_promote", "recent_students"],
        ),
    ],
)
def test_home_preferences_new_entitlements_append_in_default_order(role, order, hidden):
    saved = {"version": 1, "order": ["follow_ups"], "hidden": ["ready_to_promote"], "size": {}}
    assert reconcile_home_preferences(saved, role).model_dump() == {
        "version": 1,
        "order": order,
        "hidden": hidden,
        "size": {},
    }


def test_home_preferences_existing_visible_recent_students_stays_visible_on_upgrade():
    saved = {"version": 1, "order": ["recent_students"], "hidden": [], "size": {}}
    assert reconcile_home_preferences(saved, "admin").model_dump() == {
        "version": 1,
        "order": ["recent_students", "follow_ups", "ready_to_promote"],
        "hidden": [],
        "size": {},
    }


def test_home_preferences_reconcile_tolerates_junk_when_known_ids_survive():
    saved = {
        "version": 1,
        "order": ["old_panel", "recent_students", "recent_students", 7, {"x": 1}, "follow_ups"],
        "hidden": ["follow_ups", "ghost", ["unhashable"]],
        "size": {"recent_students": "expanded", "follow_ups": ["bad"]},
        "extra": True,
    }
    assert reconcile_home_preferences(saved, "front_desk").model_dump() == {
        "version": 1,
        "order": ["recent_students", "follow_ups"],
        "hidden": ["follow_ups"],
        "size": {},
    }


@pytest.mark.parametrize("version", [True, False, 2, "1", 1.0, None])
def test_home_preferences_reconcile_rejects_non_integer_version_one(version):
    assert reconcile_home_preferences({"version": version, "order": []}, "admin") is None


@pytest.mark.parametrize(
    "saved",
    [
        None,
        "junk",
        [],
        {"version": 1},
        {"version": 1, "order": "follow_ups"},
        {"version": 1, "order": [], "hidden": {}},
        {"version": 1, "order": [], "size": []},
    ],
)
def test_home_preferences_reconcile_rejects_unreadable_shapes(saved):
    assert reconcile_home_preferences(saved, "admin") is None
