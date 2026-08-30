from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "rehearse-payer-sync-ambiguity.py"
SPEC = importlib.util.spec_from_file_location("payer_sync_ambiguity_operator", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SHA = "a" * 40
STUDIO_ID = "00000000-0000-4000-8000-000000000001"
ACTOR_ID = "00000000-0000-4000-8000-000000000002"
PAYER_ID = "00000000-0000-4000-8000-000000000003"
CALLER_KEY = "schema-v4-payer-sync-test-key"


def _environment() -> dict[str, str]:
    return {
        "RENDER_GIT_COMMIT": SHA,
        "ENVIRONMENT": "staging",
        "STRIPE_MODE": "test",
        "LIVE_BILLING_ENABLED": "false",
        "SUPABASE_URL": MODULE.EXPECTED_STAGING_SUPABASE_URL,
        "KOARYU_REHEARSAL_EXECUTE": MODULE.EXECUTION_LATCH,
        "KOARYU_REHEARSAL_STUDIO_ID": STUDIO_ID,
        "KOARYU_REHEARSAL_ACTOR_ID": ACTOR_ID,
        "KOARYU_REHEARSAL_PAYER_ID": PAYER_ID,
        "KOARYU_REHEARSAL_TEST_CLOCK_ID": "clock_Test123",
        "KOARYU_REHEARSAL_PAYER_SYNC_KEY": CALLER_KEY,
    }


def _armed_state() -> dict:
    return {
        "schema_version": MODULE.STATE_SCHEMA_VERSION,
        "phase": "armed",
        "candidate_sha": SHA,
        "studio_id": STUDIO_ID,
        "actor_id": ACTOR_ID,
        "payer_id": PAYER_ID,
        "test_clock_id": "clock_Test123",
        "caller_key_sha256": hashlib.sha256(CALLER_KEY.encode()).hexdigest(),
        "provider_mutation_count": 0,
        "provider_readback_count": 0,
        "automatic_retry_count": 0,
    }


def test_execution_context_accepts_only_exact_staging_candidate():
    environment = _environment()
    MODULE.validate_execution_context(
        expected_sha=SHA,
        current_sha=SHA,
        environment=environment,
    )

    variants = (
        {"RENDER_GIT_COMMIT": "b" * 40},
        {"ENVIRONMENT": "production"},
        {"STRIPE_MODE": "live"},
        {"LIVE_BILLING_ENABLED": "true"},
        {"SUPABASE_URL": "https://mimguepumzsgmcaycdsh.supabase.co"},
        {"KOARYU_REHEARSAL_EXECUTE": ""},
    )
    for change in variants:
        with pytest.raises(MODULE.OperatorError):
            MODULE.validate_execution_context(
                expected_sha=SHA,
                current_sha=SHA,
                environment={**environment, **change},
            )
    with pytest.raises(MODULE.OperatorError):
        MODULE.validate_execution_context(
            expected_sha=SHA,
            current_sha="b" * 40,
            environment=environment,
        )


def test_repository_gate_requires_clean_tracked_operator_at_head(tmp_path):
    repository = tmp_path / "repo"
    operator = repository / "scripts" / "rehearse-payer-sync-ambiguity.py"
    operator.parent.mkdir(parents=True)
    original = b"print('tracked operator')\n"
    operator.write_bytes(original)
    subprocess.run(["git", "init", "-q", str(repository)], check=True)
    subprocess.run(
        ["git", "config", "user.email", "operator-test@example.com"],
        cwd=repository,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Operator Test"],
        cwd=repository,
        check=True,
    )
    subprocess.run(["git", "add", "scripts/rehearse-payer-sync-ambiguity.py"], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "track operator"], cwd=repository, check=True)
    MODULE.validate_repository_state(repository)

    operator.write_text("print('modified')\n", encoding="utf-8")
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository)

    operator.write_bytes(original)
    operator.unlink()
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository)


def test_private_state_is_mode_600_exact_and_never_blindly_overwritten():
    path = Path(f"/private/tmp/koaryu-payer-ambiguity-test-{uuid4()}.json")
    try:
        state = _armed_state()
        MODULE.write_private_state(
            path, state, integrity_key=CALLER_KEY, require_absent=True
        )
        assert (path.stat().st_mode & 0o777) == 0o600
        assert MODULE.read_private_state(path, integrity_key=CALLER_KEY) == state
        with pytest.raises(MODULE.OperatorError):
            MODULE.write_private_state(
                path, state, integrity_key=CALLER_KEY, require_absent=True
            )
        provider_created = {
            **state,
            "phase": "provider_created",
            "provider_customer_id": "cus_Test123",
            "provider_mutation_count": 1,
        }
        MODULE.write_private_state(
            path, provider_created, integrity_key=CALLER_KEY
        )
        assert MODULE.read_private_state(
            path, integrity_key=CALLER_KEY
        )["phase"] == "provider_created"
        with pytest.raises(MODULE.OperatorError, match="integrity"):
            MODULE.read_private_state(path, integrity_key="wrong-key")
    finally:
        path.unlink(missing_ok=True)


def test_private_state_rejects_wrong_path_and_permissions():
    with pytest.raises(MODULE.OperatorError):
        MODULE.write_private_state(
            Path("/private/tmp/wrong-prefix.json"),
            _armed_state(),
            integrity_key=CALLER_KEY,
        )

    path = Path(f"/private/tmp/koaryu-payer-ambiguity-test-{uuid4()}.json")
    try:
        MODULE.write_private_state(
            path, _armed_state(), integrity_key=CALLER_KEY
        )
        os.chmod(path, 0o644)
        with pytest.raises(MODULE.OperatorError):
            MODULE.read_private_state(path, integrity_key=CALLER_KEY)
    finally:
        path.unlink(missing_ok=True)


def test_private_state_rejects_tampering_and_phase_field_drift():
    path = Path(f"/private/tmp/koaryu-payer-ambiguity-test-{uuid4()}.json")
    try:
        MODULE.write_private_state(
            path, _armed_state(), integrity_key=CALLER_KEY
        )
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["provider_mutation_count"] = 1
        path.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(path, 0o600)
        with pytest.raises(MODULE.OperatorError, match="integrity"):
            MODULE.read_private_state(path, integrity_key=CALLER_KEY)
        with pytest.raises(MODULE.OperatorError, match="phase fields"):
            MODULE.validate_state_phase({**_armed_state(), "unexpected": True})
    finally:
        path.unlink(missing_ok=True)


def test_faulting_stripe_service_records_one_success_then_refuses_second_attempt():
    calls: list[dict] = []
    persisted: list[dict] = []
    state = {"phase": "armed"}

    class FakeStripe:
        def create_connected_customer(self, **kwargs):
            calls.append(kwargs)
            return {"id": "cus_Test123"}

    faulting = MODULE.build_faulting_stripe_service(
        FakeStripe,
        state=state,
        persist=lambda value: persisted.append(dict(value)),
    )
    service = faulting()
    with pytest.raises(MODULE.DeliberateProviderResponseLoss):
        service.create_connected_customer(account_id="acct_Test123")
    assert len(calls) == 1
    assert state == {
        "phase": "provider_created",
        "provider_customer_id": "cus_Test123",
        "provider_mutation_count": 1,
        "automatic_retry_count": 0,
    }
    assert persisted == [state]

    with pytest.raises(MODULE.OperatorError, match="second customer-create"):
        service.create_connected_customer(account_id="acct_Test123")
    assert len(calls) == 1


def test_faulting_stripe_service_stops_on_invalid_returned_identity():
    class FakeStripe:
        def create_connected_customer(self, **_kwargs):
            return {"id": "not-a-customer"}

    faulting = MODULE.build_faulting_stripe_service(
        FakeStripe,
        state={"phase": "armed"},
        persist=lambda _value: None,
    )
    with pytest.raises(MODULE.OperatorError, match="invalid identity"):
        faulting().create_connected_customer()


def test_route_authorization_requires_exact_active_admin_and_core_access():
    calls: list[dict] = []

    def allowed(_client, actor_id, studio_id, **kwargs):
        calls.append({"actor_id": actor_id, "studio_id": studio_id, **kwargs})
        return {"studio_id": STUDIO_ID, "role": "admin"}

    assert MODULE.require_route_authorization(
        allowed, object(), actor_id=ACTOR_ID, studio_id=STUDIO_ID
    ) == {"studio_id": STUDIO_ID, "role": "admin"}
    assert calls == [{
        "actor_id": ACTOR_ID,
        "studio_id": STUDIO_ID,
        "require_platform_subscription": True,
    }]

    denied_resolvers = (
        lambda *_args, **_kwargs: {"studio_id": STUDIO_ID, "role": "front_desk"},
        lambda *_args, **_kwargs: {"studio_id": ACTOR_ID, "role": "admin"},
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("nonmember")),
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("archived")),
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("subscription required")),
    )
    for resolver in denied_resolvers:
        with pytest.raises(MODULE.OperatorError, match="authorization"):
            MODULE.require_route_authorization(
                resolver, object(), actor_id=ACTOR_ID, studio_id=STUDIO_ID
            )


def test_capturing_coordinator_preserves_claim_and_latest_transition():
    claim = {"operation": {"id": "operation_1"}}

    class FakeCoordinator:
        def claim_resource(self, **_kwargs):
            return claim

        def transition(self, _context, _operation, to_state, **_kwargs):
            return {"id": "operation_1", "state": to_state}

    capturing = MODULE.build_capturing_coordinator(FakeCoordinator)
    instance = capturing()
    assert instance.claim_resource() == claim
    assert capturing.claimed == claim
    assert instance.transition(None, None, "reconciliation_required") == {
        "id": "operation_1",
        "state": "reconciliation_required",
    }
    assert capturing.latest_operation["state"] == "reconciliation_required"


def _recoverable_operation(*, state="reconciliation_required") -> dict:
    return {
        "id": "operation_1",
        "studio_id": STUDIO_ID,
        "state": state,
        "operation_type": "payer.sync",
        "result_code": "payer_sync_create_started",
        "result_summary": "sync_mode:create:target_customer_id:none",
        "provider_request_attempt_count": 1,
        "provider_object_id": None,
    }


def _resource() -> dict:
    return {
        "id": "resource_1",
        "operation_id": "operation_1",
        "studio_id": STUDIO_ID,
        "operation_type": "payer.sync",
        "resource_type": "payer",
        "resource_id": PAYER_ID,
        "payer_id": PAYER_ID,
    }


def _provider_created_state(*, phase="provider_created") -> dict:
    return {
        "phase": phase,
        "provider_customer_id": "cus_Test123",
        "provider_mutation_count": 1,
        "provider_readback_count": 0,
        "automatic_retry_count": 0,
    }


def test_recovery_action_models_each_crash_boundary_without_extra_read_or_replay():
    assert MODULE.classify_recovery_action(
        state=_provider_created_state(),
        operation=_recoverable_operation(),
        resource=_resource(),
        payer_id=PAYER_ID,
    ) == "retrieve_then_authorize"

    verified = {
        **_provider_created_state(phase="provider_verified"),
        "provider_readback_count": 1,
        "recovery_proof_sha256": "a" * 64,
    }
    assert MODULE.classify_recovery_action(
        state=verified,
        operation=_recoverable_operation(),
        resource=_resource(),
        payer_id=PAYER_ID,
    ) == "authorize_without_readback"

    committed = {
        **_recoverable_operation(state="recovery_authorized"),
        "provider_object_id": "cus_Test123",
        "recovery_outcome": "provider_succeeded_reconcile_only",
        "recovery_proof_sha256": "a" * 64,
    }
    assert MODULE.classify_recovery_action(
        state=verified,
        operation=committed,
        resource=_resource(),
        payer_id=PAYER_ID,
    ) == "persist_authorized"


def test_recovery_action_rejects_wrong_resource_attempts_counts_and_phase():
    state = _provider_created_state()
    operation = _recoverable_operation()
    invalid_cases = (
        ({**state, "provider_mutation_count": 2}, operation, _resource()),
        ({**state, "automatic_retry_count": 1}, operation, _resource()),
        (state, {**operation, "provider_request_attempt_count": 2}, _resource()),
        (state, operation, {**_resource(), "resource_id": ACTOR_ID}),
        (state, operation, {**_resource(), "operation_id": "operation_2"}),
        (state, operation, {**_resource(), "studio_id": ACTOR_ID}),
        (state, operation, {**_resource(), "operation_type": "plan.sync"}),
        (state, operation, {**_resource(), "payer_id": ACTOR_ID}),
        ({**state, "phase": "armed"}, operation, _resource()),
    )
    for invalid_state, invalid_operation, invalid_resource in invalid_cases:
        with pytest.raises(MODULE.OperatorError):
            MODULE.classify_recovery_action(
                state=invalid_state,
                operation=invalid_operation,
                resource=invalid_resource,
                payer_id=PAYER_ID,
            )


def test_recovery_authorized_requires_exact_customer_outcome_and_proof():
    state = {
        **_provider_created_state(phase="provider_verified"),
        "provider_readback_count": 1,
        "recovery_proof_sha256": "a" * 64,
    }
    operation = {
        **_recoverable_operation(state="recovery_authorized"),
        "provider_object_id": "cus_Test123",
        "recovery_outcome": "provider_succeeded_reconcile_only",
        "recovery_proof_sha256": "a" * 64,
    }
    for change in (
        {"provider_object_id": "cus_Other"},
        {"recovery_outcome": "provider_no_object_safe_to_retry"},
        {"recovery_proof_sha256": "b" * 64},
        {"recovery_proof_sha256": "bad"},
    ):
        with pytest.raises(MODULE.OperatorError, match="committed recovery"):
            MODULE.classify_recovery_action(
                state=state,
                operation={**operation, **change},
                resource=_resource(),
                payer_id=PAYER_ID,
            )
    with pytest.raises(MODULE.OperatorError, match="committed recovery"):
        MODULE.classify_recovery_action(
            state=_provider_created_state(),
            operation=operation,
            resource=_resource(),
            payer_id=PAYER_ID,
        )


def test_provider_verified_phase_is_durable_before_authorization_and_resume_does_not_read():
    state = _provider_created_state()
    calls = {"retrieve": 0, "verify": 0, "proof": 0}
    persisted: list[dict] = []

    def retrieve():
        calls["retrieve"] += 1
        return {"id": "cus_Test123"}

    def verify(_customer):
        calls["verify"] += 1

    def proof(_customer):
        calls["proof"] += 1
        return {"normalized": True}, "a" * 64

    assert MODULE.verify_provider_once_or_resume(
        action="retrieve_then_authorize",
        state=state,
        persist=lambda value: persisted.append(dict(value)),
        retrieve=retrieve,
        verify=verify,
        proof_builder=proof,
    ) == "a" * 64
    assert calls == {"retrieve": 1, "verify": 1, "proof": 1}
    assert persisted[0]["phase"] == "provider_readback_in_flight"
    assert persisted[0]["provider_readback_count"] == 0
    assert persisted[-1]["phase"] == "provider_verified"
    assert persisted[-1]["provider_readback_count"] == 1
    assert persisted[-1]["provider_evidence"] == {"normalized": True}

    assert MODULE.verify_provider_once_or_resume(
        action="authorize_without_readback",
        state=state,
        persist=lambda _value: pytest.fail("resume must not persist before RPC"),
        retrieve=lambda: pytest.fail("resume must not retrieve Stripe again"),
        verify=lambda _customer: pytest.fail("resume must not reverify a new response"),
        proof_builder=lambda _customer: pytest.fail("resume must not rebuild proof"),
    ) == "a" * 64
    assert calls == {"retrieve": 1, "verify": 1, "proof": 1}


def test_crash_after_read_request_stays_in_flight_and_cannot_issue_another_read():
    state = {
        **_provider_created_state(phase="reconciliation_required"),
        "operation_id": "operation_1",
        "resource_claim_id": "resource_1",
        "operation_revision": 3,
        "request_sha256": "b" * 64,
        "stripe_connected_account_id": "acct_Test123",
        "connect_account_generation": 1,
    }
    persisted: list[dict] = []

    def crash_after_request():
        raise RuntimeError("process died after GET dispatch")

    with pytest.raises(RuntimeError, match="GET dispatch"):
        MODULE.verify_provider_once_or_resume(
            action="retrieve_then_authorize",
            state=state,
            persist=lambda value: persisted.append(dict(value)),
            retrieve=crash_after_request,
            verify=lambda _customer: None,
            proof_builder=lambda _customer: ({}, "a" * 64),
        )
    assert persisted == [{**state, "phase": "provider_readback_in_flight"}]
    with pytest.raises(MODULE.OperatorError):
        MODULE.classify_recovery_action(
            state=persisted[-1],
            operation=_recoverable_operation(),
            resource=_resource(),
            payer_id=PAYER_ID,
        )


def test_rpc_committed_crash_resume_persists_without_provider_or_projection_callback():
    state = {
        **_provider_created_state(phase="provider_verified"),
        "provider_readback_count": 1,
        "recovery_proof_sha256": "a" * 64,
    }
    operation = {
        **_recoverable_operation(state="recovery_authorized"),
        "revision": 7,
        "request_sha256": "b" * 64,
        "stripe_connected_account_id": "acct_Test123",
        "connect_account_generation": 1,
        "provider_object_id": "cus_Test123",
        "recovery_outcome": "provider_succeeded_reconcile_only",
        "recovery_proof_sha256": "a" * 64,
    }
    persisted: list[dict] = []
    result = MODULE.persist_committed_authorization(
        state=state,
        operation=operation,
        resource=_resource(),
        persist=lambda value: persisted.append(dict(value)),
    )
    assert result == {
        "phase": "recovery_authorized",
        "provider_mutation_count": 1,
        "provider_readback_count": 1,
        "automatic_retry_count": 0,
        "parent_operation_bound": True,
        "resource_claim_bound": True,
        "hosted_replay_required": True,
    }
    assert persisted[-1]["phase"] == "recovery_authorized"
    assert persisted[-1]["operation_revision"] == 7


def test_unprojected_payer_gate_stops_after_any_customer_binding():
    MODULE.require_unprojected_payer({"stripe_customer_id": None})
    with pytest.raises(MODULE.OperatorError, match="already has"):
        MODULE.require_unprojected_payer({"stripe_customer_id": "cus_Test123"})


def test_state_binding_requires_exact_candidate_resource_clock_and_key():
    environment = _environment()
    state = {
        "schema_version": MODULE.STATE_SCHEMA_VERSION,
        "candidate_sha": SHA,
        "studio_id": STUDIO_ID,
        "actor_id": ACTOR_ID,
        "payer_id": PAYER_ID,
        "test_clock_id": environment["KOARYU_REHEARSAL_TEST_CLOCK_ID"],
        "caller_key_sha256": hashlib.sha256(CALLER_KEY.encode()).hexdigest(),
    }
    MODULE.validate_state_binding(state, environment, SHA)
    for key in (
        "candidate_sha",
        "studio_id",
        "actor_id",
        "payer_id",
        "test_clock_id",
        "caller_key_sha256",
    ):
        with pytest.raises(MODULE.OperatorError):
            MODULE.validate_state_binding({**state, key: "wrong"}, environment, SHA)


@dataclass
class FakeContext:
    operation_id: str
    studio_id: str
    actor_id: str
    operation_type: str
    caller_request_key: str
    request_sha256: str
    stripe_connected_account_id: str
    connect_account_generation: int
    lease_owner: str


def test_context_uses_canonical_claimed_identity():
    operation = {
        "id": "operation_1",
        "studio_id": STUDIO_ID,
        "actor_id": ACTOR_ID,
        "operation_type": "payer.sync",
        "request_sha256": "b" * 64,
        "stripe_connected_account_id": "acct_Test123",
        "connect_account_generation": 1,
        "lease_owner": "00000000-0000-4000-8000-000000000004",
    }
    context = MODULE._context_from_claim(
        FakeContext,
        {"operation": operation, "canonical_caller_request_key": CALLER_KEY},
    )
    assert context.operation_id == "operation_1"
    assert context.caller_request_key == CALLER_KEY
    assert context.connect_account_generation == 1


def test_recovery_proof_is_deterministic_and_changes_with_clock():
    stable_hash = lambda value: hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    operation = {"id": "operation_1"}
    payer = {"id": PAYER_ID}
    customer = {
        "id": "cus_Test123",
        "name": "Schema v4 rehearsal payer",
        "email": "payer@example.com",
        "phone": None,
        "address": {},
        "metadata": {"studio_id": STUDIO_ID, "payer_id": PAYER_ID, "product": "koaryu_payments"},
    }
    first = MODULE._recovery_proof(
        stable_hash,
        operation=operation,
        payer=payer,
        customer=customer,
        test_clock_id="clock_Test123",
    )
    repeated = MODULE._recovery_proof(
        stable_hash,
        operation=operation,
        payer=payer,
        customer=customer,
        test_clock_id="clock_Test123",
    )
    changed = MODULE._recovery_proof(
        stable_hash,
        operation=operation,
        payer=payer,
        customer=customer,
        test_clock_id="clock_Other456",
    )
    assert first == repeated
    assert first != changed
    assert len(first) == 64


def test_normalized_provider_evidence_recomputes_and_binds_exact_operation_resource():
    stable_hash = lambda value: hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    operation = {"id": "operation_1", "studio_id": STUDIO_ID}
    evidence = {
        "evidence_type": "payer_sync_provider_succeeded_reconcile_only",
        "operation_id": "operation_1",
        "payer_id": PAYER_ID,
        "customer_id": "cus_Test123",
        "test_clock_id": "clock_Test123",
        "name": "Schema v4 rehearsal payer",
        "email": "payer@example.com",
        "phone": None,
        "address": {"line1": None, "city": None, "state": None, "postal_code": None},
        "metadata": {"studio_id": STUDIO_ID, "payer_id": PAYER_ID, "product": "koaryu_payments"},
    }
    state = {
        "provider_customer_id": "cus_Test123",
        "provider_evidence": evidence,
        "recovery_proof_sha256": stable_hash(evidence),
    }
    MODULE.validate_provider_evidence_binding(
        state=state,
        operation=operation,
        payer_id=PAYER_ID,
        test_clock_id="clock_Test123",
        stable_hash=stable_hash,
    )
    invalid_states = (
        {**state, "recovery_proof_sha256": "b" * 64},
        {**state, "provider_evidence": {**evidence, "customer_id": "cus_Other"}},
        {**state, "provider_evidence": {**evidence, "unexpected": True}},
        {
            **state,
            "provider_evidence": {
                **evidence,
                "metadata": {**evidence["metadata"], "payer_id": ACTOR_ID},
            },
        },
    )
    for invalid_state in invalid_states:
        with pytest.raises(MODULE.OperatorError):
            MODULE.validate_provider_evidence_binding(
                state=invalid_state,
                operation=operation,
                payer_id=PAYER_ID,
                test_clock_id="clock_Test123",
                stable_hash=stable_hash,
            )
