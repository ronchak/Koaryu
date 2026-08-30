#!/usr/bin/env python3
"""Attended staging-only payer-sync ambiguity rehearsal.

This operator tool deliberately loses the in-process Stripe customer-create response
after Stripe returns success. It then verifies the one created customer, authorizes
the existing parent-operation recovery RPC, and stops before the caller replays the
same hosted request. It never retries the provider mutation.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Mapping
from uuid import uuid4


EXPECTED_STAGING_SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
STATE_SCHEMA_VERSION = 1
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
CLOCK_PATTERN = re.compile(r"^clock_[A-Za-z0-9]+$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
KEY_PREFIX = "schema-v4-payer-sync-"
EXECUTION_LATCH = "I_UNDERSTAND_THIS_CREATES_ONE_STRIPE_TEST_CUSTOMER"
BASE_STATE_KEYS = {
    "schema_version",
    "phase",
    "candidate_sha",
    "studio_id",
    "actor_id",
    "payer_id",
    "test_clock_id",
    "caller_key_sha256",
    "provider_mutation_count",
    "provider_readback_count",
    "automatic_retry_count",
}
PROVIDER_STATE_KEYS = BASE_STATE_KEYS | {"provider_customer_id"}
OPERATION_STATE_KEYS = PROVIDER_STATE_KEYS | {
    "operation_id",
    "resource_claim_id",
    "operation_revision",
    "request_sha256",
    "stripe_connected_account_id",
    "connect_account_generation",
}
VERIFIED_STATE_KEYS = OPERATION_STATE_KEYS | {
    "recovery_proof_sha256",
    "provider_evidence",
}


class OperatorError(RuntimeError):
    pass


class DeliberateProviderResponseLoss(RuntimeError):
    pass


def _required(environment: Mapping[str, str], name: str) -> str:
    value = str(environment.get(name) or "").strip()
    if not value:
        raise OperatorError(f"missing required environment variable: {name}")
    return value


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _stripe_id(value: Any) -> str | None:
    candidate = value.get("id") if isinstance(value, dict) else getattr(value, "id", None)
    return str(candidate) if candidate else None


def _object_get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)


def validate_execution_context(
    *,
    expected_sha: str,
    current_sha: str,
    environment: Mapping[str, str],
) -> None:
    if not SHA_PATTERN.fullmatch(expected_sha):
        raise OperatorError("expected SHA must be one full lowercase commit SHA")
    if current_sha != expected_sha:
        raise OperatorError("local checkout does not match the approved candidate SHA")
    if environment.get("RENDER_GIT_COMMIT") != expected_sha:
        raise OperatorError("runtime commit identity does not match the approved candidate SHA")
    if environment.get("ENVIRONMENT") != "staging":
        raise OperatorError("payer ambiguity rehearsal is restricted to staging")
    if environment.get("STRIPE_MODE") != "test":
        raise OperatorError("payer ambiguity rehearsal requires Stripe test mode")
    if str(environment.get("LIVE_BILLING_ENABLED") or "").lower() != "false":
        raise OperatorError("payer ambiguity rehearsal requires live billing to remain disabled")
    if environment.get("SUPABASE_URL") != EXPECTED_STAGING_SUPABASE_URL:
        raise OperatorError("payer ambiguity rehearsal is pinned to the staging Supabase project")
    if environment.get("KOARYU_REHEARSAL_EXECUTE") != EXECUTION_LATCH:
        raise OperatorError("explicit rehearsal execution latch is missing")


def validate_state_phase(state: Mapping[str, Any]) -> None:
    phase = state.get("phase")
    expected_keys = {
        "armed": BASE_STATE_KEYS,
        "provider_created": PROVIDER_STATE_KEYS,
        "reconciliation_required": OPERATION_STATE_KEYS,
        "provider_readback_in_flight": OPERATION_STATE_KEYS,
        "provider_verified": VERIFIED_STATE_KEYS,
        "recovery_authorized": VERIFIED_STATE_KEYS,
    }.get(str(phase))
    if expected_keys is None or set(state) != expected_keys:
        raise OperatorError("ambiguity state phase fields are not exact")
    if (
        state.get("schema_version") != STATE_SCHEMA_VERSION
        or state.get("provider_mutation_count") not in {0, 1}
        or state.get("automatic_retry_count") != 0
        or state.get("provider_readback_count") not in {0, 1}
    ):
        raise OperatorError("ambiguity state counters are invalid")
    if phase == "armed" and (
        state.get("provider_mutation_count") != 0
        or state.get("provider_readback_count") != 0
    ):
        raise OperatorError("armed ambiguity state counters are invalid")
    if phase in {"provider_created", "reconciliation_required", "provider_readback_in_flight"} and (
        state.get("provider_mutation_count") != 1
        or state.get("provider_readback_count") != 0
    ):
        raise OperatorError("pre-readback ambiguity state counters are invalid")
    if phase in {"provider_verified", "recovery_authorized"} and (
        state.get("provider_mutation_count") != 1
        or state.get("provider_readback_count") != 1
        or not re.fullmatch(r"[0-9a-f]{64}", str(state.get("recovery_proof_sha256") or ""))
        or not isinstance(state.get("provider_evidence"), dict)
    ):
        raise OperatorError("verified ambiguity state is invalid")


def _state_hmac(state: Mapping[str, Any], integrity_key: str) -> str:
    encoded = json.dumps(state, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(integrity_key.encode("utf-8"), encoded, hashlib.sha256).hexdigest()


def write_private_state(
    path: Path,
    state: dict[str, Any],
    *,
    integrity_key: str,
    require_absent: bool = False,
) -> None:
    path = path.resolve()
    if not str(path).startswith("/private/tmp/koaryu-payer-ambiguity-"):
        raise OperatorError("state file must use /private/tmp/koaryu-payer-ambiguity-* path")
    if require_absent and path.exists():
        raise OperatorError("refusing to overwrite an existing ambiguity state file")
    validate_state_phase(state)
    serialized_state = {
        **state,
        "state_hmac_sha256": _state_hmac(state, integrity_key),
    }
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(serialized_state, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def read_private_state(path: Path, *, integrity_key: str) -> dict[str, Any]:
    path = path.resolve()
    if not str(path).startswith("/private/tmp/koaryu-payer-ambiguity-"):
        raise OperatorError("state file must use /private/tmp/koaryu-payer-ambiguity-* path")
    if (path.stat().st_mode & 0o777) != 0o600:
        raise OperatorError("ambiguity state file must have mode 0600")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise OperatorError("ambiguity state file schema is invalid")
    state_hmac = str(value.pop("state_hmac_sha256", ""))
    expected_hmac = _state_hmac(value, integrity_key)
    if not hmac.compare_digest(state_hmac, expected_hmac):
        raise OperatorError("ambiguity state file integrity check failed")
    validate_state_phase(value)
    return value


def build_faulting_stripe_service(
    base_class: type,
    *,
    state: dict[str, Any],
    persist: Callable[[dict[str, Any]], None],
) -> type:
    class FaultingStripeService(base_class):
        create_attempt_count = 0

        def create_connected_customer(self, **kwargs):
            type(self).create_attempt_count += 1
            if type(self).create_attempt_count != 1:
                raise OperatorError("fault injector refused a second customer-create attempt")
            customer = super().create_connected_customer(**kwargs)
            customer_id = _stripe_id(customer)
            if not customer_id or not customer_id.startswith("cus_"):
                raise OperatorError("Stripe customer create returned an invalid identity")
            state.update(
                phase="provider_created",
                provider_customer_id=customer_id,
                provider_mutation_count=1,
                automatic_retry_count=0,
            )
            persist(state)
            raise DeliberateProviderResponseLoss("operator discarded successful provider response")

    return FaultingStripeService


def build_capturing_coordinator(base_class: type) -> type:
    class CapturingCoordinator(base_class):
        claimed: dict[str, Any] | None = None
        latest_operation: dict[str, Any] | None = None

        def claim_resource(self, **kwargs):
            result = super().claim_resource(**kwargs)
            type(self).claimed = result
            return result

        def transition(self, context, operation, to_state, **kwargs):
            result = super().transition(context, operation, to_state, **kwargs)
            type(self).latest_operation = result
            return result

    return CapturingCoordinator


def require_route_authorization(
    resolver: Callable[..., Mapping[str, Any]],
    client: Any,
    *,
    actor_id: str,
    studio_id: str,
) -> dict[str, Any]:
    try:
        membership = dict(
            resolver(
                client,
                actor_id,
                studio_id,
                require_platform_subscription=True,
            )
        )
    except Exception as exc:
        raise OperatorError(
            "hosted payer-sync Admin and Koaryu Core authorization failed"
        ) from exc
    if membership.get("studio_id") != studio_id or membership.get("role") != "admin":
        raise OperatorError("hosted payer-sync authorization resolved the wrong membership")
    return membership


def classify_recovery_action(
    *,
    state: Mapping[str, Any],
    operation: Mapping[str, Any],
    resource: Mapping[str, Any],
    payer_id: str,
) -> str:
    customer_id = str(state.get("provider_customer_id") or "")
    if not customer_id.startswith("cus_"):
        raise OperatorError("provider customer identity was not durably recorded")
    if (
        state.get("provider_mutation_count") != 1
        or state.get("automatic_retry_count") != 0
    ):
        raise OperatorError("provider mutation or retry count is not exact")
    if (
        operation.get("operation_type") != "payer.sync"
        or operation.get("result_code") != "payer_sync_create_started"
        or operation.get("result_summary") != "sync_mode:create:target_customer_id:none"
        or int(operation.get("provider_request_attempt_count") or 0) != 1
        or not operation.get("id")
        or not operation.get("studio_id")
        or resource.get("operation_id") != operation.get("id")
        or resource.get("studio_id") != operation.get("studio_id")
        or resource.get("operation_type") != operation.get("operation_type")
        or resource.get("resource_type") != "payer"
        or str(resource.get("resource_id")) != payer_id
        or str(resource.get("payer_id")) != payer_id
    ):
        raise OperatorError("durable payer-sync ambiguity state is not exact")

    if operation.get("state") == "recovery_authorized":
        operation_proof = str(operation.get("recovery_proof_sha256") or "")
        state_proof = str(state.get("recovery_proof_sha256") or "")
        if (
            state.get("phase") not in {"provider_verified", "recovery_authorized"}
            or state.get("provider_readback_count") != 1
            or operation.get("provider_object_id") != customer_id
            or operation.get("recovery_outcome")
            != "provider_succeeded_reconcile_only"
            or not re.fullmatch(r"[0-9a-f]{64}", state_proof)
            or operation_proof != state_proof
        ):
            raise OperatorError("committed recovery authorization is not exact")
        return "persist_authorized"

    if (
        operation.get("state") not in {
            "provider_request_in_flight",
            "reconciliation_required",
        }
        or operation.get("provider_object_id") is not None
    ):
        raise OperatorError("durable payer-sync ambiguity state is not recoverable")

    phase = state.get("phase")
    if phase == "provider_verified":
        proof = str(state.get("recovery_proof_sha256") or "")
        if (
            state.get("provider_readback_count") != 1
            or not re.fullmatch(r"[0-9a-f]{64}", proof)
        ):
            raise OperatorError("durable provider verification evidence is invalid")
        return "authorize_without_readback"
    if phase in {"provider_created", "reconciliation_required"}:
        if state.get("provider_readback_count") != 0:
            raise OperatorError("provider readback count is inconsistent with state phase")
        return "retrieve_then_authorize"
    raise OperatorError("ambiguity state phase is not recoverable")


def require_unprojected_payer(payer: Mapping[str, Any]) -> None:
    if payer.get("stripe_customer_id") is not None:
        raise OperatorError("payer already has a Stripe customer")


def validate_provider_evidence_binding(
    *,
    state: Mapping[str, Any],
    operation: Mapping[str, Any],
    payer_id: str,
    test_clock_id: str,
    stable_hash: Callable[[Any], str],
) -> None:
    evidence = state.get("provider_evidence")
    if not isinstance(evidence, dict) or set(evidence) != {
        "evidence_type",
        "operation_id",
        "payer_id",
        "customer_id",
        "test_clock_id",
        "name",
        "email",
        "phone",
        "address",
        "metadata",
    }:
        raise OperatorError("normalized provider evidence fields are not exact")
    if set(evidence.get("address") or {}) != {"line1", "city", "state", "postal_code"}:
        raise OperatorError("normalized provider address evidence is not exact")
    if set(evidence.get("metadata") or {}) != {"studio_id", "payer_id", "product"}:
        raise OperatorError("normalized provider metadata evidence is not exact")
    if (
        evidence.get("evidence_type")
        != "payer_sync_provider_succeeded_reconcile_only"
        or evidence.get("operation_id") != operation.get("id")
        or evidence.get("payer_id") != payer_id
        or evidence.get("customer_id") != state.get("provider_customer_id")
        or evidence.get("test_clock_id") != test_clock_id
        or evidence["metadata"].get("studio_id") != operation.get("studio_id")
        or evidence["metadata"].get("payer_id") != payer_id
        or evidence["metadata"].get("product") != "koaryu_payments"
        or stable_hash(evidence) != state.get("recovery_proof_sha256")
    ):
        raise OperatorError("normalized provider evidence binding is invalid")


def validate_state_binding(state: Mapping[str, Any], environment: Mapping[str, str], expected_sha: str) -> None:
    expected = {
        "candidate_sha": expected_sha,
        "studio_id": _required(environment, "KOARYU_REHEARSAL_STUDIO_ID"),
        "actor_id": _required(environment, "KOARYU_REHEARSAL_ACTOR_ID"),
        "payer_id": _required(environment, "KOARYU_REHEARSAL_PAYER_ID"),
        "test_clock_id": _required(environment, "KOARYU_REHEARSAL_TEST_CLOCK_ID"),
        "caller_key_sha256": _sha256(_required(environment, "KOARYU_REHEARSAL_PAYER_SYNC_KEY")),
    }
    for key, value in expected.items():
        if state.get(key) != value:
            raise OperatorError(f"ambiguity state file does not match current {key}")


def _context_from_claim(operation_context_class: type, claimed: Mapping[str, Any]):
    operation = claimed.get("operation")
    if not isinstance(operation, dict):
        raise OperatorError("captured claim is missing its operation")
    return operation_context_class(
        operation_id=str(operation["id"]),
        studio_id=str(operation["studio_id"]),
        actor_id=str(operation["actor_id"]),
        operation_type=str(operation["operation_type"]),
        caller_request_key=str(claimed["canonical_caller_request_key"]),
        request_sha256=str(operation["request_sha256"]),
        stripe_connected_account_id=str(operation["stripe_connected_account_id"]),
        connect_account_generation=int(operation["connect_account_generation"]),
        lease_owner=str(operation["lease_owner"]),
    )


def _recovery_evidence_payload(
    *,
    operation: Mapping[str, Any],
    payer: Mapping[str, Any],
    customer: Any,
    test_clock_id: str,
) -> dict[str, Any]:
    address = _object_get(customer, "address") or {}
    metadata = _object_get(customer, "metadata") or {}
    return {
        "evidence_type": "payer_sync_provider_succeeded_reconcile_only",
        "operation_id": operation["id"],
        "payer_id": payer["id"],
        "customer_id": _stripe_id(customer),
        "test_clock_id": test_clock_id,
        "name": _object_get(customer, "name"),
        "email": _object_get(customer, "email"),
        "phone": _object_get(customer, "phone"),
        "address": {
            key: _object_get(address, key)
            for key in ("line1", "city", "state", "postal_code")
        },
        "metadata": {
            key: _object_get(metadata, key)
            for key in ("studio_id", "payer_id", "product")
        },
    }


def _recovery_proof(
    stable_hash: Callable[[Any], str],
    *,
    operation: Mapping[str, Any],
    payer: Mapping[str, Any],
    customer: Any,
    test_clock_id: str,
) -> str:
    return stable_hash(
        _recovery_evidence_payload(
            operation=operation,
            payer=payer,
            customer=customer,
            test_clock_id=test_clock_id,
        )
    )


def verify_provider_once_or_resume(
    *,
    action: str,
    state: dict[str, Any],
    persist: Callable[[dict[str, Any]], None],
    retrieve: Callable[[], Any],
    verify: Callable[[Any], None],
    proof_builder: Callable[[Any], tuple[dict[str, Any], str]],
) -> str:
    if action == "authorize_without_readback":
        return str(state["recovery_proof_sha256"])
    if action != "retrieve_then_authorize":
        raise OperatorError("provider verification action is invalid")
    state["phase"] = "provider_readback_in_flight"
    persist(state)
    customer = retrieve()
    verify(customer)
    provider_evidence, proof = proof_builder(customer)
    state.update(
        phase="provider_verified",
        provider_readback_count=1,
        recovery_proof_sha256=proof,
        provider_evidence=provider_evidence,
    )
    persist(state)
    return proof


def persist_committed_authorization(
    *,
    state: dict[str, Any],
    operation: Mapping[str, Any],
    resource: Mapping[str, Any],
    persist: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    state.update(
        phase="recovery_authorized",
        operation_id=str(operation["id"]),
        resource_claim_id=str(resource["id"]),
        operation_revision=int(operation["revision"]),
        request_sha256=str(operation["request_sha256"]),
        stripe_connected_account_id=str(operation["stripe_connected_account_id"]),
        connect_account_generation=int(operation["connect_account_generation"]),
    )
    persist(state)
    return {
        "phase": "recovery_authorized",
        "provider_mutation_count": state["provider_mutation_count"],
        "provider_readback_count": state["provider_readback_count"],
        "automatic_retry_count": state["automatic_retry_count"],
        "parent_operation_bound": True,
        "resource_claim_bound": True,
        "hosted_replay_required": True,
    }


def _current_sha(repository: Path) -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repository, text=True, stderr=subprocess.DEVNULL
    ).strip()


def validate_repository_state(repository: Path) -> None:
    operator_path = Path("scripts/rehearse-payer-sync-ambiguity.py")
    status_output = subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=repository,
        text=True,
        stderr=subprocess.DEVNULL,
    )
    if status_output.strip():
        raise OperatorError("repository must be completely clean before rehearsal execution")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(operator_path)],
        cwd=repository,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if tracked.returncode != 0:
        raise OperatorError("ambiguity operator is not tracked by the candidate commit")
    head_source = subprocess.check_output(
        ["git", "show", f"HEAD:{operator_path}"],
        cwd=repository,
        stderr=subprocess.DEVNULL,
    )
    if not hmac.compare_digest(
        head_source,
        (repository / operator_path).read_bytes(),
    ):
        raise OperatorError("ambiguity operator source does not match the candidate commit")


def run(args: argparse.Namespace, environment: Mapping[str, str]) -> dict[str, Any]:
    repository = Path(args.repository).resolve()
    expected_sha = args.expected_sha
    validate_repository_state(repository)
    validate_execution_context(
        expected_sha=expected_sha,
        current_sha=_current_sha(repository),
        environment=environment,
    )
    if not args.execute:
        raise OperatorError("--execute is required")

    studio_id = _required(environment, "KOARYU_REHEARSAL_STUDIO_ID")
    actor_id = _required(environment, "KOARYU_REHEARSAL_ACTOR_ID")
    payer_id = _required(environment, "KOARYU_REHEARSAL_PAYER_ID")
    test_clock_id = _required(environment, "KOARYU_REHEARSAL_TEST_CLOCK_ID")
    caller_key = _required(environment, "KOARYU_REHEARSAL_PAYER_SYNC_KEY")
    if not all(UUID_PATTERN.fullmatch(value) for value in (studio_id, actor_id, payer_id)):
        raise OperatorError("studio, actor, and payer identities must be lowercase UUIDs")
    if not CLOCK_PATTERN.fullmatch(test_clock_id):
        raise OperatorError("test clock identity is invalid")
    if not caller_key.startswith(KEY_PREFIX) or len(caller_key) > 255:
        raise OperatorError("caller key is not the dedicated schema-v4 payer-sync key")

    state_path = Path(args.state_file)
    if args.mode == "inject":
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "phase": "armed",
            "candidate_sha": expected_sha,
            "studio_id": studio_id,
            "actor_id": actor_id,
            "payer_id": payer_id,
            "test_clock_id": test_clock_id,
            "caller_key_sha256": _sha256(caller_key),
            "provider_mutation_count": 0,
            "provider_readback_count": 0,
            "automatic_retry_count": 0,
        }
        write_private_state(
            state_path,
            state,
            integrity_key=caller_key,
            require_absent=True,
        )
    else:
        state = read_private_state(state_path, integrity_key=caller_key)
        validate_state_binding(state, environment, expected_sha)
        if state.get("phase") == "armed":
            raise OperatorError(
                "provider success was not durably identified; stop for attended Stripe inspection and never run inject again"
            )
        if state.get("phase") == "provider_readback_in_flight":
            raise OperatorError(
                "provider readback outcome is ambiguous; stop for attended Stripe inspection and do not retrieve again"
            )
        if state.get("phase") not in {
            "provider_created",
            "reconciliation_required",
            "provider_verified",
            "recovery_authorized",
        }:
            raise OperatorError("resume mode requires a recorded provider customer")

    def persist(value: dict[str, Any]) -> None:
        write_private_state(state_path, value, integrity_key=caller_key)

    sys.path.insert(0, str(repository / "backend"))
    from fastapi import HTTPException
    import app.services.billing_payers as payer_module
    from app.core.config import get_settings
    from app.db.supabase import close_supabase_client, create_supabase_client
    from app.services.billing_payers import BillingPayerManager
    from app.services.billing_provider_operations import (
        BillingProviderOperationContext,
        BillingProviderOperationCoordinator,
    )
    from app.services.billing_service import BillingService
    from app.services.platform_billing_helpers import stable_hash
    from app.services.studio_scope import resolve_billing_admin_staff_role_for_user
    from app.services.stripe_mutation_policy import configured_stripe_mode
    from app.services.stripe_service import StripeService

    settings = get_settings()
    if configured_stripe_mode(settings) != "test":
        raise OperatorError("configured Stripe mode is not test")
    client = create_supabase_client()
    try:
        require_route_authorization(
            resolve_billing_admin_staff_role_for_user,
            client,
            actor_id=actor_id,
            studio_id=studio_id,
        )
        billing_service = BillingService(client)
        payer = billing_service._get_row_or_404(
            "billing_payers", payer_id, studio_id, "Payer not found."
        )
        require_unprojected_payer(payer)
        account = billing_service._connect_accounts().ensure_row(studio_id)
        if (
            account.get("status") != "charges_enabled"
            or account.get("charges_enabled") is not True
            or account.get("payouts_enabled") is not True
            or not account.get("stripe_connected_account_id")
        ):
            raise OperatorError("connected account is not fully enabled")

        capturing_class = build_capturing_coordinator(BillingProviderOperationCoordinator)
        if args.mode == "inject":
            original_coordinator = payer_module.BillingProviderOperationCoordinator
            payer_module.BillingProviderOperationCoordinator = capturing_class
            try:
                stripe_class = build_faulting_stripe_service(
                    StripeService, state=state, persist=persist
                )
                manager = BillingPayerManager(
                    billing_service, stripe_service_cls=stripe_class
                )
                caught: HTTPException | None = None
                try:
                    asyncio.run(
                        manager.sync_payer(
                            payer_id,
                            studio_id,
                            actor_id,
                            caller_key,
                            test_clock_id,
                        )
                    )
                except HTTPException as exc:
                    caught = exc
                if caught is None or caught.status_code != 503:
                    raise OperatorError(
                        "payer sync did not stop at the expected ambiguity boundary"
                    )
            finally:
                payer_module.BillingProviderOperationCoordinator = original_coordinator
        else:
            account_generation = BillingPayerManager._connect_account_generation(account)
            request_sha256 = BillingPayerManager._payer_sync_request_hash(
                payer,
                account_id=str(account["stripe_connected_account_id"]),
                generation=account_generation,
                test_clock_id=test_clock_id,
            )
            capturing_class(client).claim_resource(
                studio_id=studio_id,
                actor_id=actor_id,
                operation_type="payer.sync",
                resource_type="payer",
                resource_id=payer_id,
                payer_id=payer_id,
                caller_request_key=caller_key,
                request_sha256=request_sha256,
                stripe_connected_account_id=str(
                    account["stripe_connected_account_id"]
                ),
                connect_account_generation=account_generation,
                lease_owner=str(uuid4()),
            )

        claimed = capturing_class.claimed
        if not isinstance(claimed, dict):
            raise OperatorError("payer sync did not expose its durable claim")
        operation = capturing_class.latest_operation or claimed.get("operation")
        resource = claimed.get("resource")
        if not isinstance(operation, dict) or not isinstance(resource, dict):
            raise OperatorError("payer sync claim lacks parent/resource evidence")
        if state.get("phase") in {"provider_verified", "recovery_authorized"}:
            validate_provider_evidence_binding(
                state=state,
                operation=operation,
                payer_id=payer_id,
                test_clock_id=test_clock_id,
                stable_hash=stable_hash,
            )
        action = classify_recovery_action(
            state=state,
            operation=operation,
            resource=resource,
            payer_id=payer_id,
        )
        customer_id = str(state["provider_customer_id"])
        context = _context_from_claim(BillingProviderOperationContext, claimed)
        if action == "persist_authorized":
            return persist_committed_authorization(
                state=state,
                operation=operation,
                resource=resource,
                persist=persist,
            )
        state.update(
            phase=(
                "provider_verified"
                if action == "authorize_without_readback"
                else "reconciliation_required"
            ),
            operation_id=str(operation["id"]),
            resource_claim_id=str(resource["id"]),
            operation_revision=int(operation["revision"]),
            request_sha256=str(operation["request_sha256"]),
            stripe_connected_account_id=str(operation["stripe_connected_account_id"]),
            connect_account_generation=int(operation["connect_account_generation"]),
        )
        persist(state)

        metadata = {
            "studio_id": payer["studio_id"],
            "payer_id": payer["id"],
            "product": "koaryu_payments",
        }
        address = {
            "line1": payer.get("address_line1"),
            "city": payer.get("address_city"),
            "state": payer.get("address_state"),
            "postal_code": payer.get("address_zip"),
        }
        def retrieve_provider_customer():
            return StripeService().retrieve_connected_customer(
                account_id=context.stripe_connected_account_id,
                customer_id=customer_id,
                expand=["invoice_settings.default_payment_method"],
            )

        def verify_provider_customer(provider_customer):
            BillingPayerManager._verify_recovered_customer(
                provider_customer,
                payer=payer,
                customer_id=customer_id,
                sync_mode="create",
                metadata=metadata,
                address=address,
                test_clock_id=test_clock_id,
            )

        def build_provider_proof(provider_customer):
            provider_evidence = _recovery_evidence_payload(
                operation=operation,
                payer=payer,
                customer=provider_customer,
                test_clock_id=test_clock_id,
            )
            return provider_evidence, stable_hash(provider_evidence)

        proof = verify_provider_once_or_resume(
            action=action,
            state=state,
            persist=persist,
            retrieve=retrieve_provider_customer,
            verify=verify_provider_customer,
            proof_builder=build_provider_proof,
        )
        authorized = BillingProviderOperationCoordinator(client).authorize_recovery_v2(
            context,
            operation,
            recovery_actor_id=actor_id,
            recovery_proof_sha256=proof,
            recovery_outcome="provider_succeeded_reconcile_only",
            recovered_provider_object_id=customer_id,
            lease_owner=str(uuid4()),
            lease_seconds=300,
        )
        if (
            authorized.get("state") != "recovery_authorized"
            or authorized.get("provider_object_id") != customer_id
            or authorized.get("recovery_outcome") != "provider_succeeded_reconcile_only"
            or authorized.get("recovery_proof_sha256") != proof
            or int(authorized.get("provider_request_attempt_count") or 0) != 1
        ):
            raise OperatorError("recovery authorization readback is not exact")
        state.update(
            phase="recovery_authorized",
            operation_revision=int(authorized["revision"]),
            recovery_proof_sha256=proof,
        )
        persist(state)
        return {
            "phase": "recovery_authorized",
            "provider_mutation_count": state["provider_mutation_count"],
            "provider_readback_count": state["provider_readback_count"],
            "automatic_retry_count": state["automatic_retry_count"],
            "parent_operation_bound": True,
            "resource_claim_bound": True,
            "hosted_replay_required": True,
        }
    finally:
        close_supabase_client(client)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("inject", "resume"), required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--repository", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        result = run(parse_args(argv or sys.argv[1:]), os.environ)
    except (OperatorError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"payer ambiguity rehearsal stopped: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(
            f"payer ambiguity rehearsal stopped on unexpected {type(exc).__name__}",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
