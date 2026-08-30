from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import builtins
from argparse import Namespace
from concurrent.futures import ThreadPoolExecutor
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
INTEGRITY_KEY = "9f" * 32


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
        "provider_create_response_count": 0,
        "provider_retrieve_count": 0,
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
    billing_payers = repository / "backend/app/services/billing_payers.py"
    stripe_service = repository / "backend/app/services/stripe_service.py"
    billing_payers.parent.mkdir(parents=True)
    billing_payers.write_text("BILLING = True\n", encoding="utf-8")
    stripe_service.write_text("STRIPE = True\n", encoding="utf-8")
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
    subprocess.run(["git", "add", "."], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "track operator"], cwd=repository, check=True)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
    MODULE.validate_repository_state(repository, sha, operator)

    billing_payers.write_text("BILLING = False\n", encoding="utf-8")
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository, sha, operator)
    billing_payers.write_text("BILLING = True\n", encoding="utf-8")

    stripe_service.write_text("STRIPE = False\n", encoding="utf-8")
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository, sha, operator)
    stripe_service.write_text("STRIPE = True\n", encoding="utf-8")

    untracked = repository / "unrelated.tmp"
    untracked.write_text("untracked\n", encoding="utf-8")
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository, sha, operator)
    untracked.unlink()
    MODULE.validate_repository_state(repository, sha, operator)

    operator.write_text("print('modified')\n", encoding="utf-8")
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository, sha, operator)
    operator.write_bytes(original)
    operator.unlink()
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.validate_repository_state(repository, sha, operator)


def test_repository_gate_rejects_a_byte_identical_separate_checkout_copy(tmp_path):
    repository = tmp_path / "repo"
    operator = repository / "scripts" / "rehearse-payer-sync-ambiguity.py"
    operator.parent.mkdir(parents=True)
    operator.write_text("print('operator')\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(repository)], check=True)
    subprocess.run(["git", "config", "user.email", "operator-test@example.com"], cwd=repository, check=True)
    subprocess.run(["git", "config", "user.name", "Operator Test"], cwd=repository, check=True)
    subprocess.run(["git", "add", str(operator.relative_to(repository))], cwd=repository, check=True)
    subprocess.run(["git", "commit", "-qm", "track operator"], cwd=repository, check=True)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
    copy = tmp_path / "copy.py"
    copy.write_bytes(operator.read_bytes())
    with pytest.raises(MODULE.OperatorError, match="executing"):
        MODULE.validate_repository_state(repository, sha, copy)

    linked_repository = tmp_path / "linked-repo"
    linked_repository.symlink_to(repository, target_is_directory=True)
    with pytest.raises(MODULE.OperatorError, match="symlink"):
        MODULE.validate_repository_state(
            linked_repository,
            sha,
            linked_repository / "scripts" / "rehearse-payer-sync-ambiguity.py",
        )


def test_run_refuses_repository_gate_before_backend_import_client_or_arming(tmp_path, monkeypatch):
    state_directory = tmp_path / "private"
    state_directory.mkdir(mode=0o700)
    state_path = state_directory / "koaryu-payer-ambiguity-test.json"
    imported_backend_modules: list[str] = []
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "app" or name.startswith("app.") or name == "fastapi":
            imported_backend_modules.append(name)
            raise AssertionError("backend import occurred after failed repository gate")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setattr(
        MODULE,
        "validate_repository_state",
        lambda *_args: (_ for _ in ()).throw(MODULE.OperatorError("repository must be completely clean")),
    )
    args = Namespace(
        repository=str(tmp_path),
        expected_sha=SHA,
        execute=True,
        mode="inject",
        state_directory=str(state_directory),
        state_file=str(state_path),
    )
    with pytest.raises(MODULE.OperatorError, match="clean"):
        MODULE.run(args, _environment())
    assert imported_backend_modules == []
    assert not state_path.exists()


def test_integrity_key_is_canonical_independent_32_byte_hex():
    MODULE.validate_integrity_key(INTEGRITY_KEY, CALLER_KEY)
    digest = hashlib.sha256(CALLER_KEY.encode()).hexdigest()
    invalid_values = (
        digest,
        digest.upper(),
        digest + digest,
        "00" + digest,
        "ab" * 31,
        "ab" * 33,
        "a" * 63,
        "a" * 65,
        "g" * 64,
        "not-hex",
        CALLER_KEY,
    )
    for invalid in invalid_values:
        with pytest.raises(MODULE.OperatorError):
            MODULE.validate_integrity_key(invalid, CALLER_KEY)


def test_unexpected_failure_redacts_secret_values(monkeypatch, capsys):
    secret = "super-secret-integrity-key"
    monkeypatch.setattr(MODULE, "parse_args", lambda _argv: object())
    monkeypatch.setattr(MODULE, "run", lambda *_args: (_ for _ in ()).throw(RuntimeError(secret)))
    assert MODULE.main(["ignored"]) == 1
    captured = capsys.readouterr()
    assert secret not in captured.err
    assert "RuntimeError" in captured.err

def test_private_state_is_mode_600_exact_and_never_blindly_overwritten(tmp_path):
    path = tmp_path / f"koaryu-payer-ambiguity-test-{uuid4()}.json"
    try:
        state = _armed_state()
        MODULE.write_private_state(
            path,
            state,
            integrity_key=INTEGRITY_KEY,
            require_absent=True,
            state_directory=tmp_path,
        )
        assert (path.stat().st_mode & 0o777) == 0o600
        assert MODULE.read_private_state(
            path, integrity_key=INTEGRITY_KEY, state_directory=tmp_path
        ) == state
        with pytest.raises(MODULE.OperatorError):
            MODULE.write_private_state(
                path,
                state,
                integrity_key=INTEGRITY_KEY,
                require_absent=True,
                state_directory=tmp_path,
            )
        provider_created = {
            **state,
            "phase": "provider_created",
            "provider_customer_id": "cus_Test123",
            "provider_mutation_count": 1,
            "provider_create_response_count": 1,
            "recovery_proof_sha256": "a" * 64,
            "provider_evidence": {"source": "create"},
        }
        MODULE.write_private_state(
            path,
            provider_created,
            integrity_key=INTEGRITY_KEY,
            state_directory=tmp_path,
        )
        assert MODULE.read_private_state(
            path, integrity_key=INTEGRITY_KEY, state_directory=tmp_path
        )["phase"] == "provider_created"
        with pytest.raises(MODULE.OperatorError, match="integrity"):
            MODULE.read_private_state(
                path, integrity_key="wrong-key", state_directory=tmp_path
            )
    finally:
        path.unlink(missing_ok=True)


def test_private_state_rejects_wrong_path_and_permissions(tmp_path):
    with pytest.raises(MODULE.OperatorError):
        MODULE.write_private_state(
            tmp_path / "wrong-prefix.json",
            _armed_state(),
            integrity_key=INTEGRITY_KEY,
            state_directory=tmp_path,
        )

    path = tmp_path / f"koaryu-payer-ambiguity-test-{uuid4()}.json"
    try:
        MODULE.write_private_state(
            path,
            _armed_state(),
            integrity_key=INTEGRITY_KEY,
            state_directory=tmp_path,
        )
        os.chmod(path, 0o644)
        with pytest.raises(MODULE.OperatorError):
            MODULE.read_private_state(
                path, integrity_key=INTEGRITY_KEY, state_directory=tmp_path
            )
    finally:
        path.unlink(missing_ok=True)


def test_private_state_rejects_symlinks_non_private_directory_and_path_escape(tmp_path):
    private = tmp_path / "linux-tmp-state"
    private.mkdir(mode=0o700)
    outside = tmp_path / "outside.json"
    link = private / f"koaryu-payer-ambiguity-{uuid4()}.json"
    outside.write_text("{}", encoding="utf-8")
    link.symlink_to(outside)
    with pytest.raises(MODULE.OperatorError, match="symlink"):
        MODULE.write_private_state(
            link, _armed_state(), integrity_key=INTEGRITY_KEY, state_directory=private
        )
    with pytest.raises(MODULE.OperatorError, match="inside"):
        MODULE.write_private_state(
            outside, _armed_state(), integrity_key=INTEGRITY_KEY, state_directory=private
        )
    link.unlink()
    os.chmod(private, 0o755)
    with pytest.raises(MODULE.OperatorError, match="0700"):
        MODULE.write_private_state(
            private / f"koaryu-payer-ambiguity-{uuid4()}.json",
            _armed_state(), integrity_key=INTEGRITY_KEY, state_directory=private,
        )


def test_private_state_rejects_symlink_in_intermediate_directory(tmp_path):
    real_parent = tmp_path / "real-parent"
    real_parent.mkdir(mode=0o700)
    private = real_parent / "private"
    private.mkdir(mode=0o700)
    linked_parent = tmp_path / "linked-parent"
    linked_parent.symlink_to(real_parent, target_is_directory=True)
    linked_private = linked_parent / "private"
    with pytest.raises(MODULE.OperatorError, match="symlink"):
        MODULE.write_private_state(
            linked_private / f"koaryu-payer-ambiguity-{uuid4()}.json",
            _armed_state(),
            integrity_key=INTEGRITY_KEY,
            require_absent=True,
            state_directory=linked_private,
        )


def test_atomic_arming_allows_exactly_one_competing_writer(tmp_path):
    path = tmp_path / f"koaryu-payer-ambiguity-{uuid4()}.json"
    states = [
        _armed_state(),
        {**_armed_state(), "actor_id": "00000000-0000-4000-8000-000000000009"},
    ]

    def arm(state):
        try:
            MODULE.write_private_state(
                path,
                state,
                integrity_key=INTEGRITY_KEY,
                require_absent=True,
                state_directory=tmp_path,
            )
            return "won"
        except MODULE.OperatorError:
            return "lost"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(arm, states))
    assert sorted(outcomes) == ["lost", "won"]
    persisted = MODULE.read_private_state(
        path, integrity_key=INTEGRITY_KEY, state_directory=tmp_path
    )
    assert persisted in states


def test_private_state_rejects_tampering_and_phase_field_drift(tmp_path):
    path = tmp_path / f"koaryu-payer-ambiguity-test-{uuid4()}.json"
    try:
        MODULE.write_private_state(
            path,
            _armed_state(),
            integrity_key=INTEGRITY_KEY,
            state_directory=tmp_path,
        )
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["provider_mutation_count"] = 1
        path.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(path, 0o600)
        with pytest.raises(MODULE.OperatorError, match="integrity"):
            MODULE.read_private_state(
                path, integrity_key=INTEGRITY_KEY, state_directory=tmp_path
            )
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
        capture_create_response=lambda _customer: ({"source": "create"}, "a" * 64),
        verify_create_response=lambda _customer: None,
        arm=lambda: persisted.append({"phase": "armed"}),
    )
    service = faulting()
    with pytest.raises(MODULE.DeliberateProviderResponseLoss):
        service.create_connected_customer(account_id="acct_Test123")
    assert len(calls) == 1
    assert state == {
        "phase": "provider_response_verified",
        "provider_customer_id": "cus_Test123",
        "provider_mutation_count": 1,
        "provider_create_response_count": 1,
        "automatic_retry_count": 0,
        "recovery_proof_sha256": "a" * 64,
        "provider_evidence": {"source": "create"},
    }
    assert persisted[0] == {"phase": "armed"}
    assert persisted[1]["phase"] == "provider_created"
    assert persisted[2] == state

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
        capture_create_response=lambda _customer: ({}, "a" * 64),
        verify_create_response=lambda _customer: None,
        arm=lambda: None,
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
        "provider_create_response_count": 1,
        "provider_retrieve_count": 0,
        "automatic_retry_count": 0,
        "recovery_proof_sha256": "a" * 64,
        "provider_evidence": {"source": "create"},
    }


def test_recovery_action_models_each_crash_boundary_without_extra_read_or_replay():
    assert MODULE.classify_recovery_action(
        state=_provider_created_state(phase="provider_response_verified"),
        operation=_recoverable_operation(),
        resource=_resource(),
        payer_id=PAYER_ID,
    ) == "authorize_from_create_response"

    verified = _provider_created_state(phase="provider_response_verified")
    assert MODULE.classify_recovery_action(
        state={**verified, "phase": "provider_verified"},
        operation=_recoverable_operation(),
        resource=_resource(),
        payer_id=PAYER_ID,
    ) == "authorize_from_create_response"

    committed = {
        **_recoverable_operation(state="recovery_authorized"),
        "provider_object_id": "cus_Test123",
        "recovery_outcome": "provider_succeeded_reconcile_only",
        "recovery_proof_sha256": "a" * 64,
    }
    assert MODULE.classify_recovery_action(
        state={**verified, "phase": "provider_verified"},
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
        "provider_retrieve_count": 0,
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


def test_create_response_proof_authorizes_without_any_provider_retrieve():
    state = _provider_created_state()
    assert MODULE.recovery_proof_from_create_response(state) == "a" * 64
    for invalid in (
        {**state, "provider_create_response_count": 0},
        {**state, "provider_retrieve_count": 1},
        {**state, "recovery_proof_sha256": "bad"},
    ):
        with pytest.raises(MODULE.OperatorError):
            MODULE.recovery_proof_from_create_response(invalid)


def test_interruption_after_create_capture_fails_closed_before_authorization():
    persisted: list[dict] = []

    class FakeStripe:
        def create_connected_customer(self, **_kwargs):
            return {"id": "cus_Test123"}

    faulting = MODULE.build_faulting_stripe_service(
        FakeStripe,
        state={"phase": "armed"},
        persist=lambda value: persisted.append(dict(value)),
        capture_create_response=lambda _customer: ({"source": "create"}, "a" * 64),
        verify_create_response=lambda _customer: (_ for _ in ()).throw(RuntimeError("interrupted")),
        arm=lambda: persisted.append({"phase": "armed"}),
    )
    with pytest.raises(RuntimeError, match="interrupted"):
        faulting().create_connected_customer()
    assert [item["phase"] for item in persisted] == ["armed", "provider_created"]
    with pytest.raises(MODULE.OperatorError, match="attended inspection"):
        MODULE.classify_recovery_action(
            state={**_provider_created_state(), "phase": "provider_created"},
            operation=_recoverable_operation(), resource=_resource(), payer_id=PAYER_ID,
        )


def test_rpc_committed_crash_resume_persists_without_provider_or_projection_callback():
    state = {
        **_provider_created_state(phase="provider_verified"),
        "provider_retrieve_count": 0,
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
        "provider_create_response_count": 1,
        "provider_retrieve_count": 0,
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


def test_reconciliation_required_resume_revalidates_evidence_before_continuation():
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
        "phase": "reconciliation_required",
        "provider_customer_id": "cus_Test123",
        "provider_evidence": evidence,
        "recovery_proof_sha256": stable_hash(evidence),
    }
    MODULE.validate_continuation_evidence(
        state=state,
        operation=operation,
        payer_id=PAYER_ID,
        test_clock_id="clock_Test123",
        stable_hash=stable_hash,
    )
    mismatched = {
        **state,
        "provider_evidence": {**evidence, "customer_id": "cus_Other"},
    }
    with pytest.raises(MODULE.OperatorError, match="binding"):
        MODULE.validate_continuation_evidence(
            state=mismatched,
            operation=operation,
            payer_id=PAYER_ID,
            test_clock_id="clock_Test123",
            stable_hash=stable_hash,
        )
