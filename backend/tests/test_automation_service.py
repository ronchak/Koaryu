"""Outbox runner proofs with synthetic SQL responses and provider transports."""

from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlsplit
from uuid import UUID

import pytest
from fastapi import HTTPException
from test_automation_email import email_settings
from test_automation_email_credentials import credential_state

from app.services import automation_service as service
from app.services.automation_email import DeliveryResult
from app.services.automation_email_credentials import PROVIDER_KEY, CredentialCodec
from tests.fakes.supabase import TableBackedSupabase


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


def snapshot(delivery_id="delivery-1", **changes):
    return {
        "delivery_id": delivery_id,
        "attempt_id": delivery_id + ":1",
        "student_first_name": "Sam",
        "studio_name": "Example",
        "days_absent": 20,
        "recipient_email": "koaryu@outlook.com",
        "subject_template": "Hi {{student_first_name}}",
        "body_template": "{{studio_name}} {{days_absent}}",
        "reply_to_email": "reply@example.com",
        "unsubscribe_token": "a" * 64,
        **changes,
    }


class WorkerDatabase(TableBackedSupabase):
    def __init__(self, settings, *, row_count=1):
        super().__init__(
            {
                "studio_subscriptions": [
                    {
                        "studio_id": "studio",
                        "status": "comped",
                        "comped": True,
                    }
                ]
            }
        )
        self.ciphertext = CredentialCodec(
            settings.EMAIL_TOKEN_ENCRYPTION_KEY,
            settings.EMAIL_GRAPH_CLIENT_ID,
            settings.EMAIL_FROM_ADDRESS,
        ).encrypt(credential_state())
        self.calls = []
        self.executed = []
        self.handlers = {}
        self.claims = [
            {
                "id": f"delivery-{index + 1}",
                "claim_token": f"claim-{index + 1}",
                "studio_id": "studio",
            }
            for index in range(row_count)
        ]
        self.messages = {claim["id"]: snapshot(claim["id"]) for claim in self.claims}
        self.on_execute = None
        self.enqueued = 0
        self.enqueue_has_more = False
        self.begun = []
        self.settled = []

    def rpc(self, name, params):
        self.calls.append((name, params))

        def execute():
            self.executed.append((name, params))
            if self.on_execute:
                self.on_execute(name, params)
            if name in self.handlers:
                handler = self.handlers[name]
                if isinstance(handler, Exception):
                    raise handler
                result = handler(params) if callable(handler) else handler
            elif name == "get_automation_email_credential_v1":
                result = {
                    "provider_key": PROVIDER_KEY,
                    "revision": 1,
                    "encrypted_credentials": self.ciphertext,
                }
            elif name == "enqueue_missed_class_automations_v1":
                result = {"enqueued": self.enqueued, "has_more": self.enqueue_has_more}
            elif name == "claim_missed_class_automations_v1":
                assert params["p_limit"] == 1
                allowed = params["p_allowed_recipients"]
                eligible = [
                    claim
                    for claim in self.claims
                    if not allowed or self.messages[claim["id"]]["recipient_email"] in allowed
                ]
                items = eligible[:1]
                for item in items:
                    self.claims.remove(item)
                result = {"items": items, "has_more": len(eligible) > 1}
            elif name == "begin_missed_class_automation_v1":
                self.begun.append(params)
                result = {
                    "ready": True,
                    "state": "sending",
                    "reason": None,
                    "message": self.messages[params["p_delivery_id"]],
                }
            elif name == "settle_missed_class_automation_v1":
                self.settled.append(params)
                result = {
                    "updated": True,
                    "state": {
                        "accepted": "accepted",
                        "unknown": "unknown",
                        "retryable_failure": "retry_wait",
                        "permanent_failure": "failed",
                    }[params["p_outcome"]],
                }
            else:
                raise AssertionError("Unexpected synthetic RPC")
            return SimpleNamespace(data=result)

        return SimpleNamespace(execute=execute)


@pytest.fixture
def runner(monkeypatch):
    settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
    database = WorkerDatabase(settings)
    clock = Clock()
    closer = Mock()
    factory = Mock(return_value=database)
    send = Mock(
        return_value=DeliveryResult(
            "accepted", provider_request_id="12345678-1234-4234-8234-123456789012"
        )
    )
    transport_factory = Mock(return_value=SimpleNamespace(send=send))
    access = Mock(return_value={"subscription_required": False})
    monkeypatch.setattr(service, "get_platform_subscription_access", access)

    def run(**kwargs):
        return service.process_due_missed_class_automations(
            settings,
            clock=clock,
            client_factory=factory,
            client_closer=closer,
            transport_factory=transport_factory,
            **kwargs,
        ).model_dump()

    return SimpleNamespace(
        settings=settings,
        database=database,
        clock=clock,
        closer=closer,
        factory=factory,
        send=send,
        transport_factory=transport_factory,
        access=access,
        run=run,
    )


def assert_counts(result, *, processed, **outcomes):
    assert result["processed"] == processed
    assert (
        sum(result[key] for key in ("accepted", "retry_wait", "failed", "unknown", "skipped"))
        == processed
    )
    for name, expected in outcomes.items():
        assert result[name] == expected


@pytest.mark.parametrize(
    "changes",
    [
        {"AUTOMATION_WORKER_ENABLED": False},
        {"EMAIL_SEND_ENABLED": False},
        {"EMAIL_PROVIDER": "disabled"},
    ],
)
def test_disabled_flags_create_no_client_and_send_nothing(runner, changes):
    for name, value in changes.items():
        setattr(runner.settings, name, value)
    assert_counts(runner.run(), processed=0, enqueued=0, has_more=False)
    runner.factory.assert_not_called()
    runner.send.assert_not_called()


def test_not_ready_stops_before_enqueue_and_closes_client(runner):
    runner.database.ciphertext = "synthetic-invalid-ciphertext"
    assert_counts(runner.run(), processed=0, enqueued=0)
    assert [name for name, _ in runner.database.calls] == ["get_automation_email_credential_v1"]
    runner.send.assert_not_called()
    runner.closer.assert_called_once_with(runner.database)


def test_accepted_uses_snapshots_stable_identity_fragment_and_exact_settlement(runner):
    result = runner.run(limit=1)
    assert_counts(result, processed=1, accepted=1, has_more=False)
    runner.factory.assert_called_once_with(postgrest_client_timeout=5.0)
    runner.closer.assert_called_once_with(runner.database)
    message = runner.send.call_args.args[0]
    assert message.to_address == "koaryu@outlook.com"
    assert message.subject == "Hi Sam" and message.reply_to == "reply@example.com"
    assert UUID(message.attempt_id).version == 5
    assert runner.database.messages["delivery-1"]["attempt_id"] == "delivery-1:1"
    url = message.text_body.split("Unsubscribe from these reminders: ")[1]
    assert urlsplit(url).path == "/api/v1/automations/unsubscribe"
    assert urlsplit(url).fragment == "a" * 64 and urlsplit(url).query == ""
    assert runner.send.call_args.kwargs == {"deadline": 120.0}
    assert runner.database.begun == [
        {
            "p_delivery_id": "delivery-1",
            "p_claim_token": "claim-1",
            "p_allowed_recipients": ["koaryu@outlook.com"],
        }
    ]
    assert runner.database.settled[0]["p_delivery_id"] == "delivery-1"
    assert runner.database.settled[0]["p_claim_token"] == "claim-1"
    assert runner.database.settled[0]["p_outcome"] == "accepted"
    assert "delivered" not in result
    assert runner.access.call_args.kwargs == {"allow_provider_repairs": False}


def test_allowlist_normalized_at_every_boundary_excludes_contacts_before_begin(runner):
    runner.settings.EMAIL_ALLOWED_RECIPIENTS = " Koaryu@Outlook.COM "
    runner.database.messages["delivery-1"]["recipient_email"] = "customer@example.com"
    assert_counts(runner.run(), processed=0, has_more=False)
    assert not runner.database.begun
    runner.send.assert_not_called()
    assert len(runner.database.claims) == 1
    for name, params in runner.database.calls:
        if name.startswith(("enqueue_", "claim_", "begin_")):
            assert params["p_allowed_recipients"] == ["koaryu@outlook.com"]


def test_explicit_live_mode_does_not_redirect_customer_content(runner):
    runner.settings.EMAIL_ALLOWED_RECIPIENTS = ""
    runner.database.messages["delivery-1"]["recipient_email"] = "customer@example.com"
    assert_counts(runner.run(), processed=1, accepted=1)
    assert runner.send.call_args.args[0].to_address == "customer@example.com"
    assert all(
        params["p_allowed_recipients"] == []
        for name, params in runner.database.calls
        if name.startswith(("enqueue_", "claim_", "begin_"))
    )


def test_entitlement_once_per_studio_and_claim_only_one_each_time(runner):
    database = WorkerDatabase(runner.settings, row_count=4)
    runner.factory.return_value = database
    assert_counts(runner.run(limit=3), processed=3, accepted=3, has_more=True)
    runner.access.assert_called_once()
    assert len(database.claims) == 1
    assert [params["p_limit"] for name, params in database.calls if name.startswith("claim_")] == [
        1,
        1,
        1,
    ]


@pytest.mark.parametrize(
    "access", [{"subscription_required": True}, HTTPException(503, "unavailable")]
)
def test_entitlement_denied_never_begins_or_spends_send_attempt(runner, access):
    if isinstance(access, Exception):
        runner.access.side_effect = access
    else:
        runner.access.return_value = access
    assert_counts(runner.run(), processed=1, skipped=1)
    assert not runner.database.begun and not runner.database.settled
    runner.send.assert_not_called()


def test_real_entitlement_owner_refuses_active_pending_row_without_provider(runner, monkeypatch):
    from app.services.platform_billing_service import PlatformBillingService
    from app.services.studio_scope import get_platform_subscription_access

    runner.database.tables["studio_subscriptions"][0] = {
        "studio_id": "studio",
        "status": "active",
        "comped": False,
        "stripe_subscription_id": "synthetic-subscription",
        "stripe_customer_id": "synthetic-customer",
        "pending_plan_key": "core",
        "current_period_start": None,
        "current_period_end": None,
    }
    monkeypatch.setattr(
        service, "get_platform_subscription_access", get_platform_subscription_access
    )
    repair = Mock(side_effect=AssertionError("No provider repair"))
    monkeypatch.setattr(PlatformBillingService, "_get_access_status_row_uncoordinated", repair)
    assert_counts(runner.run(), processed=1, skipped=1)
    repair.assert_not_called()
    runner.send.assert_not_called()
    assert not runner.database.begun


@pytest.mark.parametrize(
    "reason,state",
    [
        ("suppressed", "skipped"),
        ("rule_paused", "queued"),
        ("on_hold", "queued"),
        ("contact_changed", "queued"),
        ("recipient_not_allowed", "queued"),
        (None, "claimed"),
    ],
)
def test_sql_recheck_decline_never_calls_provider_or_settle(runner, reason, state):
    runner.database.handlers["begin_missed_class_automation_v1"] = {
        "ready": False,
        "state": state,
        "reason": reason,
        "message": None,
    }
    assert_counts(runner.run(), processed=1, skipped=1)
    runner.send.assert_not_called()
    assert not runner.database.settled


@pytest.mark.parametrize(
    "outcome,code,expected",
    [
        ("accepted", None, "accepted"),
        ("retryable_failure", "provider_throttled", "retry_wait"),
        ("retryable_failure", "provider_connection_failed", "retry_wait"),
        ("permanent_failure", "provider_rejected", "failed"),
        ("unknown", "provider_submission_unknown", "unknown"),
    ],
)
def test_known_transport_results_settle_with_the_same_claim(runner, outcome, code, expected):
    runner.send.return_value = DeliveryResult(outcome, code, retry_after_seconds=90)
    assert_counts(runner.run(), processed=1, **{expected: 1})
    assert runner.database.settled[0]["p_outcome"] == outcome
    assert runner.database.settled[0]["p_retry_after_seconds"] == 90
    assert runner.database.settled[0]["p_claim_token"] == "claim-1"


@pytest.mark.parametrize(
    "result",
    [
        DeliveryResult("unknown", "provider_submission_unknown"),
        DeliveryResult("permanent_failure", "provider_rejected"),
        DeliveryResult("permanent_failure", "authentication_required"),
        DeliveryResult("retryable_failure", "credential_store_unavailable"),
        DeliveryResult("retryable_failure", "credential_refresh_conflict"),
        DeliveryResult("retryable_failure", "token_refresh_unavailable"),
        DeliveryResult("retryable_failure", "token_refresh_throttled"),
        DeliveryResult("retryable_failure", "send_budget_exhausted"),
        DeliveryResult("retryable_failure", "provider_throttled"),
        DeliveryResult("retryable_failure", "provider_connection_failed"),
    ],
)
def test_unknown_or_global_failure_preserves_unclaimed_rows(runner, result):
    database = WorkerDatabase(runner.settings, row_count=3)
    runner.factory.return_value = database
    runner.send.return_value = result
    response = runner.run()
    assert response["processed"] == 1 and response["has_more"] is True
    assert len(database.claims) == 2
    runner.send.assert_called_once()


def test_provider_exception_is_unknown_and_does_not_leak_exception(runner):
    runner.send.side_effect = RuntimeError("private-provider-text")
    result = runner.run()
    assert_counts(result, processed=1, unknown=1)
    assert runner.database.settled[0]["p_outcome"] == "unknown"
    assert "private-provider-text" not in str(result)


@pytest.mark.parametrize(
    "settlement",
    [
        RuntimeError("private-settlement-text"),
        {"updated": False, "state": "sending"},
        {"updated": False, "state": "unknown"},
    ],
)
def test_failed_or_expired_claim_settlement_never_resends(runner, settlement):
    database = WorkerDatabase(runner.settings, row_count=3)
    database.handlers["settle_missed_class_automation_v1"] = settlement
    runner.factory.return_value = database
    assert_counts(runner.run(), processed=1, unknown=1, accepted=0, has_more=True)
    runner.send.assert_called_once()
    assert len(database.claims) == 2
    runner.closer.assert_called_once_with(database)


def test_lost_begin_response_stops_without_submission_or_second_begin(runner):
    runner.database.handlers["begin_missed_class_automation_v1"] = RuntimeError("lost response")
    assert_counts(runner.run(), processed=1, unknown=1)
    runner.send.assert_not_called()
    assert len([name for name, _ in runner.database.calls if name.startswith("begin_")]) == 1


def test_expired_sending_lease_recovered_by_claim_is_not_retried(runner):
    runner.database.handlers["claim_missed_class_automations_v1"] = {"items": [], "has_more": False}
    assert_counts(runner.run(), processed=0, unknown=0)
    runner.send.assert_not_called()


def test_retry_exhaustion_reports_actual_sql_failed_state(runner):
    runner.send.return_value = DeliveryResult("retryable_failure", "provider_throttled")
    runner.database.handlers["settle_missed_class_automation_v1"] = {
        "updated": True,
        "state": "failed",
    }
    assert_counts(runner.run(), processed=1, failed=1, retry_wait=0)


def test_future_retry_is_not_has_more(runner):
    runner.send.return_value = DeliveryResult("retryable_failure", "provider_throttled")
    assert_counts(runner.run(), processed=1, retry_wait=1, has_more=False)


def test_expired_before_admission_creates_no_client(runner):
    assert_counts(runner.run(deadline_monotonic=99.0), processed=0)
    runner.factory.assert_not_called()


def test_initial_credential_fetch_consumes_work_budget(runner):
    def delay(name, _params):
        if name == "get_automation_email_credential_v1":
            runner.clock.now += 16

    runner.database.on_execute = delay
    assert_counts(runner.run(), processed=0, enqueued=0)
    assert [name for name, _ in runner.database.executed] == ["get_automation_email_credential_v1"]
    runner.send.assert_not_called()
    runner.closer.assert_called_once()


def test_enqueue_budget_exit_reports_newly_queued_work(runner):
    runner.database.enqueued = 1

    def delay(name, _params):
        if name.startswith("enqueue_"):
            runner.clock.now += 16

    runner.database.on_execute = delay
    assert_counts(runner.run(limit=1), processed=0, enqueued=1, has_more=True)
    assert not runner.database.begun


def test_claimed_but_budget_exhausted_is_not_processed(runner):
    def delay(name, _params):
        if name.startswith("claim_"):
            runner.clock.now += 16

    runner.database.on_execute = delay
    assert_counts(runner.run(), processed=0)
    assert not runner.database.begun
    runner.send.assert_not_called()


def test_every_query_execute_is_budget_checked_inside_entitlement(runner):
    def access(client, _studio, **_kwargs):
        client.table("studio_subscriptions").select("*").execute()
        runner.clock.now += 16
        client.table("studio_subscriptions").select("*").execute()
        raise AssertionError("Second execute cannot start")

    runner.access.side_effect = access
    assert_counts(runner.run(), processed=0)
    assert len(runner.database.query_log) == 1
    runner.send.assert_not_called()


@pytest.mark.parametrize("elapsed", [21, 26])
def test_late_begin_never_starts_provider_and_leaves_unknown_for_lease_recovery(runner, elapsed):
    def delay(name, _params):
        if name.startswith("begin_"):
            runner.clock.now += elapsed

    runner.database.on_execute = delay
    assert_counts(runner.run(), processed=1, unknown=1)
    runner.send.assert_not_called()
    assert not runner.database.settled


def test_provider_deadline_reserves_time_for_settlement(runner):
    def send(message, *, deadline):
        assert deadline == 120.0
        runner.clock.now = deadline - 0.1
        return DeliveryResult("accepted")

    runner.send.side_effect = send
    assert_counts(runner.run(), processed=1, accepted=1)
    assert len(runner.database.settled) == 1
    assert runner.clock.now < 125.0


def test_inflight_completion_after_budget_is_unknown_no_later_attempt(runner):
    database = WorkerDatabase(runner.settings, row_count=3)
    runner.factory.return_value = database

    def send(_message, *, deadline):
        assert runner.clock.now < deadline
        runner.clock.now += 26
        return DeliveryResult("accepted")

    runner.send.side_effect = send
    assert_counts(runner.run(), processed=1, unknown=1)
    runner.send.assert_called_once()
    assert len(database.claims) == 2 and not database.settled


def test_runtime_database_error_is_safe_and_cleanup_always_runs(runner):
    runner.database.handlers["enqueue_missed_class_automations_v1"] = RuntimeError(
        "private db text"
    )
    with pytest.raises(HTTPException) as caught:
        runner.run()
    assert caught.value.status_code == 503 and "private" not in caught.value.detail
    runner.closer.assert_called_once_with(runner.database)
    runner.send.assert_not_called()


def test_cleanup_failure_does_not_erase_accepted_or_resend(runner):
    runner.closer.side_effect = RuntimeError("private cleanup text")
    assert_counts(runner.run(), processed=1, accepted=1)
    runner.send.assert_called_once()


def actual_graph_transport(runner, monkeypatch, handler, *, expired=False):
    import httpx

    from app.services import microsoft_graph_email as graph

    monkeypatch.setattr(graph, "time", SimpleNamespace(monotonic=runner.clock, time=lambda: 1000.0))
    codec = CredentialCodec(
        runner.settings.EMAIL_TOKEN_ENCRYPTION_KEY,
        runner.settings.EMAIL_GRAPH_CLIENT_ID,
        runner.settings.EMAIL_FROM_ADDRESS,
    )
    runner.database.ciphertext = codec.encrypt(credential_state(expires_at=0 if expired else 10000))
    requests = []

    def record(request):
        requests.append(request)
        return handler(request)

    def transport(settings, client):
        return graph.MicrosoftGraphEmailTransport(
            settings,
            client,
            client_factory=lambda **kwargs: httpx.Client(
                transport=httpx.MockTransport(record), **kwargs
            ),
        )

    runner.transport_factory.side_effect = transport
    return requests


def test_actual_graph_202_is_settled_as_accepted_with_no_network(runner, monkeypatch):
    import httpx

    delivery_id = "28030c98-0334-4e56-b8e5-e493b5e8ea62"
    claim_token = "58d62b30-e8f8-4fbb-8449-5d34922484a8"
    runner.database.claims = [
        {"id": delivery_id, "claim_token": claim_token, "studio_id": "studio"}
    ]
    runner.database.messages = {delivery_id: snapshot(delivery_id)}
    requests = actual_graph_transport(runner, monkeypatch, lambda _request: httpx.Response(202))
    assert_counts(runner.run(), processed=1, accepted=1)
    assert len(requests) == 1 and requests[0].url.path == "/v1.0/me/sendMail"
    assert UUID(requests[0].headers["client-request-id"]).version == 5
    assert "idempotency-key" not in requests[0].headers
    assert runner.database.messages[delivery_id]["attempt_id"] == delivery_id + ":1"
    assert runner.database.begun[0]["p_delivery_id"] == delivery_id
    assert runner.database.settled[0]["p_delivery_id"] == delivery_id
    assert runner.database.settled[0]["p_claim_token"] == claim_token
    assert runner.database.settled[0]["p_outcome"] == "accepted"


def test_graph_correlation_mapping_is_stable_and_distinguishes_attempts(runner):
    from app.services.automation_email import delivery_configuration

    delivery_id = "28030c98-0334-4e56-b8e5-e493b5e8ea62"
    first_snapshot = snapshot(delivery_id)
    next_snapshot = snapshot(delivery_id, attempt_id=delivery_id + ":2")
    config = delivery_configuration(runner.settings)
    first = service._message(first_snapshot, config).attempt_id
    repeated = service._message(first_snapshot, config).attempt_id
    next_attempt = service._message(next_snapshot, config).attempt_id
    assert str(UUID(first)) == first and UUID(first).version == 5
    assert repeated == first
    assert next_attempt != first and UUID(next_attempt).version == 5
    assert first_snapshot["attempt_id"] == delivery_id + ":1"
    assert next_snapshot["attempt_id"] == delivery_id + ":2"


def test_local_render_failure_does_not_claim_provider_rejection(runner):
    runner.database.messages["delivery-1"]["student_first_name"] = "x" * 200
    assert_counts(runner.run(), processed=1, failed=1)
    runner.send.assert_not_called()
    assert runner.database.settled[0]["p_outcome"] == "permanent_failure"
    assert runner.database.settled[0]["p_error_code"] == "unavailable"


@pytest.mark.parametrize("phase", ["credential_load", "refresh", "credential_cas"])
def test_actual_transport_counts_credential_refresh_and_cas_time_in_budget(
    runner, monkeypatch, phase
):
    import httpx

    def response(_request):
        if phase == "refresh":
            runner.clock.now += 21
        return httpx.Response(
            200,
            json={
                "access_token": "synthetic-new-access",
                "refresh_token": "synthetic-new-refresh",
                "expires_in": 3600,
                "token_type": "Bearer",
            },
        )

    requests = actual_graph_transport(runner, monkeypatch, response, expired=True)

    def save(params):
        runner.database.ciphertext = params["p_encrypted_credentials"]
        return {
            "provider_key": PROVIDER_KEY,
            "revision": 2,
            "encrypted_credentials": runner.database.ciphertext,
        }

    runner.database.handlers["save_automation_email_credential_v1"] = save
    loads = 0

    def delay(name, _params):
        nonlocal loads
        if name == "get_automation_email_credential_v1":
            loads += 1
            if loads == 2 and phase == "credential_load":
                runner.clock.now += 21
        if name == "save_automation_email_credential_v1" and phase == "credential_cas":
            runner.clock.now += 21

    runner.database.on_execute = delay
    assert_counts(runner.run(), processed=1, unknown=1)
    assert not any(request.url.path == "/v1.0/me/sendMail" for request in requests)
    assert not runner.database.settled
    runner.closer.assert_called_once_with(runner.database)
