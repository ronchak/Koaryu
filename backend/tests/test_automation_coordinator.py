"""Coordinator proof uses the installed SDK with synthetic HTTP and mail only."""

import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from test_automation_batch import engine_summary
from test_automation_email import email_settings
from test_automation_rpc_compatibility import MockPostgrestClient
from test_automation_service import Clock, prepared_sender
from test_workflow_capabilities import V38
from test_workflow_dispatcher import ADVANCE, CLAIM_RPC, WorkflowDatabase, position

from app.schemas.automation import MissedClassProcessResponse
from app.schemas.workflow_dispatch import WorkflowProcessResponse
from app.services import automation_coordinator as coordinator
from app.services import automation_service, workflow_dispatcher
from app.services.automation_coordinator import AutomationBatchUnavailable
from app.services.automation_email import DeliveryResult
from app.services.generated_release_readiness import RELEASE_PREFLIGHT_RPC

SCAN = "process_automation_workflow_occurrences_v1"
OCCURRENCES = {"created_event_count": 25, "enqueued_run_count": 25, "has_more": False}


class BatchFixture:
    def __init__(self, monkeypatch):
        self.settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
        self.clock = Clock()
        self.database = WorkflowDatabase(self.settings)
        self.responses = {}
        self.requests = []
        self.clients = []
        self.closes = []
        self.engine_calls = []
        self.after_request = None
        self.transport = SimpleNamespace(
            prepare=Mock(return_value=prepared_sender(self.settings)),
            send_prepared=Mock(return_value=DeliveryResult("accepted")),
        )
        for module in (automation_service, workflow_dispatcher):
            monkeypatch.setattr(
                module,
                "get_platform_subscription_access",
                lambda *a, **k: {"subscription_required": False},
            )

    def handle(self, request):
        name = request.url.path.rsplit("/", 1)[-1]
        params = json.loads(request.content)
        self.requests.append((name, params, request))
        if name in self.responses:
            response = self.responses[name]
            if isinstance(response, Exception):
                raise response
        else:
            data = (
                {"payload": OCCURRENCES}
                if name == SCAN
                else self.database.rpc(name, params).execute().data
            )
            response = httpx.Response(200, json=data)
        if self.after_request:
            self.after_request(name)
        return response

    def create_client(self, *, postgrest_client_timeout):
        assert postgrest_client_timeout == 5.0
        client = MockPostgrestClient(self.handle, postgrest_client_timeout)
        self.clients.append((client, threading.get_ident()))
        return client

    def close_client(self, client):
        self.closes.append((client, threading.get_ident()))
        client.aclose()

    def processor(self, engine, *, result=None, elapsed=0):
        def process(settings, **kwargs):
            assert settings is self.settings
            raw = kwargs["client_factory"](postgrest_client_timeout=5.0)
            kwargs["client_closer"](raw)
            assert raw is self.clients[0][0] and not raw.session.is_closed
            self.engine_calls.append((engine, kwargs))
            self.clock.now += elapsed
            return engine_summary(engine) if result is None else result

        return process

    def run(self, **kwargs):
        return coordinator.process_automation_batch(
            self.settings,
            **{
                "first_engine": "attendance",
                "deadline_monotonic": 125.0,
                "limit": 1,
                "clock": self.clock,
                "client_factory": self.create_client,
                "client_closer": self.close_client,
                "transport_factory": lambda *_: self.transport,
                **kwargs,
            },
        )

    def stubbed(self, **kwargs):
        return self.run(
            **{
                "attendance_processor": self.processor("attendance"),
                "workflow_processor": self.processor("workflows"),
                **kwargs,
            }
        )

    def names(self):
        return [name for name, _, _ in self.requests]


@pytest.fixture
def batch(monkeypatch):
    fixture = BatchFixture(monkeypatch)
    yield fixture
    for client, _ in fixture.clients:
        if not client.session.is_closed:
            client.aclose()


@pytest.mark.parametrize("first", ["attendance", "workflows"])
def test_real_processors_share_actual_sdk_client_scan_and_deadline(batch, first):
    result = batch.run(first_engine=first)
    assert result.attendance.accepted == result.workflows.accepted == 1
    assert result.occurrences.created_event_count == 25
    assert result.has_more is (result.attendance.has_more or result.workflows.has_more)
    assert batch.names().count(SCAN) == 1
    assert batch.names()[:3] == [RELEASE_PREFLIGHT_RPC, V38, SCAN]
    assert [p for n, p, _ in batch.requests if n == SCAN] == [{"p_limit": 25}]
    assert len(batch.clients) == 1 and batch.closes == batch.clients
    assert batch.clients[0][0].session.is_closed
    for _, builder in batch.clients[0][0].builders:
        builder.execute.assert_called_once()
    assert len(batch.transport.send_prepared.call_args_list) == 2
    assert all(
        call.kwargs == {"deadline": 120.0} for call in batch.transport.send_prepared.call_args_list
    )
    legacy = batch.names().index("claim_missed_class_automations_v1")
    graph = batch.names().index(CLAIM_RPC)
    assert (legacy < graph) is (first == "attendance")


@pytest.mark.parametrize("changes", [{"EMAIL_SEND_ENABLED": False}, {"EMAIL_PROVIDER": "disabled"}])
def test_mail_pause_skips_legacy_but_real_graph_still_performs_internal_work(batch, changes):
    for key, value in changes.items():
        setattr(batch.settings, key, value)
    batch.database.transition_queue = [
        {"outcome": "stopped", "run": position("completed", node="end")}
    ]
    result = batch.run()
    assert result.attendance is None and result.workflows.completed == 1 and result.has_more
    assert ADVANCE in batch.names() and not any("missed_class" in n for n in batch.names())
    batch.transport.prepare.assert_not_called()
    batch.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        [{"payload": OCCURRENCES}],
        "private",
        {},
        OCCURRENCES,
        {"payload": OCCURRENCES, "extra": 1},
        {"payload": {**OCCURRENCES, "extra": 1}},
        *[
            {"payload": {k: v for k, v in OCCURRENCES.items() if k != field}}
            for field in OCCURRENCES
        ],
        *[
            {"payload": {**OCCURRENCES, field: value}}
            for field in ("created_event_count", "enqueued_run_count")
            for value in (True, 1.0, "1", -1, 101, None)
        ],
        *[{"payload": {**OCCURRENCES, "has_more": value}} for value in (0, 1, "false", None)],
    ],
)
def test_c2_closed_envelope_and_strict_fields_through_installed_sdk(batch, bad):
    batch.responses[SCAN] = httpx.Response(200, json=bad)
    with pytest.raises(AutomationBatchUnavailable) as error:
        batch.stubbed()
    assert str(error.value) == "Automation batch is unavailable."
    assert "private" not in repr(error.value)
    assert batch.names().count(SCAN) == 1 and not batch.engine_calls
    assert batch.closes == batch.clients


@pytest.mark.parametrize("field", ["created_event_count", "enqueued_run_count"])
def test_occurrence_count_above_actual_request_bound_stops_before_engines(batch, field):
    batch.responses[SCAN] = httpx.Response(200, json={"payload": {**OCCURRENCES, field: 26}})
    with pytest.raises(AutomationBatchUnavailable, match="^Automation batch is unavailable\\.$"):
        batch.stubbed()
    assert not batch.engine_calls
    batch.transport.prepare.assert_not_called()
    batch.transport.send_prepared.assert_not_called()
    assert [p for n, p, _ in batch.requests if n == SCAN] == [{"p_limit": 25}]
    assert len(batch.clients) == 1 and batch.closes == batch.clients
    assert batch.clients[0][0].session.is_closed


@pytest.mark.parametrize("path,validations", [("complete", 3), ("no_engines", 1), ("flagged", 1)])
def test_nested_summary_validation_uses_the_actual_scan_bound(
    batch, monkeypatch, path, validations
):
    contexts = []
    validate = coordinator.AutomationBatchResponse.model_validate

    def checked(data, *, context):
        contexts.append(context)
        return validate(data, context=context)

    monkeypatch.setattr(coordinator.AutomationBatchResponse, "model_validate", checked)
    kwargs = {}
    if path == "no_engines":
        batch.after_request = lambda name: (
            setattr(batch.clock, "now", 115.0) if name == SCAN else None
        )
    elif path == "flagged":
        kwargs["attendance_processor"] = batch.processor(
            "attendance", result=engine_summary("attendance", enqueued=1, processed=1, failed=1)
        )
    result = batch.stubbed(**kwargs)
    assert contexts == [{"limit": 1, "p_limit": 25}] * validations
    assert result.occurrences.created_event_count == result.occurrences.enqueued_run_count == 25


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"code": "22023", "message": "AUTOMATION_INVALID_REQUEST"}),
        httpx.Response(409, json={"code": "P0001", "message": "AUTOMATION_STUDIO_BUSY"}),
        httpx.Response(404, json={"code": "PGRST202", "message": "private missing RPC"}),
        httpx.Response(500, json={"code": [], "message": {"private": "value"}}),
        httpx.Response(200, content=b"{malformed"),
        httpx.Response(204),
        httpx.ReadError("private response loss"),
    ],
)
def test_uncertain_scan_never_retries_or_becomes_zero_success(batch, response):
    batch.responses[SCAN] = response
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed()
    assert batch.names().count(SCAN) == 1 and not batch.engine_calls
    assert batch.closes == batch.clients


@pytest.mark.parametrize("rpc", [RELEASE_PREFLIGHT_RPC, V38])
@pytest.mark.parametrize("data", [{}, {"ready": True}, {"ready": False}, None])
def test_actual_guard_precedes_every_mutation_and_fails_closed(batch, rpc, data):
    batch.responses[rpc] = httpx.Response(200, json=data)
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed()
    assert SCAN not in batch.names() and not batch.engine_calls
    assert batch.closes == batch.clients


@pytest.mark.parametrize("rpc", [RELEASE_PREFLIGHT_RPC, V38, SCAN])
@pytest.mark.parametrize("origin", ["https://synthetic.invalid", "https://other.invalid"])
def test_guard_and_scan_never_follow_redirects_or_forward_key(batch, rpc, origin):
    batch.responses[rpc] = httpx.Response(307, headers={"Location": origin + "/redirected"})
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed()
    assert batch.names().count(rpc) == 1 and "redirected" not in batch.names()
    assert all(req.url.host == "synthetic.invalid" for _, _, req in batch.requests)
    assert batch.clients[0][0].session.follow_redirects is False


@pytest.mark.parametrize("phase", [RELEASE_PREFLIGHT_RPC, V38, SCAN])
def test_guard_and_scan_consume_original_admission_deadline(batch, phase):
    def elapsed(name):
        if name == phase:
            batch.clock.now = 115.0

    batch.after_request = elapsed
    if phase == SCAN:
        result = batch.stubbed()
        assert result.attendance is result.workflows is None and result.has_more
    else:
        with pytest.raises(AutomationBatchUnavailable):
            batch.stubbed()
        assert SCAN not in batch.names()
    assert not batch.engine_calls and batch.closes == batch.clients


def test_first_engine_can_consume_entire_remaining_budget_without_reset(batch):
    result = batch.stubbed(attendance_processor=batch.processor("attendance", elapsed=15))
    assert result.attendance is not None and result.workflows is None and result.has_more
    assert [name for name, _ in batch.engine_calls] == ["attendance"]


@pytest.mark.parametrize("deadline,expected", [(120, 120), (999, 125)])
def test_both_processors_receive_same_capped_deadline_clock_and_raw_client(
    batch, deadline, expected
):
    batch.stubbed(deadline_monotonic=deadline)
    assert [k["deadline_monotonic"] for _, k in batch.engine_calls] == [expected, expected]
    assert all(k["clock"] is batch.clock and k["limit"] == 1 for _, k in batch.engine_calls)
    assert batch.closes == batch.clients


@pytest.mark.parametrize("first", ["attendance", "workflows"])
@pytest.mark.parametrize("outcome", ["retry_wait", "failed", "unknown"])
def test_confirmed_flagged_summary_stops_other_engine(batch, first, outcome):
    counts = engine_summary(first, processed=1, **{outcome: 1})
    counts["claimed" if first == "workflows" else "enqueued"] = 1
    kwargs = {
        "first_engine": first,
        ("workflow_processor" if first == "workflows" else "attendance_processor"): batch.processor(
            first, result=counts
        ),
    }
    result = batch.stubbed(**kwargs)
    assert getattr(result, first).processed == 1 and result.has_more
    assert getattr(result, "attendance" if first == "workflows" else "workflows") is None
    assert len(batch.engine_calls) == 1


@pytest.mark.parametrize(
    "result",
    [
        None,
        {},
        MissedClassProcessResponse(),
        WorkflowProcessResponse(),
        {"processed": 0},
        {**engine_summary("attendance"), "private": "payload"},
    ],
)
def test_invoked_unconfirmed_processor_cannot_be_null_or_zero_success(batch, result):
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed(attendance_processor=lambda *a, **k: result)
    assert not batch.engine_calls and batch.closes == batch.clients


def test_lost_processor_result_stops_sibling_and_sanitizes_exception(batch):
    def lost(*args, **kwargs):
        raise RuntimeError("private recipient and token")

    with pytest.raises(AutomationBatchUnavailable) as error:
        batch.stubbed(attendance_processor=lost)
    assert "private" not in str(error.value) and not batch.engine_calls
    assert batch.closes == batch.clients


@pytest.mark.parametrize(
    "kwargs",
    [{"limit": value} for value in (True, 0, 11, 1.0, "1")]
    + [
        {"deadline_monotonic": value}
        for value in (True, None, float("nan"), float("inf"), "125", 110)
    ]
    + [{"first_engine": value} for value in (None, [], "other")],
)
def test_invalid_or_unadmittable_input_creates_no_client(batch, kwargs):
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed(**kwargs)
    assert not batch.clients and not batch.requests


@pytest.mark.parametrize("clock", [lambda: True, lambda: float("nan"), lambda: "100"])
def test_invalid_clock_creates_no_client(batch, clock):
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed(clock=clock)
    assert not batch.clients


@pytest.mark.parametrize("flag", [False, None, 1, "true"])
def test_worker_disabled_is_unavailable_without_client(batch, flag):
    batch.settings.AUTOMATION_WORKER_ENABLED = flag
    with pytest.raises(AutomationBatchUnavailable):
        batch.stubbed()
    assert not batch.clients


def test_cleanup_failure_preserves_summary_without_claiming_client_closed(batch, caplog):
    def failed_close(client):
        batch.closes.append((client, threading.get_ident()))
        raise RuntimeError("private cleanup diagnostics")

    result = batch.stubbed(client_closer=failed_close)
    assert result.occurrences.created_event_count == 25 and result.has_more is False
    assert batch.closes == batch.clients and not batch.clients[0][0].session.is_closed
    assert [r.message for r in caplog.records] == ["automation_batch_cleanup_failed"]
    assert "private" not in caplog.text


def test_real_first_engine_spends_shared_budget_before_graph_can_claim(batch):
    batch.after_request = lambda name: (
        setattr(batch.clock, "now", 115.0) if name == "settle_missed_class_automation_v2" else None
    )
    result = batch.run()
    assert result.attendance.accepted == 1 and result.workflows is None and result.has_more
    assert CLAIM_RPC not in batch.names() and batch.closes == batch.clients
