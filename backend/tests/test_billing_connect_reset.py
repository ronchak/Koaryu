from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError

from app.services.billing_connect_accounts import BillingConnectAccountStore


def store_with_result(payload):
    client = Mock()
    client.rpc.return_value.execute.return_value.data = payload
    return BillingConnectAccountStore(client, settings=SimpleNamespace()), client


@pytest.mark.parametrize(
    "outcome,code",
    [
        ("actor_denied", 403),
        ("not_found", 404),
        ("stale_account", 409),
        ("billing_history", 409),
        ("provider_operation_pending", 409),
        ("event_pending", 409),
    ],
)
def test_reset_refusals_do_not_write_or_retry(outcome, code):
    store, client = store_with_result({"outcome": outcome})
    with pytest.raises(HTTPException) as caught:
        store.reset_atomic(
            "studio",
            "actor",
            {
                "stripe_connected_account_id": "acct_one",
                "metadata": {"connect_account_generation": 3},
            },
        )
    assert caught.value.status_code == code
    client.rpc.assert_called_once()
    assert client.rpc.call_args.args[1]["p_expected_connect_account_generation"] == 3
    client.table.assert_not_called()


def test_reset_lock_contention_is_retryable_without_automatic_retry():
    store, client = store_with_result(None)
    client.rpc.return_value.execute.side_effect = APIError(
        {"code": "55P03", "message": "lock unavailable", "details": None, "hint": None}
    )
    with pytest.raises(HTTPException) as caught:
        store.reset_atomic("studio", "actor", {"stripe_connected_account_id": "acct_one"})
    assert caught.value.status_code == 409
    assert caught.value.headers == {"Retry-After": "1"}
    client.rpc.assert_called_once()


def test_reset_unknown_database_fault_is_not_reported_as_success():
    store, client = store_with_result(None)
    client.rpc.return_value.execute.side_effect = RuntimeError("audit failed")
    with pytest.raises(RuntimeError, match="audit failed"):
        store.reset_atomic("studio", "actor", {"stripe_connected_account_id": "acct_one"})


@pytest.mark.parametrize(
    "payload", [None, [], {}, {"outcome": "reset"}, {"outcome": "other", "account": {}}]
)
def test_reset_malformed_response_is_refused(payload):
    store, _ = store_with_result(payload)
    with pytest.raises(HTTPException) as caught:
        store.reset_atomic("studio", "actor", {})
    assert caught.value.status_code == 500


def test_disconnected_account_is_a_noop_without_rpc():
    import asyncio
    from app.services.billing_connect_actions import BillingConnectActions

    store = Mock()
    store.ensure_row.return_value = {"studio_id": "studio", "stripe_connected_account_id": None}
    store.response.return_value = SimpleNamespace(status="not_connected")
    actions = BillingConnectActions(Mock(), store, SimpleNamespace())
    assert asyncio.run(actions.reset_account("studio", "actor")).status == "not_connected"
    store.reset_atomic.assert_not_called()


def test_atomic_no_change_returns_the_locked_account():
    account = {"studio_id": "studio", "stripe_connected_account_id": None}
    store, client = store_with_result({"outcome": "no_change", "account": account})
    assert store.reset_atomic("studio", "actor", account) == account
    client.table.assert_not_called()
