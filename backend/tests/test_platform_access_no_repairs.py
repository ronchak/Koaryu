from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.services import platform_billing_service, studio_scope
from app.services.platform_billing_service import AccessRepairDeferred, PlatformBillingService
from tests.fakes.supabase import TableBackedSupabase


def subscription_row(**overrides):
    return {
        "studio_id": "studio_1",
        "stripe_subscription_id": "sub_123",
        "stripe_customer_id": "cus_123",
        "status": "active",
        "comped": False,
        "trial_end": None,
        "current_period_start": "2026-01-01T00:00:00+00:00",
        "current_period_end": "2999-01-01T00:00:00+00:00",
        **overrides,
    }


def database_for(row):
    return TableBackedSupabase({"studio_subscriptions": [deepcopy(row)]})


@pytest.fixture(autouse=True)
def production_settings():
    settings = SimpleNamespace(ENVIRONMENT="production")
    with (
        patch.object(platform_billing_service, "get_settings", return_value=settings),
        patch.object(studio_scope, "get_settings", return_value=settings),
    ):
        yield


@pytest.fixture
def no_provider_work():
    with (
        patch.object(
            platform_billing_service,
            "StripeService",
            side_effect=AssertionError("Provider repairs are disabled"),
        ) as stripe,
        patch.object(platform_billing_service, "_access_repair_metadata_lock") as lock,
    ):
        lock.__enter__.side_effect = AssertionError("Repair coordination must not be acquired")
        yield
        stripe.assert_not_called()
        lock.__enter__.assert_not_called()


@pytest.mark.parametrize(
    "overrides",
    [
        {"current_period_start": None, "current_period_end": None},
        {"stripe_subscription_id": None},
        {"current_period_start": "2999-02-01T00:00:00+00:00"},
        {"status": "trialing", "trial_end": None},
    ],
    ids=[
        "missing-periods",
        "missing-subscription-with-customer",
        "reversed-periods",
        "missing-trial-end",
    ],
)
def test_unverified_entitled_row_is_unavailable_without_provider_work(overrides, no_provider_work):
    row = subscription_row(**overrides)
    supabase = database_for(row)

    with pytest.raises(HTTPException) as error:
        studio_scope.get_platform_subscription_access(
            supabase, "studio_1", allow_provider_repairs=False
        )

    assert error.value.status_code == 503
    assert error.value.detail == {
        **studio_scope.BILLING_STATUS_UNAVAILABLE_DETAIL,
        "subscription_required": True,
    }
    assert supabase.tables["studio_subscriptions"] == [row]
    assert all(query["columns"] for query in supabase.query_log)


@pytest.mark.parametrize(
    "overrides, required",
    [
        ({}, False),
        ({"status": "trialing", "trial_end": "2999-01-01T00:00:00+00:00"}, False),
        ({"comped": True, "current_period_start": None, "current_period_end": None}, False),
        ({"comped": True, "stripe_subscription_id": None}, False),
        ({"comped": True, "status": "canceled"}, False),
        (
            {"comped": True, "status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"},
            True,
        ),
        ({"status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"}, True),
        ({"status": "trialing", "trial_end": "invalid"}, True),
        ({"status": "canceled"}, True),
        ({"status": "past_due"}, True),
        ({"stripe_subscription_id": None, "stripe_customer_id": None}, False),
        (
            {"status": "incomplete", "stripe_subscription_id": None, "stripe_customer_id": None},
            True,
        ),
    ],
    ids=[
        "active",
        "trialing",
        "comped-periods",
        "comped-missing-subscription",
        "comped-canceled",
        "comped-expired-trial",
        "expired-trial",
        "invalid-trial",
        "canceled",
        "past-due",
        "active-no-provider-ids",
        "incomplete-no-provider-ids",
    ],
)
def test_existing_access_projection_and_deny_fallback_are_preserved(
    overrides, required, no_provider_work
):
    row = subscription_row(**overrides)
    supabase = database_for(row)

    access = studio_scope.get_platform_subscription_access(
        supabase, "studio_1", allow_provider_repairs=False
    )

    assert access == {
        "status": row["status"],
        "comped": row["comped"],
        "subscription_required": required,
    }
    assert supabase.tables["studio_subscriptions"] == [row]


@pytest.mark.parametrize("strict_repairs", [False, True])
def test_service_refuses_pending_row_even_without_strict_repairs(strict_repairs, no_provider_work):
    service = PlatformBillingService(database_for(subscription_row(current_period_end=None)))

    with pytest.raises(AccessRepairDeferred):
        service.get_access_status_row(
            "studio_1", strict_repairs=strict_repairs, allow_provider_repairs=False
        )


@pytest.mark.parametrize("pending", [False, True], ids=["persisted-repair", "pending-repair"])
@pytest.mark.parametrize("window_kind", ["success", "fault", "changed-row", "expired"])
def test_bounded_access_leaves_existing_flight_and_retry_windows_untouched(
    pending, window_kind, no_provider_work
):
    row = subscription_row(current_period_end=None) if pending else subscription_row()
    fingerprint = PlatformBillingService._row_fingerprint(row)
    if window_kind == "changed-row":
        fingerprint = ("other-row",)
    window = platform_billing_service._AccessRepairWindow(
        -1 if window_kind == "expired" else float("inf"),
        replay_fault=window_kind == "fault",
        row_fingerprint=fingerprint,
    )
    platform_billing_service._access_repair_retry_after.update(
        {"studio_1": window, "studio_other": window}
    )
    flight = platform_billing_service._AccessRepairFlight()
    flight.completion.result = Mock(side_effect=AssertionError("Must not wait for a repair"))
    platform_billing_service._access_repair_flights["studio_1"] = flight
    windows_before = dict(platform_billing_service._access_repair_retry_after)
    flights_before = dict(platform_billing_service._access_repair_flights)
    window_before = (window.retry_after, window.replay_fault, window.row_fingerprint)

    if pending:
        with pytest.raises(HTTPException) as error:
            studio_scope.get_platform_subscription_access(
                database_for(row), "studio_1", allow_provider_repairs=False
            )
        assert error.value.status_code == 503
        assert error.value.detail["code"] == "BILLING_STATUS_UNAVAILABLE"
    else:
        access = studio_scope.get_platform_subscription_access(
            database_for(row), "studio_1", allow_provider_repairs=False
        )
        assert access["subscription_required"] is False

    assert platform_billing_service._access_repair_retry_after == windows_before
    assert platform_billing_service._access_repair_flights == flights_before
    assert (window.retry_after, window.replay_fault, window.row_fingerprint) == window_before
    flight.completion.result.assert_not_called()
    assert not flight.completion.done()


def test_bounded_access_includes_any_new_owner_repair_guard(no_provider_work):
    repair = Mock(side_effect=AssertionError("A repair must not run"))
    steps = (*platform_billing_service.ACCESS_REPAIR_STEPS, (lambda _service, _row: True, repair))
    with (
        patch.object(platform_billing_service, "ACCESS_REPAIR_STEPS", steps),
        pytest.raises(HTTPException) as error,
    ):
        studio_scope.get_platform_subscription_access(
            database_for(subscription_row()), "studio_1", allow_provider_repairs=False
        )
    assert error.value.status_code == 503
    repair.assert_not_called()


def test_local_read_failure_is_unavailable(no_provider_work):
    supabase = database_for(subscription_row())
    supabase.table_failures["studio_subscriptions"] = RuntimeError("Synthetic database failure")

    with pytest.raises(HTTPException) as error:
        studio_scope.get_platform_subscription_access(
            supabase, "studio_1", allow_provider_repairs=False
        )

    assert error.value.status_code == 503
    assert error.value.detail["code"] == "BILLING_STATUS_UNAVAILABLE"
    assert len(supabase.query_log) == 1


@pytest.mark.parametrize(
    "options", [{}, {"allow_provider_repairs": True}], ids=["default", "explicit"]
)
def test_default_strict_caller_still_repairs_and_records_provider_failure(options):
    supabase = database_for(subscription_row(current_period_end=None))
    with patch.object(platform_billing_service, "StripeService") as stripe:
        stripe.return_value.retrieve_subscription.side_effect = TimeoutError("Synthetic timeout")
        with pytest.raises(HTTPException) as error:
            studio_scope.get_platform_subscription_access(supabase, "studio_1", **options)

        stripe.return_value.retrieve_subscription.assert_called_once_with("sub_123")

    assert error.value.status_code == 503
    assert error.value.detail["code"] == "BILLING_STATUS_UNAVAILABLE"
    assert platform_billing_service._access_repair_retry_after["studio_1"].replay_fault
    assert platform_billing_service._access_repair_flights == {}
