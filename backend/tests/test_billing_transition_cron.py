from __future__ import annotations

from unittest.mock import patch

from urllib.error import HTTPError

import pytest

from app.services.billing_transition_cron import (
    BillingTransitionCronConfig,
    main,
    process_due_billing_transitions,
)


class _Response:
    def __init__(self, payload: bytes, *, status: int = 200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit: int) -> bytes:
        return self.payload[:limit]


def _config() -> BillingTransitionCronConfig:
    return BillingTransitionCronConfig.from_environment({
        "ENVIRONMENT": "staging",
        "KOARYU_BACKEND_API_URL": "https://koaryu-staging.onrender.com/api/v1",
        "BILLING_TRANSITION_WORKER_SECRET": "s" * 40,
    })


def test_cron_configuration_pins_environment_url_and_secret():
    assert _config().environment == "staging"
    for unsafe in (
        {
            "ENVIRONMENT": "staging",
            "KOARYU_BACKEND_API_URL": "https://koaryu.onrender.com/api/v1",
            "BILLING_TRANSITION_WORKER_SECRET": "s" * 40,
        },
        {
            "ENVIRONMENT": "preview",
            "KOARYU_BACKEND_API_URL": "https://koaryu-staging.onrender.com/api/v1",
            "BILLING_TRANSITION_WORKER_SECRET": "s" * 40,
        },
        {
            "ENVIRONMENT": "staging",
            "KOARYU_BACKEND_API_URL": "https://koaryu-staging.onrender.com/api/v1",
            "BILLING_TRANSITION_WORKER_SECRET": "short",
        },
    ):
        with pytest.raises(RuntimeError):
            BillingTransitionCronConfig.from_environment(unsafe)


def test_cron_posts_to_exact_internal_route_without_logging_secret():
    response = _Response(
        b'{"claimed":2,"completed":2,"reconciliation_required":0,"failed":0}'
    )
    with patch(
        "app.services.billing_transition_cron._NO_REDIRECT_OPENER.open",
        return_value=response,
    ) as request:
        result = process_due_billing_transitions(_config())

    outgoing = request.call_args.args[0]
    assert outgoing.full_url == (
        "https://koaryu-staging.onrender.com/api/v1/internal/billing/"
        "enrollment-transitions/process-due?limit=25"
    )
    assert outgoing.method == "POST"
    assert outgoing.headers["X-internal-secret"] == "s" * 40
    assert request.call_args.kwargs == {"timeout": 130.0}
    assert result == {
        "claimed": 2,
        "completed": 2,
        "failed": 0,
        "reconciliation_required": 0,
    }


@pytest.mark.parametrize(
    "payload",
    (
        b'{"claimed":1,"completed":0,"reconciliation_required":1,"failed":0}',
        b'{"claimed":1,"completed":0,"reconciliation_required":0,"failed":1}',
        b'{"claimed":true,"completed":0,"reconciliation_required":0,"failed":0}',
        b'{"claimed":0,"completed":0,"failed":0}',
        b"not-json",
        b"x" * 4097,
    ),
)
def test_cron_fails_closed_on_unsafe_or_attention_required_results(payload: bytes):
    with patch(
        "app.services.billing_transition_cron._NO_REDIRECT_OPENER.open",
        return_value=_Response(payload),
    ):
        with pytest.raises(RuntimeError):
            process_due_billing_transitions(_config())


@pytest.mark.parametrize("status_code", (301, 302, 303, 307, 308))
def test_cron_rejects_redirects_without_forwarding_worker_secret(status_code: int):
    error = HTTPError(
        "https://koaryu-staging.onrender.com/api/v1/internal/billing/redirect",
        status_code,
        "redirect rejected",
        {"Location": "https://attacker.invalid/capture"},
        None,
    )
    with patch(
        "app.services.billing_transition_cron._NO_REDIRECT_OPENER.open",
        side_effect=error,
    ) as request:
        with pytest.raises(RuntimeError, match="request failed"):
            process_due_billing_transitions(_config())

    assert request.call_count == 1
    outgoing = request.call_args.args[0]
    assert outgoing.headers["X-internal-secret"] == "s" * 40


@pytest.mark.parametrize("status_code", (301, 302, 303, 307, 308))
def test_redirect_handler_never_constructs_a_forwarded_request(status_code: int):
    from app.services.billing_transition_cron import _RejectRedirectHandler

    request = object()
    assert _RejectRedirectHandler().redirect_request(
        request,
        None,
        status_code,
        "redirect",
        {"Location": "https://attacker.invalid/capture"},
        "https://attacker.invalid/capture",
    ) is None


@pytest.mark.parametrize(
    ("result", "expected_output"),
    (
        (
            {
                "claimed": 0,
                "completed": 0,
                "reconciliation_required": 0,
                "failed": 0,
            },
            '{"claimed":0,"completed":0,"reconciliation_required":0,"failed":0}\n',
        ),
        (
            {
                "claimed": 17,
                "completed": 17,
                "reconciliation_required": 0,
                "failed": 0,
            },
            "Billing transition cron completed nonzero work.\n",
        ),
    ),
)
def test_cron_main_prints_fixed_result_without_response_values(
    capsys,
    result: dict[str, int],
    expected_output: str,
):
    with patch(
        "app.services.billing_transition_cron.BillingTransitionCronConfig.from_environment",
        return_value=_config(),
    ), patch(
        "app.services.billing_transition_cron.process_due_billing_transitions",
        return_value=result,
    ):
        main()

    assert capsys.readouterr().out == expected_output


def test_cron_main_prints_nothing_when_processing_requires_attention(capsys):
    with patch(
        "app.services.billing_transition_cron.BillingTransitionCronConfig.from_environment",
        return_value=_config(),
    ), patch(
        "app.services.billing_transition_cron.process_due_billing_transitions",
        side_effect=RuntimeError("Billing transition cron requires operator attention."),
    ):
        with pytest.raises(RuntimeError):
            main()

    assert capsys.readouterr().out == ""
