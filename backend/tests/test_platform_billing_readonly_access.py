from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError

from app.services import platform_billing_service, studio_scope
from app.services.platform_billing_service import (
    AccessRepairDeferred,
    AccessRepairProviderError,
    AccessStatusUnavailable,
    PlatformBillingService,
)
from tests.fakes.supabase import FakeResult, FakeTableQuery, RpcBackedSupabase


def subscription_row(**overrides):
    return {
        "studio_id": "studio_1",
        "stripe_subscription_id": "sub_private",
        "stripe_customer_id": "cus_private",
        "status": "active",
        "comped": False,
        "trial_end": None,
        "current_period_start": "2026-01-01T00:00:00+00:00",
        "current_period_end": "2999-01-01T00:00:00+00:00",
        **overrides,
    }


def database_for(row):
    return RpcBackedSupabase({"studio_subscriptions": [deepcopy(row)] if row is not None else []})


class ScriptedQuery(FakeTableQuery):
    def execute(self):
        super().execute()
        response = self.supabase.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, SimpleNamespace):
            return response
        return FakeResult(response)


class ScriptedSupabase(RpcBackedSupabase):
    def __init__(self, *responses):
        super().__init__({"studio_subscriptions": []})
        self.responses = list(responses)

    def table(self, name):
        return ScriptedQuery(self, name)


@pytest.fixture(autouse=True)
def production_settings():
    settings = SimpleNamespace(ENVIRONMENT="production")
    with (
        patch.object(platform_billing_service, "get_settings", return_value=settings),
        patch.object(studio_scope, "get_settings", return_value=settings),
    ):
        yield


@pytest.fixture
def no_side_effects(monkeypatch):
    """Keep the real initializer and repairs observable, without replacing their work."""
    service = PlatformBillingService
    ensure = Mock(wraps=service._ensure_subscription_row)
    uncoordinated = Mock(wraps=service._get_access_status_row_uncoordinated)
    repairs = [
        Mock(wraps=repair) for _guard, repair in platform_billing_service.ACCESS_REPAIR_STEPS
    ]
    steps = tuple(
        (guard, repair)
        for (guard, _original), repair in zip(
            platform_billing_service.ACCESS_REPAIR_STEPS, repairs, strict=True
        )
    )
    monkeypatch.setattr(
        service, "_ensure_subscription_row", lambda self, studio_id: ensure(self, studio_id)
    )
    monkeypatch.setattr(
        service,
        "_get_access_status_row_uncoordinated",
        lambda self, *args, **kwargs: uncoordinated(self, *args, **kwargs),
    )
    monkeypatch.setattr(platform_billing_service, "ACCESS_REPAIR_STEPS", steps)
    with (
        patch.object(platform_billing_service, "StripeService") as stripe,
        patch.object(platform_billing_service, "_access_repair_metadata_lock") as lock,
    ):
        stripe.side_effect = AssertionError("Read-only access must not construct Stripe")
        lock.__enter__.side_effect = AssertionError("Read-only access must not coordinate repairs")
        yield
        stripe.assert_not_called()
        lock.__enter__.assert_not_called()
        ensure.assert_not_called()
        uncoordinated.assert_not_called()
        for repair in repairs:
            repair.assert_not_called()


def assert_selects_only(database, count):
    assert len(database.query_log) == count
    assert database.rpc_calls == []
    for query in database.query_log:
        assert query["table"] == "studio_subscriptions"
        assert query["columns"] in {"*", "status, comped, trial_end"}
        assert query["filters"] == (("eq", "studio_id", "studio_1"),)
        assert query["insert"] is None
        assert query["update"] is None
        assert query["upsert"] is None
        assert query["delete"] is False


def assert_unavailable(error):
    assert error.value.status_code == 503
    assert error.value.detail == {
        **studio_scope.BILLING_STATUS_UNAVAILABLE_DETAIL,
        "subscription_required": True,
    }


@pytest.mark.parametrize("allow_provider_repairs", [False, True])
@pytest.mark.parametrize("strict_repairs", [False, True])
def test_service_returns_only_the_selected_row(
    allow_provider_repairs, strict_repairs, no_side_effects
):
    row = subscription_row()
    database = ScriptedSupabase(row)

    result = PlatformBillingService(database).get_access_status_row(
        "studio_1",
        strict_repairs=strict_repairs,
        allow_provider_repairs=allow_provider_repairs,
        read_only=True,
    )

    assert result is row
    assert_selects_only(database, 1)


REPAIR_PENDING = [
    {"current_period_start": None},
    {"current_period_end": None},
    {"stripe_subscription_id": None},
    {"current_period_start": "2999-02-01T00:00:00+00:00"},
    {"status": "trialing", "trial_end": None},
    {"status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"},
    {"status": "trialing", "trial_end": "invalid"},
    {"status": "canceled"},
]


@pytest.mark.parametrize("overrides", REPAIR_PENDING)
@pytest.mark.parametrize("allow_provider_repairs", [False, True])
@pytest.mark.parametrize("strict_repairs", [False, True])
def test_service_defers_all_owner_repair_guards(
    overrides, allow_provider_repairs, strict_repairs, no_side_effects
):
    row = subscription_row(**overrides)
    database = database_for(row)

    with pytest.raises(AccessRepairDeferred):
        PlatformBillingService(database).get_access_status_row(
            "studio_1",
            strict_repairs=strict_repairs,
            allow_provider_repairs=allow_provider_repairs,
            read_only=True,
        )

    assert database.tables["studio_subscriptions"] == [row]
    assert_selects_only(database, 1)


@pytest.mark.parametrize(
    "overrides, outcome",
    [
        ({}, 200),
        ({"status": "trialing", "trial_end": "2999-01-01T00:00:00+00:00"}, 200),
        ({"status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"}, 402),
        ({"status": "trialing", "trial_end": "invalid"}, 402),
        ({"status": "trialing", "trial_end": None}, 503),
        ({"status": "trialing", "trial_end": ""}, 503),
        ({"status": "canceled"}, 402),
        ({"status": "past_due"}, 402),
        ({"status": "unpaid"}, 402),
        ({"status": "paused"}, 402),
        ({"status": "incomplete"}, 402),
        ({"status": "incomplete_expired"}, 402),
        ({"current_period_end": None}, 503),
        ({"stripe_subscription_id": None}, 503),
        ({"current_period_start": "2999-02-01T00:00:00+00:00"}, 503),
        ({"current_period_start": "invalid", "current_period_end": "invalid"}, 200),
        ({"stripe_subscription_id": None, "stripe_customer_id": None}, 200),
        ({"comped": True, "current_period_end": None}, 200),
        ({"comped": True, "stripe_subscription_id": None}, 200),
        ({"comped": True, "status": "canceled"}, 200),
        ({"comped": True, "status": "trialing", "trial_end": "invalid"}, 402),
        (
            {"comped": True, "status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"},
            402,
        ),
        ({"status": "comped", "stripe_subscription_id": None, "stripe_customer_id": None}, 200),
        ({"status": "comped", "comped": True}, 200),
    ],
)
@pytest.mark.parametrize("allow_provider_repairs", [False, True])
def test_scope_reuses_existing_access_decisions(
    overrides, outcome, allow_provider_repairs, no_side_effects
):
    row = subscription_row(**overrides)
    database = database_for(row)
    options = {"read_only": True, "allow_provider_repairs": allow_provider_repairs}

    if outcome == 503:
        with pytest.raises(HTTPException) as error:
            studio_scope.get_platform_subscription_access(database, "studio_1", **options)
        assert_unavailable(error)
    else:
        access = studio_scope.get_platform_subscription_access(database, "studio_1", **options)
        assert access == {
            "status": row["status"],
            "comped": row["comped"],
            "subscription_required": outcome == 402,
        }

    first_read_count = len(database.query_log)
    assert_selects_only(database, first_read_count)
    if outcome == 200:
        studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)
    else:
        with pytest.raises(HTTPException) as error:
            studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)
        if outcome == 503:
            assert_unavailable(error)
        else:
            assert error.value.status_code == 402
            assert error.value.detail == {
                **studio_scope.SUBSCRIPTION_REQUIRED_DETAIL,
                "status": row["status"],
                "comped": row["comped"],
                "subscription_required": True,
            }
    assert_selects_only(database, first_read_count * 2)
    assert database.tables["studio_subscriptions"] == [row]


MALFORMED_ROWS = [
    None,
    {},
    [],
    [subscription_row()],
    False,
    1,
    "sub_private cus_private",
    SimpleNamespace(),
]
for field in subscription_row():
    missing = subscription_row()
    missing.pop(field)
    MALFORMED_ROWS.append(missing)
for field, values in {
    "status": [None, "", "unknown_private", [], 1],
    "comped": [None, "false", "true", 0, 1, []],
    "studio_id": [None, "other_studio", 1],
    "stripe_subscription_id": [False, 1, []],
    "stripe_customer_id": [False, 1, {}],
    "trial_end": [False, 1, {}],
    "current_period_start": [False, 1, []],
    "current_period_end": [False, 1, {}],
}.items():
    MALFORMED_ROWS.extend(subscription_row(**{field: value}) for value in values)


@pytest.mark.parametrize("row", MALFORMED_ROWS)
def test_missing_or_malformed_initial_row_never_becomes_access_data(row, no_side_effects):
    database = ScriptedSupabase(row, row, row)

    with pytest.raises(
        AccessStatusUnavailable, match="^Koaryu Core subscription status is unavailable\\.$"
    ):
        PlatformBillingService(database).get_access_status_row("studio_1", read_only=True)
    for access_function in (
        studio_scope.get_platform_subscription_access,
        studio_scope.ensure_platform_subscription_access,
    ):
        with pytest.raises(HTTPException) as error:
            access_function(database, "studio_1", read_only=True)
        assert_unavailable(error)

    assert_selects_only(database, 3)
    assert database.tables["studio_subscriptions"] == []


@pytest.mark.parametrize(
    "row",
    [
        None,
        SimpleNamespace(),
        {},
        [],
        {"status": "active", "comped": "false", "trial_end": None},
        {"status": "canceled", "comped": False},
        {"status": "canceled", "comped": False, "trial_end": {}},
        {"status": "unknown_private", "comped": False, "trial_end": None},
        RuntimeError("sub_private cus_private database failure"),
        APIError({"code": "XX000", "message": "sub_private cus_private", "details": "private"}),
    ],
)
@pytest.mark.parametrize("fallback", ["deferred", "provider-error", "missing-configuration"])
def test_every_readonly_fallback_requires_a_current_real_row(row, fallback, no_side_effects):
    initial = subscription_row(status="canceled")
    if fallback == "provider-error":
        initial = AccessRepairProviderError(
            RuntimeError("sub_private cus_private"), reachable=False
        )
    elif fallback == "missing-configuration":
        initial = HTTPException(409, studio_scope.MISSING_STRIPE_CONFIGURATION_DETAIL)
    database = ScriptedSupabase(initial, row)
    settings = SimpleNamespace(ENVIRONMENT="test")

    with (
        patch.object(studio_scope, "get_settings", return_value=settings),
        pytest.raises(HTTPException) as error,
    ):
        studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)

    assert_unavailable(error)
    assert_selects_only(database, 2)


@pytest.mark.parametrize("status_value, outcome", [("canceled", 402), ("active", 503)])
def test_deferred_read_uses_the_current_projected_fallback(status_value, outcome, no_side_effects):
    database = ScriptedSupabase(
        subscription_row(current_period_end=None),
        {"status": status_value, "comped": False, "trial_end": None},
    )

    with pytest.raises(HTTPException) as error:
        studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)

    assert error.value.status_code == outcome
    if outcome == 503:
        assert_unavailable(error)
    else:
        assert error.value.detail["status"] == "canceled"
    assert [query["columns"] for query in database.query_log] == ["*", "status, comped, trial_end"]
    assert_selects_only(database, 2)


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("sub_private cus_private database failure"),
        APIError({"code": "XX000", "message": "sub_private cus_private", "details": "private"}),
        HTTPException(404, "sub_private cus_private"),
    ],
)
def test_initial_read_failures_keep_fixed_safe_details(failure, no_side_effects):
    database = ScriptedSupabase(failure)

    with pytest.raises(HTTPException) as error:
        studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)

    assert_unavailable(error)
    assert_selects_only(database, 1)


@pytest.mark.parametrize("pending", [False, True])
@pytest.mark.parametrize("window_kind", ["success", "fault", "changed-row", "expired"])
def test_readonly_access_neither_uses_nor_changes_coordination(
    pending, window_kind, no_side_effects
):
    row = subscription_row(current_period_end=None) if pending else subscription_row()
    window = platform_billing_service._AccessRepairWindow(
        -1 if window_kind == "expired" else float("inf"),
        replay_fault=window_kind == "fault",
        row_fingerprint=("other",)
        if window_kind == "changed-row"
        else PlatformBillingService._row_fingerprint(row),
    )
    windows = {"studio_1": window, "studio_other": window}
    platform_billing_service._access_repair_retry_after.update(windows)
    flight = platform_billing_service._AccessRepairFlight()
    flights = {"studio_1": flight}
    platform_billing_service._access_repair_flights.update(flights)
    fields = (window.retry_after, window.replay_fault, window.row_fingerprint)
    database = database_for(row)

    if pending:
        with pytest.raises(HTTPException) as error:
            studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)
        assert_unavailable(error)
    else:
        studio_scope.ensure_platform_subscription_access(database, "studio_1", read_only=True)

    assert platform_billing_service._access_repair_retry_after == windows
    assert platform_billing_service._access_repair_flights == flights
    assert (window.retry_after, window.replay_fault, window.row_fingerprint) == fields
    assert not flight.completion.done()
    assert_selects_only(database, 2 if pending else 1)


def test_readonly_path_uses_the_owner_guard_registry(no_side_effects):
    repair = Mock(side_effect=AssertionError("Read-only access must not run a new repair"))
    steps = (*platform_billing_service.ACCESS_REPAIR_STEPS, (lambda _service, _row: True, repair))
    with (
        patch.object(platform_billing_service, "ACCESS_REPAIR_STEPS", steps),
        pytest.raises(HTTPException) as error,
    ):
        studio_scope.ensure_platform_subscription_access(
            database_for(subscription_row()), "studio_1", read_only=True
        )
    assert_unavailable(error)
    repair.assert_not_called()


@pytest.mark.parametrize("options", [{}, {"read_only": False}])
@pytest.mark.parametrize("allow_provider_repairs", [False, True])
def test_default_mode_still_initializes_missing_rows(options, allow_provider_repairs):
    database = database_for(None)

    access = studio_scope.get_platform_subscription_access(
        database, "studio_1", allow_provider_repairs=allow_provider_repairs, **options
    )

    assert access == {"status": "incomplete", "comped": False, "subscription_required": True}
    assert database.tables["studio_subscriptions"] == [
        {
            "id": "studio_subscriptions_1",
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": False,
        }
    ]
    assert database.query_log[1]["insert"] == {
        "studio_id": "studio_1",
        "status": "incomplete",
        "comped": False,
    }


@pytest.mark.parametrize("options", [{}, {"read_only": False}])
def test_default_mode_still_repairs_and_records_provider_failure(options):
    database = database_for(subscription_row(current_period_end=None))
    with patch.object(platform_billing_service, "StripeService") as stripe:
        stripe.return_value.retrieve_subscription.side_effect = TimeoutError("Synthetic timeout")
        with pytest.raises(HTTPException) as error:
            studio_scope.ensure_platform_subscription_access(database, "studio_1", **options)
        stripe.return_value.retrieve_subscription.assert_called_once_with("sub_private")

    assert_unavailable(error)
    assert platform_billing_service._access_repair_retry_after["studio_1"].replay_fault
    assert platform_billing_service._access_repair_flights == {}


@pytest.mark.parametrize("options", [{}, {"read_only": False}])
def test_default_collaborator_invocation_shapes_are_unchanged(options):
    database = database_for(None)
    row = subscription_row()
    with patch.object(PlatformBillingService, "get_access_status_row", return_value=row) as get_row:
        studio_scope.get_platform_subscription_access(database, "studio_1", **options)
        get_row.assert_called_once_with(
            "studio_1", strict_repairs=True, allow_provider_repairs=True
        )

    access = {"status": "active", "comped": False, "subscription_required": False}
    with patch.object(studio_scope, "get_platform_subscription_access", return_value=access) as get:
        studio_scope.ensure_platform_subscription_access(database, "studio_1", **options)
        get.assert_called_once_with(database, "studio_1")

    denied = {"status": "incomplete", "comped": False, "subscription_required": True}
    for fault in (
        AccessRepairDeferred("studio_1"),
        HTTPException(409, studio_scope.MISSING_STRIPE_CONFIGURATION_DETAIL),
    ):
        with (
            patch.object(PlatformBillingService, "get_access_status_row", side_effect=fault),
            patch.object(
                studio_scope, "get_settings", return_value=SimpleNamespace(ENVIRONMENT="test")
            ),
            patch.object(
                studio_scope, "_get_local_platform_subscription_access", return_value=denied
            ) as get_local,
        ):
            assert (
                studio_scope.get_platform_subscription_access(database, "studio_1", **options)
                == denied
            )
            get_local.assert_called_once_with(database, "studio_1")


def test_default_local_fallback_retains_missing_row_behavior():
    access = studio_scope._get_local_platform_subscription_access(database_for(None), "studio_1")
    assert access == {"status": "incomplete", "comped": False, "subscription_required": True}
