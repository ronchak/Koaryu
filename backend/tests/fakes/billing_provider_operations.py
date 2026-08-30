from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from uuid import UUID
from typing import Any

from postgrest.exceptions import APIError as PostgrestAPIError


def _operation_conflict() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "billing_provider_operation_request_conflict",
        "details": "",
        "hint": "",
    })


def _refund_unsettled() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "55000",
        "message": "billing_provider_operation_resource_prior_refund_unsettled",
        "details": "",
        "hint": "",
    })


def _invoice_mutation_in_progress() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "55P03",
        "message": "billing_invoice_mutation_in_progress",
        "details": "",
        "hint": "",
    })


def _retry_preread_release_rejected(message: str) -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "55000",
        "message": message,
        "details": "",
        "hint": "",
    })


def _transition_not_found() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "P0002",
        "message": "billing_enrollment_transition_not_found",
        "details": "",
        "hint": "",
    })


def _transition_identity_mismatch() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23514",
        "message": "billing_enrollment_transition_read_identity_mismatch",
        "details": "",
        "hint": "",
    })


class BillingProviderOperationRpcMixin:
    billing_provider_operations: dict[tuple[str, str, str], dict[str, Any]]

    def initialize_billing_provider_operations(self) -> None:
        self.billing_provider_now = datetime(
            2026, 8, 27, tzinfo=timezone.utc
        )
        self.billing_provider_operations = {}
        self.billing_invoice_retry_hash_ledger_v33: dict[
            tuple[str, str], dict[str, Any]
        ] = {}
        self.billing_invoice_retry_hash_capture_enabled_v33 = True
        self.release_billing_invoice_retry_preread_lease_calls: list[
            dict[str, Any]
        ] = []
        self.billing_provider_step_plans: dict[str, dict[str, Any]] = {}
        self.billing_provider_operation_resources: dict[
            tuple[str, str, str], dict[str, Any]
        ] = {}
        self.billing_provider_operation_aliases: dict[
            tuple[str, str, str], str
        ] = {}
        self.billing_provider_operation_alias_resources: dict[
            tuple[str, str, str], tuple[str, str, str]
        ] = {}
        self.billing_invoice_mutation_owners: dict[
            tuple[str, str], dict[str, str]
        ] = {}
        self.billing_enrollment_transition_intents: dict[str, dict[str, Any]] = {}
        self.billing_enrollment_transition_aliases: dict[tuple[str, str, str], str] = {}

    def advance_billing_provider_clock(self, *, seconds: int) -> None:
        self.billing_provider_now += timedelta(seconds=seconds)

    @staticmethod
    def _billing_provider_timestamp(value: datetime) -> str:
        return value.isoformat().replace("+00:00", "Z")

    def _rpc_claim_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        key = (
            params["p_studio_id"],
            params["p_operation_type"],
            params["p_caller_request_key"],
        )
        operation = self.billing_provider_operations.get(key)
        if operation is None:
            lease_acquired_at = self.billing_provider_now
            lease_expires_at = lease_acquired_at + timedelta(
                seconds=int(params["p_lease_seconds"])
            )
            operation = {
                "id": f"00000000-0000-4000-8000-{len(self.billing_provider_operations) + 9001:012d}",
                "studio_id": params["p_studio_id"],
                "actor_id": params["p_actor_id"],
                "operation_type": params["p_operation_type"],
                "caller_request_key": params["p_caller_request_key"],
                "request_sha256": params["p_request_sha256"],
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "state": "started",
                "provider_request_attempt_count": 0,
                "lease_owner": params["p_lease_owner"],
                "lease_acquired_at": self._billing_provider_timestamp(
                    lease_acquired_at
                ),
                "lease_expires_at": self._billing_provider_timestamp(
                    lease_expires_at
                ),
                "invoice_retry_preread_released_at": None,
                "invoice_retry_preread_release_reason": None,
                "provider_object_id": None,
                "provider_secondary_object_id": None,
                "provider_request_id": None,
                "result_code": None,
                "result_summary": None,
                "error_code": None,
                "error_summary": None,
                "reconciliation_reason_code": None,
                "reconciliation_required_at": None,
                "recovery_proof_sha256": None,
                "recovery_outcome": None,
                "recovery_actor_id": None,
                "recovery_authorized_at": None,
                "provider_request_in_flight_at": None,
                "provider_succeeded_at": None,
                "projected_at": None,
                "completed_at": None,
                "definitive_failed_at": None,
                "definitive_rejected_at": None,
                "provider_step_plan_sha256": None,
                "provider_step_expected_count": None,
                "provider_step_plan_registered_at": None,
                "revision": 1,
            }
            self.billing_provider_operations[key] = operation
            return {"outcome": "claimed", "operation": dict(operation)}
        if any(
            operation[field] != params[param]
            for field, param in (
                ("studio_id", "p_studio_id"),
                ("actor_id", "p_actor_id"),
                ("operation_type", "p_operation_type"),
                ("caller_request_key", "p_caller_request_key"),
                ("request_sha256", "p_request_sha256"),
                ("stripe_connected_account_id", "p_stripe_connected_account_id"),
                ("connect_account_generation", "p_connect_account_generation"),
            )
        ):
            raise _operation_conflict()
        state = operation["state"]
        lease_transferable = (
            operation.get("operation_type") == "invoice.retry"
            and state in {
                "started", "recovery_authorized", "provider_succeeded", "projected"
            }
        )
        lease_owner = operation.get("lease_owner")
        lease_expires_at = operation.get("lease_expires_at")
        lease_expired = (
            lease_expires_at is not None
            and datetime.fromisoformat(
                str(lease_expires_at).replace("Z", "+00:00")
            ) <= self.billing_provider_now
        )
        if lease_transferable and (
            lease_owner is None
            or lease_owner == params["p_lease_owner"]
            or lease_expired
        ):
            lease_acquired_at = self.billing_provider_now
            lease_expires_at = lease_acquired_at + timedelta(
                seconds=int(params["p_lease_seconds"])
            )
            operation.update({
                "lease_owner": params["p_lease_owner"],
                "lease_acquired_at": self._billing_provider_timestamp(
                    lease_acquired_at
                ),
                "lease_expires_at": self._billing_provider_timestamp(
                    lease_expires_at
                ),
                "revision": operation["revision"] + 1,
            })
            outcome = "continued"
        elif lease_transferable:
            outcome = "busy"
        elif state == "provider_request_in_flight":
            outcome = "provider_request_in_flight"
        elif state == "reconciliation_required":
            outcome = "reconciliation_required"
        elif state in {"completed", "definitive_failed", "definitive_rejected"}:
            outcome = "replay"
        else:
            outcome = "continued"
        return {"outcome": outcome, "operation": dict(operation)}

    def _rpc_release_billing_invoice_retry_preread_lease_v33(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        self.release_billing_invoice_retry_preread_lease_calls.append(dict(params))
        operation = self._operation_by_id(params["p_operation_id"])
        expected = {
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_actor_id"],
            "operation_type": "invoice.retry",
            "caller_request_key": params["p_caller_request_key"],
            "request_sha256": params["p_request_sha256"],
            "stripe_connected_account_id": params["p_stripe_connected_account_id"],
            "connect_account_generation": params["p_connect_account_generation"],
            "lease_owner": params["p_lease_owner"],
            "revision": params["p_expected_revision"],
        }
        if params.get("p_release_reason") not in {
            "provider_preread_failed",
            "provider_preread_unavailable",
            "local_consent_preread_unavailable",
        }:
            raise _retry_preread_release_rejected(
                "billing_invoice_retry_preread_release_v33_reason_invalid"
            )
        if any(operation.get(field) != value for field, value in expected.items()):
            raise _operation_conflict()
        lease_acquired_at = operation.get("lease_acquired_at")
        lease_expires_at = operation.get("lease_expires_at")
        if (
            lease_acquired_at is None
            or datetime.fromisoformat(
                str(lease_acquired_at).replace("Z", "+00:00")
            ) > self.billing_provider_now
            or lease_expires_at is None
            or datetime.fromisoformat(
                str(lease_expires_at).replace("Z", "+00:00")
            ) <= self.billing_provider_now
        ):
            raise _retry_preread_release_rejected(
                "billing_invoice_retry_preread_release_lease_not_current"
            )
        parent_evidence_fields = (
            "provider_object_id",
            "provider_secondary_object_id",
            "provider_request_id",
            "result_code",
            "result_summary",
            "error_code",
            "error_summary",
            "reconciliation_reason_code",
            "recovery_proof_sha256",
            "recovery_outcome",
            "recovery_actor_id",
            "recovery_authorized_at",
            "provider_request_in_flight_at",
            "provider_succeeded_at",
            "projected_at",
            "completed_at",
            "reconciliation_required_at",
            "definitive_failed_at",
            "definitive_rejected_at",
            "provider_step_plan_sha256",
            "provider_step_expected_count",
            "provider_step_plan_registered_at",
        )
        parent_has_evidence = (
            operation.get("state") != "started"
            or int(operation.get("provider_request_attempt_count") or 0) != 0
            or any(
                operation.get(field) is not None for field in parent_evidence_fields
            )
        )
        child_evidence_fields = (
            "provider_object_id",
            "provider_secondary_object_id",
            "provider_request_id",
            "result_code",
            "error_code",
            "reconciliation_reason_code",
            "recovery_proof_sha256",
            "recovery_outcome",
            "recovery_actor_id",
            "recovery_authorized_at",
            "provider_request_in_flight_at",
            "provider_succeeded_at",
            "reconciliation_required_at",
            "definitive_failed_at",
            "definitive_rejected_at",
        )
        steps = self.billing_provider_step_plans.get(
            operation["id"], {}
        ).get("steps", [])
        child_has_evidence = any(
            step.get("state") != "pending"
            or int(step.get("provider_request_attempt_count") or 0) != 0
            or any(step.get(field) is not None for field in child_evidence_fields)
            for step in steps
        )
        if parent_has_evidence or child_has_evidence:
            raise _retry_preread_release_rejected(
                "billing_invoice_retry_preread_release_mutation_evidence"
            )
        operation.update({
            "lease_owner": None,
            "lease_acquired_at": None,
            "lease_expires_at": None,
            "invoice_retry_preread_released_at": self._billing_provider_timestamp(
                self.billing_provider_now
            ),
            "invoice_retry_preread_release_reason": params["p_release_reason"],
            "revision": operation["revision"] + 1,
        })
        return {"outcome": "released", "operation": dict(operation)}

    def _rpc_claim_billing_provider_operation_resource_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if params["p_operation_type"] == "invoice.retry":
            return self._rpc_claim_billing_invoice_retry_v33(params)
        if params["p_operation_type"] in {
            "invoice.finalize",
            "invoice.void",
        }:
            return self._rpc_claim_billing_invoice_mutation_v31(params)
        return self._rpc_claim_billing_provider_operation_resource_unserialized(params)

    def _rpc_claim_billing_invoice_retry_v33(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        invoice = next(
            (
                row
                for row in self.tables.get("billing_invoices", [])
                if self._canonical_uuid_text(row.get("id"))
                == self._canonical_uuid_text(params["p_resource_id"])
                and self._canonical_uuid_text(row.get("studio_id"))
                == self._canonical_uuid_text(params["p_studio_id"])
            ),
            None,
        )
        payer = next(
            (
                row
                for row in self.tables.get("billing_payers", [])
                if row.get("id") == params["p_payer_id"]
                and self._canonical_uuid_text(row.get("studio_id"))
                == self._canonical_uuid_text(params["p_studio_id"])
            ),
            None,
        )
        if invoice is None or payer is None:
            raise _operation_conflict()
        canonical_params = {
            **params,
            "p_studio_id": self._canonical_uuid_text(invoice["studio_id"]),
            "p_resource_id": self._canonical_uuid_text(invoice["id"]),
            "p_payer_id": payer["id"],
        }
        invoice_metadata = invoice.get("metadata") or {}
        generation = int(
            invoice_metadata.get("connect_account_generation")
            if "connect_account_generation" in invoice_metadata
            else payer["connect_account_generation"]
        )
        base_hash = hashlib.sha256(json.dumps({
            "connect_account_generation": generation,
            "invoice_id": self._canonical_uuid_text(invoice["id"]),
            "operation_type": "invoice.retry",
            "stripe_connected_account_id": str(invoice["stripe_account_id"]),
            "stripe_invoice_id": str(invoice["stripe_invoice_id"]),
            "studio_id": self._canonical_uuid_text(invoice["studio_id"]),
        }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        submitted_hash = params["p_request_sha256"]
        ledger_key = (
            canonical_params["p_studio_id"],
            params["p_caller_request_key"],
        )
        ledger = self.billing_invoice_retry_hash_ledger_v33.get(ledger_key)
        no_ledger_reclaim = False
        if ledger is None:
            owner = self.billing_invoice_mutation_owners.get(
                (canonical_params["p_studio_id"], canonical_params["p_resource_id"])
            )
            owner_operation = (
                self._operation_by_id(owner["operation_id"])
                if owner is not None and owner.get("operation_type") == "invoice.retry"
                else None
            )
            if (
                owner_operation is not None
                and owner_operation.get("state") not in {
                    "completed", "definitive_failed", "definitive_rejected"
                }
                and owner_operation.get("caller_request_key")
                == params["p_caller_request_key"]
                and owner_operation.get("invoice_retry_preread_released_at") is not None
            ):
                resource = next(
                    (
                        row
                        for row in self.billing_provider_operation_resources.values()
                        if row.get("id") == owner.get("resource_claim_id")
                    ),
                    None,
                )
                if (
                    resource is None
                    or resource.get("operation_id") != owner_operation.get("id")
                    or resource.get("resource_type") != "invoice"
                    or self._canonical_uuid_text(resource.get("resource_id"))
                    != canonical_params["p_resource_id"]
                    or resource.get("payer_id") != canonical_params["p_payer_id"]
                    or owner_operation.get("actor_id") != params["p_actor_id"]
                    or owner_operation.get("stripe_connected_account_id")
                    != params["p_stripe_connected_account_id"]
                    or owner_operation.get("connect_account_generation")
                    != params["p_connect_account_generation"]
                    or submitted_hash not in {base_hash, owner_operation["request_sha256"]}
                ):
                    raise _operation_conflict()
                effective_hash = owner_operation["request_sha256"]
                if submitted_hash == base_hash and effective_hash == base_hash:
                    compatibility_outcome = "base_hash_exact"
                elif submitted_hash == base_hash:
                    compatibility_outcome = "ledger_legacy_hash_accepted"
                else:
                    compatibility_outcome = "ledger_legacy_hash_replay"
                owner_operation.update({
                    "invoice_retry_preread_released_at": None,
                    "invoice_retry_preread_release_reason": None,
                    "lease_owner": params["p_lease_owner"],
                    "lease_acquired_at": self._billing_provider_timestamp(
                        self.billing_provider_now
                    ),
                    "lease_expires_at": self._billing_provider_timestamp(
                        self.billing_provider_now
                        + timedelta(seconds=params["p_lease_seconds"])
                    ),
                    "revision": owner_operation["revision"] + 1,
                })
                no_ledger_reclaim = True
            elif submitted_hash == base_hash:
                effective_hash = base_hash
                compatibility_outcome = "base_hash_exact"
            elif self.billing_invoice_retry_hash_capture_enabled_v33:
                effective_hash = submitted_hash
                compatibility_outcome = "capture_legacy_hash_created"
            else:
                raise _operation_conflict()
        else:
            if ledger.get("base_request_sha256") != base_hash:
                raise _operation_conflict()
            for field, param in (
                ("resource_id", "p_resource_id"),
                ("payer_id", "p_payer_id"),
                ("actor_id", "p_actor_id"),
                ("stripe_connected_account_id", "p_stripe_connected_account_id"),
                ("connect_account_generation", "p_connect_account_generation"),
            ):
                if ledger.get(field) != canonical_params[param]:
                    raise _operation_conflict()
            effective_hash = ledger["persisted_request_sha256"]
            if submitted_hash == base_hash and effective_hash == base_hash:
                compatibility_outcome = "ledger_base_hash_exact"
            elif submitted_hash == base_hash:
                compatibility_outcome = "ledger_legacy_hash_accepted"
            elif submitted_hash == effective_hash:
                compatibility_outcome = "ledger_legacy_hash_replay"
            else:
                raise _operation_conflict()
            ledger_operation = self._operation_by_id(ledger["operation_id"])
            if ledger_operation.get("invoice_retry_preread_released_at") is not None:
                ledger_operation.update({
                    "invoice_retry_preread_released_at": None,
                    "invoice_retry_preread_release_reason": None,
                    "revision": ledger_operation["revision"] + 1,
                })
        effective_params = {
            **canonical_params,
            "p_request_sha256": effective_hash,
        }
        if no_ledger_reclaim:
            result = {
                "outcome": "reclaimed",
                "operation": dict(owner_operation),
                "resource": dict(resource),
                "canonical_caller_request_key": params["p_caller_request_key"],
                "requested_caller_request_key": params["p_caller_request_key"],
            }
        else:
            result = self._rpc_claim_billing_invoice_mutation_v31(effective_params)
        if ledger is None and not no_ledger_reclaim:
            operation = result["operation"]
            self.billing_invoice_retry_hash_ledger_v33[ledger_key] = {
                "operation_id": operation["id"],
                "resource_id": canonical_params["p_resource_id"],
                "payer_id": canonical_params["p_payer_id"],
                "actor_id": params["p_actor_id"],
                "stripe_connected_account_id": params[
                    "p_stripe_connected_account_id"
                ],
                "connect_account_generation": params[
                    "p_connect_account_generation"
                ],
                "base_request_sha256": base_hash,
                "persisted_request_sha256": effective_hash,
            }
        return {
            **result,
            "requested_base_sha256": base_hash,
            "effective_persisted_sha256": effective_hash,
            "compatibility_outcome": compatibility_outcome,
        }

    @staticmethod
    def _canonical_uuid_text(value: Any) -> str:
        try:
            return str(UUID(str(value).strip("{}")))
        except (TypeError, ValueError):
            return str(value)

    def _rpc_claim_billing_invoice_mutation_v31(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        owner_key = (params["p_studio_id"], params["p_resource_id"])
        alias_key = (
            params["p_studio_id"],
            params["p_operation_type"],
            params["p_caller_request_key"],
        )
        owner = self.billing_invoice_mutation_owners.get(owner_key)
        alias_operation_id = self.billing_provider_operation_aliases.get(alias_key)
        if alias_operation_id is not None:
            alias_operation = self._operation_by_id(alias_operation_id)
            if alias_operation.get("state") in {
                "completed",
                "definitive_failed",
                "definitive_rejected",
            }:
                return self._rpc_claim_billing_provider_operation_resource_unserialized(params)
            if owner is not None and owner["operation_id"] != alias_operation_id:
                raise _invoice_mutation_in_progress()
        if owner is not None:
            owner_operation = self._operation_by_id(owner["operation_id"])
            if (
                owner_operation.get("state")
                not in {"completed", "definitive_failed", "definitive_rejected"}
                and owner["operation_type"] != params["p_operation_type"]
            ):
                raise _invoice_mutation_in_progress()
        result = self._rpc_claim_billing_provider_operation_resource_unserialized(params)
        candidate = result["operation"]
        candidate_owner = {
            "operation_id": str(candidate["id"]),
            "resource_claim_id": result["resource"]["id"],
            "studio_id": params["p_studio_id"],
            "payer_id": params["p_payer_id"],
            "operation_type": params["p_operation_type"],
            "resource_type": params["p_resource_type"],
        }
        if owner is None:
            self.billing_invoice_mutation_owners[owner_key] = candidate_owner
        elif (
            owner["operation_id"] != candidate["id"]
            and candidate.get("state") == "started"
        ):
            self.billing_invoice_mutation_owners[owner_key] = candidate_owner
        return result

    def mutate_billing_payer_payment_consent(
        self,
        consent_id: str,
        **updates: Any,
    ) -> dict[str, Any]:
        consent = next(
            row
            for row in self.tables.get("billing_payer_payment_consents", [])
            if row.get("id") == consent_id
        )
        if self._autopay_invoice_mutation_in_progress(
            str(consent.get("studio_id") or ""),
            str(consent.get("payer_id") or ""),
        ):
            raise _invoice_mutation_in_progress()
        consent.update(updates)
        return dict(consent)

    def mutate_billing_payer(
        self,
        payer_id: str,
        **updates: Any,
    ) -> dict[str, Any]:
        payer = next(
            row
            for row in self.tables.get("billing_payers", [])
            if row.get("id") == payer_id
        )
        if self._autopay_invoice_mutation_in_progress(
            str(payer.get("studio_id") or ""),
            str(payer.get("id") or ""),
        ):
            raise _invoice_mutation_in_progress()
        payer.update(updates)
        return dict(payer)

    def _autopay_invoice_mutation_in_progress(
        self,
        studio_id: str,
        payer_id: str,
    ) -> bool:
        for (owner_studio_id, invoice_id), owner in (
            self.billing_invoice_mutation_owners.items()
        ):
            if owner_studio_id != studio_id or owner.get("payer_id") != payer_id:
                continue
            operation_type = owner.get("operation_type")
            if operation_type == "invoice.finalize":
                invoice = next(
                    (
                        row
                        for row in self.tables.get("billing_invoices", [])
                        if row.get("id") == invoice_id
                        and row.get("studio_id") == studio_id
                    ),
                    None,
                )
                if not invoice or invoice.get("collection_method") != "charge_automatically":
                    continue
            elif operation_type != "invoice.retry":
                continue
            operation = self._operation_by_id(owner["operation_id"])
            if (
                operation.get("invoice_retry_preread_released_at") is not None
                and operation.get("state") in {
                    "started", "provider_request_in_flight", "recovery_authorized"
                }
                and int(operation.get("provider_request_attempt_count") or 0) == 0
                and all(
                    operation.get(field) is None
                    for field in (
                        "provider_object_id", "provider_secondary_object_id",
                        "provider_request_id", "result_code", "result_summary",
                        "error_code", "error_summary", "reconciliation_reason_code",
                        "recovery_proof_sha256", "recovery_outcome",
                    )
                )
            ):
                operation.update({
                    "state": "definitive_rejected",
                    "error_code": "invoice_retry_consent_changed_before_provider",
                    "definitive_rejected_at": self._billing_provider_timestamp(
                        self.billing_provider_now
                    ),
                    "invoice_retry_preread_released_at": None,
                    "invoice_retry_preread_release_reason": None,
                    "revision": operation["revision"] + 1,
                })
                continue
            if operation.get("state") in {
                "started",
                "provider_request_in_flight",
                "recovery_authorized",
            }:
                return True
        return False

    def _rpc_claim_billing_provider_operation_resource_unserialized(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if (
            params["p_operation_type"],
            params["p_resource_type"],
        ) not in {
            ("invoice.finalize", "invoice_finalize"),
            ("invoice.retry", "invoice"),
            ("invoice.void", "invoice_void"),
            ("payment.refund", "payment"),
            ("payer.sync", "payer"),
            ("plan.sync", "plan"),
            ("enrollment.activate.autopay", "enrollment"),
            ("enrollment.activate.invoice", "enrollment"),
        }:
            raise AssertionError("resource operation pair is unavailable")
        resource_key = (
            params["p_studio_id"],
            params["p_resource_type"],
            params["p_resource_id"],
        )
        alias_key = (
            params["p_studio_id"],
            params["p_operation_type"],
            params["p_caller_request_key"],
        )
        resource = self.billing_provider_operation_resources.get(resource_key)
        alias_operation_id = self.billing_provider_operation_aliases.get(alias_key)
        if alias_operation_id is not None:
            if (
                resource is None
                or self.billing_provider_operation_alias_resources.get(alias_key) != resource_key
            ):
                raise _operation_conflict()
            operation = self._operation_by_id(alias_operation_id)
            self._assert_resource_request_matches(operation, params)
            if (
                operation.get("state") != "completed"
                and resource.get("resource_version_sha256")
                != self._resource_version_sha256(params)
            ):
                raise _operation_conflict()
            if (
                operation.get("operation_type") == "invoice.retry"
                and operation.get("caller_request_key")
                == params["p_caller_request_key"]
            ):
                claimed = self._rpc_claim_billing_provider_operation_v1(params)
                operation = claimed["operation"]
                outcome = claimed["outcome"]
            else:
                outcome = "replay"
        elif resource is None:
            claimed = self._rpc_claim_billing_provider_operation_v1(params)
            operation = claimed["operation"]
            resource = {
                "id": f"00000000-0000-4000-8000-{len(self.billing_provider_operation_resources) + 9501:012d}",
                "studio_id": params["p_studio_id"],
                "operation_type": params["p_operation_type"],
                "resource_type": params["p_resource_type"],
                "resource_id": params["p_resource_id"],
                "payer_id": params["p_payer_id"],
                "operation_id": operation["id"],
                "resource_version_sha256": self._resource_version_sha256(params),
                "revision": 1,
                "created_at": "2026-08-27T00:00:00Z",
                "updated_at": "2026-08-27T00:00:00Z",
            }
            self.billing_provider_operation_resources[resource_key] = resource
            self.billing_provider_operation_aliases[alias_key] = operation["id"]
            self.billing_provider_operation_alias_resources[alias_key] = resource_key
            outcome = "claimed"
        else:
            if (
                resource["operation_type"] != params["p_operation_type"]
                or resource["payer_id"] != params["p_payer_id"]
            ):
                raise _operation_conflict()
            operation = self._operation_by_id(resource["operation_id"])
            if (
                operation.get("state") == "recovery_authorized"
                and operation.get("operation_type")
                in {"plan.sync", "payer.sync", "payment.refund"}
                and alias_operation_id is None
            ):
                raise _operation_conflict()
            current_resource_version = self._resource_version_sha256(params)
            completed_replacement = False
            if operation["state"] == "completed":
                if resource["resource_version_sha256"] != current_resource_version:
                    self._assert_resource_projection(operation, params)
                    completed_replacement = True
                elif params["p_resource_type"] == "payment":
                    projection = self._resource_projection(operation, params)
                    if projection.get("status") in {"failed", "canceled"}:
                        completed_replacement = True
                    else:
                        raise _refund_unsettled()
            if operation["state"] in {"definitive_failed", "definitive_rejected"}:
                claimed = self._rpc_claim_billing_provider_operation_v1(params)
                operation = claimed["operation"]
                resource["operation_id"] = operation["id"]
                resource["resource_version_sha256"] = current_resource_version
                resource["revision"] += 1
                outcome = "replaced"
            elif completed_replacement:
                claimed = self._rpc_claim_billing_provider_operation_v1(params)
                operation = claimed["operation"]
                resource["operation_id"] = operation["id"]
                resource["resource_version_sha256"] = current_resource_version
                resource["revision"] += 1
                outcome = "replaced"
            else:
                if resource["resource_version_sha256"] != current_resource_version:
                    raise _operation_conflict()
                self._assert_resource_request_matches(operation, params)
                outcome = "adopted"
            self.billing_provider_operation_aliases[alias_key] = operation["id"]
            self.billing_provider_operation_alias_resources[alias_key] = resource_key
        canonical_key = str(operation["caller_request_key"])
        return {
            "outcome": outcome,
            "requested_caller_request_key": params["p_caller_request_key"],
            "canonical_caller_request_key": canonical_key,
            "resource": dict(resource),
            "operation": dict(operation),
        }

    def _resource_version_sha256(self, params: dict[str, Any]) -> str | None:
        if params["p_resource_type"] == "plan":
            row = next(
                candidate
                for candidate in self.tables.get("billing_plans", [])
                if candidate.get("id") == params["p_resource_id"]
                and candidate.get("studio_id") == params["p_studio_id"]
            )
            payload = {
                "studio_id": row.get("studio_id"),
                "plan_id": row.get("id"),
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "name": row.get("name"),
                "description": row.get("description"),
                "amount_cents": int(row.get("amount_cents") or 0),
                "currency": row.get("currency") or "usd",
                "billing_interval": row.get("billing_interval") or "monthly",
            }
            encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
            return hashlib.sha256(encoded).hexdigest()
        if params["p_resource_type"] not in {"payment", "payer"}:
            return None
        if params["p_resource_type"] == "payment":
            row = next(
                candidate
                for candidate in self.tables.get("billing_payments", [])
                if candidate.get("id") == params["p_resource_id"]
                and candidate.get("studio_id") == params["p_studio_id"]
            )
            payload = {
                "operation_type": params["p_operation_type"],
                "studio_id": row.get("studio_id"),
                "payment_id": row.get("id"),
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "refunded_amount_cents": row.get("refunded_amount_cents"),
                "version": 1,
            }
        else:
            row = next(
                candidate
                for candidate in self.tables.get("billing_payers", [])
                if candidate.get("id") == params["p_resource_id"]
                and candidate.get("studio_id") == params["p_studio_id"]
            )
            payload = {
                "address_city": row.get("address_city"),
                "address_line1": row.get("address_line1"),
                "address_state": row.get("address_state"),
                "address_zip": row.get("address_zip"),
                "connect_account_generation": params["p_connect_account_generation"],
                "display_name": row.get("display_name"),
                "email": row.get("email"),
                "operation_type": params["p_operation_type"],
                "payer_id": row.get("id"),
                "phone": row.get("phone"),
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "studio_id": row.get("studio_id"),
                "version": 1,
            }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    def _assert_resource_projection(
        self,
        operation: dict[str, Any],
        params: dict[str, Any],
    ) -> None:
        if params["p_resource_type"] == "payment":
            self._resource_projection(operation, params)
            return
        if params["p_resource_type"] == "plan":
            plan = next(
                candidate
                for candidate in self.tables.get("billing_plans", [])
                if candidate.get("id") == params["p_resource_id"]
                and candidate.get("studio_id") == params["p_studio_id"]
            )
            summary = operation.get("result_summary")
            if operation.get("result_code") != "plan_sync_completed":
                raise _operation_conflict()
            if isinstance(summary, str) and re.fullmatch(
                r"plan_sync_mode:product_update_only:target_product_id:(prod_[A-Za-z0-9]+)",
                summary,
            ):
                target = summary.rsplit(":", 1)[1]
                matches = (
                    operation.get("provider_object_id") == plan.get("stripe_product_id")
                    == target
                )
            elif summary == "plan_sync_mode:product_price_steps":
                step_plan = self.billing_provider_step_plans.get(operation["id"])
                steps = list((step_plan or {}).get("steps") or [])
                matches = (
                    operation.get("provider_object_id") == plan.get("stripe_price_id")
                    and len(steps) == 2
                    and steps[0].get("step_order") == 1
                    and steps[0].get("step_name") == "product"
                    and steps[0].get("state") == "provider_succeeded"
                    and steps[0].get("provider_object_id") == plan.get("stripe_product_id")
                    and steps[1].get("step_order") == 2
                    and steps[1].get("step_name") == "price"
                    and steps[1].get("state") == "provider_succeeded"
                    and steps[1].get("provider_object_id") == plan.get("stripe_price_id")
                )
            else:
                matches = False
            if not matches:
                raise _operation_conflict()
            return
        payer = next(
            candidate
            for candidate in self.tables.get("billing_payers", [])
            if candidate.get("id") == params["p_resource_id"]
            and candidate.get("studio_id") == params["p_studio_id"]
        )
        summary = str(operation.get("result_summary") or "")
        valid_summary = (
            summary == "sync_mode:create:target_customer_id:none"
            or re.fullmatch(
                r"sync_mode:update:target_customer_id:cus_[A-Za-z0-9]+",
                summary,
            )
        )
        if (
            payer.get("stripe_customer_id") != operation.get("provider_object_id")
            or not valid_summary
        ):
            raise _operation_conflict()

    def _resource_projection(
        self,
        operation: dict[str, Any],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        projection = next(
            (
                row
                for row in self.tables.get("billing_refunds", [])
                if row.get("studio_id") == params["p_studio_id"]
                and row.get("payment_id") == params["p_resource_id"]
                and row.get("stripe_refund_id") == operation.get("provider_object_id")
                and row.get("stripe_account_id") == params["p_stripe_connected_account_id"]
                and row.get("connect_account_generation") == params["p_connect_account_generation"]
                and row.get("reconciliation_required") is not True
            ),
            None,
        )
        if projection is None:
            raise _operation_conflict()
        return projection

    def _rpc_read_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        return {"outcome": "read", "operation": dict(operation)}

    def _rpc_claim_billing_invoice_closeout_operation_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = self._rpc_claim_billing_invoice_mutation_v31(params)
        operation = self._operation_by_id(result["operation"]["id"])
        state = operation.get("state")
        if state in {"completed", "definitive_failed", "definitive_rejected"}:
            return {**result, "operation": dict(operation)}
        lease_owner = operation.get("lease_owner")
        lease_expires_at = operation.get("lease_expires_at")
        lease_expired = (
            lease_expires_at is not None
            and datetime.fromisoformat(
                str(lease_expires_at).replace("Z", "+00:00")
            ) <= self.billing_provider_now
        )
        requested_owner = params["p_lease_owner"]
        if (
            state in {
                "started", "recovery_authorized", "provider_succeeded",
                "projected", "reconciliation_required",
            }
            and (lease_owner is None or lease_owner == requested_owner or lease_expired)
        ):
            acquired_at = self.billing_provider_now
            operation.update({
                "lease_owner": requested_owner,
                "lease_acquired_at": self._billing_provider_timestamp(acquired_at),
                "lease_expires_at": self._billing_provider_timestamp(
                    acquired_at + timedelta(seconds=int(params["p_lease_seconds"]))
                ),
                "revision": operation["revision"] + 1,
            })
        return {**result, "operation": dict(operation)}

    def _rpc_transition_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation revision")
        legal_transitions = {
            "started": {
                "provider_request_in_flight", "definitive_failed",
                "definitive_rejected",
            },
            "provider_request_in_flight": {
                "provider_succeeded", "reconciliation_required",
                "definitive_failed", "definitive_rejected",
            },
            "provider_succeeded": {"projected", "reconciliation_required"},
            "projected": {"completed", "reconciliation_required"},
            "reconciliation_required": {
                "provider_succeeded", "projected", "definitive_failed",
                "definitive_rejected",
            },
        }
        allowed = legal_transitions.get(operation["state"], set())
        if operation["state"] == "recovery_authorized":
            recovery_outcome = operation.get("recovery_outcome")
            if recovery_outcome == "provider_no_object_safe_to_retry":
                allowed = {"provider_request_in_flight"}
            elif recovery_outcome == "provider_succeeded_reconcile_only":
                allowed = {"provider_succeeded", "reconciliation_required"}
            else:
                allowed = set()
        if params["p_to_state"] not in allowed:
            raise AssertionError("billing_provider_operation_invalid_transition")
        operation["state"] = params["p_to_state"]
        if params["p_to_state"] == "provider_request_in_flight":
            operation["provider_request_attempt_count"] += 1
        for field, param in (
            ("provider_object_id", "p_provider_object_id"),
            ("provider_secondary_object_id", "p_provider_secondary_object_id"),
            ("provider_request_id", "p_provider_request_id"),
            ("result_code", "p_result_code"),
            ("result_summary", "p_result_summary"),
        ):
            if params.get(param) is not None:
                operation[field] = params[param]
        if params["p_to_state"] in {"definitive_failed", "definitive_rejected"}:
            operation["error_code"] = params.get("p_error_code")
            operation["error_summary"] = params.get("p_error_summary")
        operation["reconciliation_reason_code"] = (
            params.get("p_reconciliation_reason_code")
            if params["p_to_state"] == "reconciliation_required"
            else None
        )
        operation["revision"] += 1
        return {"outcome": "transitioned", "operation": dict(operation)}

    def _rpc_complete_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if operation["state"] == "completed":
            return {"outcome": "replay", "operation": dict(operation)}
        if operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation revision")
        operation["state"] = "completed"
        if params.get("p_result_code") is not None:
            operation["result_code"] = params["p_result_code"]
        if params.get("p_result_summary") is not None:
            operation["result_summary"] = params["p_result_summary"]
        operation["revision"] += 1
        return {"outcome": "completed", "operation": dict(operation)}

    def _rpc_read_active_billing_payer_payment_consent_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        consent = next((row for row in self.tables.get("billing_payer_payment_consents", [])
            if row.get("studio_id") == params["p_studio_id"]
            and row.get("payer_id") == params["p_payer_id"]
            and row.get("terms_version") == params["p_terms_version"]
            and row.get("stripe_connected_account_id") == params["p_stripe_connected_account_id"]
            and row.get("connect_account_generation") == params["p_connect_account_generation"]
            and row.get("completed_at") and not row.get("revoked_at") and not row.get("superseded_at")), None)
        if consent is None:
            raise PostgrestAPIError({
                "code": "P0002",
                "message": "billing_payer_active_consent_not_found",
                "details": "",
                "hint": "",
            })
        return {"outcome": "read", "consent": dict(consent)}

    def _rpc_authorize_billing_provider_operation_recovery_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if (
            operation.get("state") == "recovery_authorized"
            and operation.get("recovery_actor_id") == params["p_recovery_actor_id"]
            and operation.get("recovery_proof_sha256") == params["p_recovery_proof_sha256"]
            and operation.get("recovery_outcome") == params["p_recovery_outcome"]
        ):
            return {"outcome": "replay", "operation": dict(operation)}
        if operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation recovery revision")
        if operation["state"] not in {
            "provider_request_in_flight",
            "reconciliation_required",
        }:
            raise AssertionError("operation is not recoverable")
        lease_acquired_at = self.billing_provider_now
        lease_expires_at = lease_acquired_at + timedelta(
            seconds=int(params["p_lease_seconds"])
        )
        operation.update({
            "state": "recovery_authorized",
            "recovery_actor_id": params["p_recovery_actor_id"],
            "recovery_proof_sha256": params["p_recovery_proof_sha256"],
            "recovery_outcome": params["p_recovery_outcome"],
            "lease_owner": params["p_lease_owner"],
            "lease_acquired_at": self._billing_provider_timestamp(
                lease_acquired_at
            ),
            "lease_expires_at": self._billing_provider_timestamp(
                lease_expires_at
            ),
            "revision": operation["revision"] + 1,
            "reconciliation_reason_code": None,
        })
        return {"outcome": "recovery_authorized", "operation": dict(operation)}

    def _rpc_authorize_billing_provider_operation_recovery_v2(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        recovered_id = params.get("p_recovered_provider_object_id")
        outcome = params["p_recovery_outcome"]
        prefixes = {"plan.sync": "prod_", "payer.sync": "cus_", "payment.refund": "re_"}
        if operation.get("provider_step_plan_sha256") is not None:
            raise AssertionError("parent step recovery denied")
        resource = next(
            candidate for candidate in self.billing_provider_operation_resources.values()
            if candidate.get("operation_id") == operation["id"]
        )
        current_plan = next((row for row in self.tables.get("billing_plans", [])
            if row.get("id") == resource.get("resource_id")), None)
        current_payer = next((row for row in self.tables.get("billing_payers", [])
            if row.get("id") == resource.get("resource_id")), None)
        plan_match = re.fullmatch(
            r"plan_sync_mode:product_update_only:target_product_id:(prod_[A-Za-z0-9]+)",
            str(operation.get("result_summary") or ""),
        )
        payer_update_match = re.fullmatch(
            r"sync_mode:update:target_customer_id:(cus_[A-Za-z0-9]+)",
            str(operation.get("result_summary") or ""),
        )
        saved_evidence_valid = {
            "plan.sync": bool(
                operation.get("result_code") == "plan_sync_product_update_started"
                and plan_match and current_plan
                and current_plan.get("status") == "active"
                and current_plan.get("archived_at") is None
                and current_plan.get("stripe_product_id") == plan_match.group(1)
            ),
            "payer.sync": bool(
                current_payer and (
                    (
                        operation.get("result_code") == "payer_sync_create_started"
                        and operation.get("result_summary")
                        == "sync_mode:create:target_customer_id:none"
                        and current_payer.get("stripe_customer_id") is None
                    ) or (
                        operation.get("result_code") == "payer_sync_update_started"
                        and payer_update_match
                        and current_payer.get("stripe_customer_id")
                        == payer_update_match.group(1)
                    )
                )
            ),
            "payment.refund": (
                operation.get("result_code") == "payment_refund_started"
                and isinstance(operation.get("result_summary"), str)
                and operation["result_summary"].startswith("amount_cents:")
                and operation["result_summary"][len("amount_cents:"):].isdigit()
                and int(operation["result_summary"][len("amount_cents:"):]) > 0
            ),
        }.get(operation["operation_type"], False)
        if not saved_evidence_valid:
            raise AssertionError("invalid saved recovery evidence")
        if operation.get("state") == "recovery_authorized":
            if (
                operation.get("recovery_actor_id") == params["p_recovery_actor_id"]
                and operation.get("recovery_proof_sha256") == params["p_recovery_proof_sha256"]
                and operation.get("recovery_outcome") == outcome
                and operation.get("provider_object_id") == recovered_id
            ):
                return {"outcome": "replay", "operation": dict(operation)}
            raise AssertionError("recovery conflict")
        if operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation recovery revision")
        if operation["state"] not in {"provider_request_in_flight", "reconciliation_required"}:
            raise AssertionError("operation is not recoverable")
        if outcome == "provider_no_object_safe_to_retry":
            if (
                recovered_id is not None
                or operation.get("provider_object_id") is not None
                or operation.get("provider_secondary_object_id") is not None
                or operation.get("provider_request_attempt_count") != 1
            ):
                raise AssertionError("invalid no-object recovery")
        elif outcome == "provider_succeeded_reconcile_only":
            prefix = prefixes.get(operation["operation_type"])
            if (
                not prefix
                or not isinstance(recovered_id, str)
                or not recovered_id.startswith(prefix)
                or operation.get("provider_request_attempt_count") not in {1, 2}
                or operation.get("provider_secondary_object_id") is not None
            ):
                raise AssertionError("invalid reconcile recovery")
            suffix = recovered_id[len(prefix):]
            if not suffix or not suffix.isalnum():
                raise AssertionError("invalid recovered object id")
        else:
            raise AssertionError("unknown recovery outcome")
        lease_acquired_at = self.billing_provider_now
        lease_expires_at = lease_acquired_at + timedelta(
            seconds=int(params["p_lease_seconds"])
        )
        operation.update({
            "state": "recovery_authorized",
            "provider_object_id": recovered_id,
            "recovery_actor_id": params["p_recovery_actor_id"],
            "recovery_proof_sha256": params["p_recovery_proof_sha256"],
            "recovery_outcome": outcome,
            "recovery_authorized_at": self._billing_provider_timestamp(
                self.billing_provider_now
            ),
            "lease_owner": params["p_lease_owner"],
            "lease_acquired_at": self._billing_provider_timestamp(
                lease_acquired_at
            ),
            "lease_expires_at": self._billing_provider_timestamp(
                lease_expires_at
            ),
            "revision": operation["revision"] + 1,
            "reconciliation_reason_code": None,
        })
        return {"outcome": "recovery_authorized", "operation": dict(operation)}

    def _rpc_mark_billing_provider_recovery_reconciliation_v2(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if (
            operation["revision"] != params["p_expected_revision"]
            or operation.get("state") != "recovery_authorized"
            or operation.get("recovery_outcome")
            != "provider_succeeded_reconcile_only"
            or operation.get("lease_owner") != params["p_lease_owner"]
        ):
            raise AssertionError("invalid recovery reconciliation")
        operation.update({
            "state": "reconciliation_required",
            "reconciliation_reason_code": params["p_reconciliation_reason_code"],
            "lease_owner": None,
            "lease_expires_at": None,
            "revision": operation["revision"] + 1,
        })
        return {"outcome": "reconciliation_required", "operation": dict(operation)}

    def _rpc_reject_billing_provider_recovery_source_drift_v2(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if (
            operation["revision"] != params["p_expected_revision"]
            or operation.get("state") != "recovery_authorized"
            or operation.get("lease_owner") != params["p_lease_owner"]
        ):
            raise AssertionError("invalid recovery source drift")
        operation.update({
            "state": "definitive_rejected",
            "error_code": params["p_error_code"],
            "lease_owner": None,
            "lease_expires_at": None,
            "revision": operation["revision"] + 1,
        })
        return {"outcome": "definitive_rejected", "operation": dict(operation)}

    def _rpc_claim_billing_enrollment_transition_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        alias_key = (
            params["p_studio_id"],
            params["p_transition_kind"],
            params["p_caller_request_key"],
        )
        existing_id = self.billing_enrollment_transition_aliases.get(alias_key)
        if existing_id:
            existing = self.billing_enrollment_transition_intents[existing_id]
            if (
                existing["initiated_by"] != params["p_actor_id"]
                or existing["request_sha256"] != params["p_request_sha256"]
            ):
                raise _operation_conflict()
            return {
                "outcome": "replay",
                "requested_caller_request_key": params["p_caller_request_key"],
                "intent": dict(existing),
            }
        intent_id = f"00000000-0000-4000-8000-{len(self.billing_enrollment_transition_intents) + 9701:012d}"
        operation_type = (
            "enrollment.cancel.immediate"
            if params["p_transition_kind"] == "immediate_cancel"
            else "enrollment.cancel.period_end.schedule"
        )
        operation = None
        if params["p_transition_kind"] in {"immediate_cancel", "schedule_period_end"}:
            operation = self._rpc_claim_billing_provider_operation_v1({
                "p_studio_id": params["p_studio_id"],
                "p_actor_id": params["p_actor_id"],
                "p_operation_type": operation_type,
                "p_caller_request_key": params["p_caller_request_key"],
                "p_request_sha256": params["p_request_sha256"],
                "p_stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "p_connect_account_generation": params["p_connect_account_generation"],
                "p_lease_owner": params["p_lease_owner"],
                "p_lease_seconds": params["p_lease_seconds"],
            })["operation"]
        intent = {
            "id": intent_id,
            "studio_id": params["p_studio_id"],
            "enrollment_id": params["p_enrollment_id"],
            "payer_id": params["p_payer_id"],
            "billing_subscription_id": params["p_billing_subscription_id"],
            "source_intent_id": None,
            "provider_operation_id": operation and operation["id"],
            "transition_kind": params["p_transition_kind"],
            "mutation_strategy": params["p_mutation_strategy"],
            "request_sha256": params["p_request_sha256"],
            "provider_caller_request_key": operation and params["p_caller_request_key"],
            "provider_request_sha256": operation and params["p_request_sha256"],
            "stripe_connected_account_id": params["p_stripe_connected_account_id"],
            "connect_account_generation": params["p_connect_account_generation"],
            "stripe_subscription_id": params["p_stripe_subscription_id"],
            "stripe_subscription_item_id": params["p_stripe_subscription_item_id"],
            "period_boundary": params["p_period_boundary"],
            "expected_quantity": params["p_expected_quantity"],
            "expected_subscription_item_count": params["p_expected_subscription_item_count"],
            "same_item_active_count": params["p_same_item_active_count"],
            "provider_quantity": params["p_provider_quantity"],
            "initiated_by": params["p_actor_id"],
            "reason_code": params["p_reason_code"],
            "state": "scheduled" if params["p_transition_kind"] == "schedule_period_end" else "due_claimed",
            "provider_evidence_sha256": None,
            "revision": 2 if operation else 1,
        }
        self.billing_enrollment_transition_intents[intent_id] = intent
        self.billing_enrollment_transition_aliases[alias_key] = intent_id
        return {
            "outcome": "claimed",
            "requested_caller_request_key": params["p_caller_request_key"],
            "intent": dict(intent),
        }

    def _rpc_read_billing_enrollment_transition_by_key_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        alias_key = (
            params["p_studio_id"],
            params["p_transition_kind"],
            params["p_caller_request_key"],
        )
        intent_id = self.billing_enrollment_transition_aliases.get(alias_key)
        if intent_id is None:
            raise _transition_not_found()
        intent = self.billing_enrollment_transition_intents[intent_id]
        if (
            intent["initiated_by"] != params["p_actor_id"]
            or intent["request_sha256"] != params["p_request_sha256"]
            or intent["enrollment_id"] != params["p_enrollment_id"]
        ):
            raise _transition_identity_mismatch()
        return {
            "outcome": "read",
            "requested_caller_request_key": params["p_caller_request_key"],
            "intent": dict(intent),
        }

    def _rpc_transition_billing_enrollment_transition_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        operation = self._operation_by_id(params["p_provider_operation_id"])
        state = operation["state"]
        if intent["transition_kind"] == "schedule_period_end" and state == "completed":
            intent["state"] = "scheduled"
        elif state == "definitive_failed":
            intent["state"] = "definitive_rejected"
        else:
            intent["state"] = state
        if params.get("p_provider_evidence_sha256") is not None:
            intent["provider_evidence_sha256"] = params["p_provider_evidence_sha256"]
        intent["revision"] += 1
        source_id = intent.get("source_intent_id")
        if state == "completed" and source_id:
            source = self.billing_enrollment_transition_intents[source_id]
            source["state"] = "revoked" if intent["transition_kind"] == "revoke_scheduled" else "completed"
            source["revision"] += 1
        return {"outcome": "transitioned", "intent": dict(intent)}

    def _rpc_revoke_billing_enrollment_transition_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        alias_key = (
            params["p_studio_id"],
            "revoke_scheduled",
            params["p_caller_request_key"],
        )
        existing_id = self.billing_enrollment_transition_aliases.get(alias_key)
        if existing_id:
            existing = self.billing_enrollment_transition_intents[existing_id]
            if (
                existing["initiated_by"] != params["p_actor_id"]
                or existing["request_sha256"] != params["p_request_sha256"]
                or existing["source_intent_id"] != params["p_intent_id"]
            ):
                raise _operation_conflict()
            operation = (
                self._operation_by_id(existing["provider_operation_id"])
                if existing.get("provider_operation_id")
                else None
            )
            return {
                "outcome": "replay",
                "intent": dict(existing),
                **({"operation": dict(operation)} if operation else {}),
            }
        source = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        intent_id = f"00000000-0000-4000-8000-{len(self.billing_enrollment_transition_intents) + 9701:012d}"
        operation = self._rpc_claim_billing_provider_operation_v1({
                "p_studio_id": params["p_studio_id"],
                "p_actor_id": params["p_actor_id"],
                "p_operation_type": "enrollment.cancel.period_end.revoke",
                "p_caller_request_key": params["p_caller_request_key"],
                "p_request_sha256": params["p_request_sha256"],
                "p_stripe_connected_account_id": source["stripe_connected_account_id"],
                "p_connect_account_generation": source["connect_account_generation"],
                "p_lease_owner": params["p_lease_owner"],
                "p_lease_seconds": params["p_lease_seconds"],
            })["operation"]
        intent = {
            **source,
            "id": intent_id,
            "source_intent_id": source["id"],
            "transition_kind": "revoke_scheduled",
            "request_sha256": params["p_request_sha256"],
            "provider_operation_id": operation and operation["id"],
            "provider_caller_request_key": operation and params["p_caller_request_key"],
            "provider_request_sha256": operation and params["p_request_sha256"],
            "initiated_by": params["p_actor_id"],
            "reason_code": params["p_reason_code"],
            "state": "due_claimed",
            "revision": 2,
        }
        self.billing_enrollment_transition_intents[intent_id] = intent
        self.billing_enrollment_transition_aliases[alias_key] = intent_id
        return {
            "outcome": "claimed",
            "intent": dict(intent),
            "operation": dict(operation),
        }

    def _rpc_claim_due_billing_enrollment_transitions_v1(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        results = []
        for source in list(self.billing_enrollment_transition_intents.values()):
            if source["transition_kind"] != "schedule_period_end":
                continue
            if source["state"] == "due_claimed":
                execute = next((candidate for candidate in self.billing_enrollment_transition_intents.values()
                    if candidate.get("source_intent_id") == source["id"]
                    and candidate.get("transition_kind") == "execute_due"
                    and candidate.get("state") == "due_claimed"), None)
                if execute is not None:
                    execute["lease_owner"] = params["p_worker_id"]
                    execute["revision"] += 1
                    if execute.get("provider_operation_id"):
                        operation = self._operation_by_id(execute["provider_operation_id"])
                        operation["lease_owner"] = params["p_worker_id"]
                        operation["revision"] += 1
                    results.append(dict(execute))
                continue
            if source["state"] != "scheduled":
                continue
            intent_id = f"00000000-0000-4000-8000-{len(self.billing_enrollment_transition_intents) + 9701:012d}"
            legacy_item_mutation = (
                source.get("mutation_strategy")
                == "subscription_item_delete_at_period_end"
                and source.get("provider_operation_id") is None
            )
            execute = {
                **source,
                "id": intent_id,
                "source_intent_id": source["id"],
                "transition_kind": "execute_due",
                "provider_operation_id": None,
                "provider_caller_request_key": (
                    f"enrollment-period-execute:{source['id']}"
                    if legacy_item_mutation
                    else None
                ),
                "provider_request_sha256": (
                    hashlib.sha256(
                        f"legacy-due:{source['id']}".encode()
                    ).hexdigest()
                    if legacy_item_mutation
                    else None
                ),
                "state": "due_claimed",
                "lease_owner": params["p_worker_id"],
                "revision": 1,
            }
            source["state"] = "due_claimed"
            source["revision"] += 1
            self.billing_enrollment_transition_intents[intent_id] = execute
            results.append(dict(execute))
            if len(results) >= params["p_limit"]:
                break
        return results

    def _rpc_start_due_billing_enrollment_transition_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        if intent["revision"] != params["p_expected_revision"] or intent.get("provider_operation_id"):
            raise AssertionError("due transition is not startable")
        operation = self._rpc_claim_billing_provider_operation_v1({
            "p_studio_id": intent["studio_id"],
            "p_actor_id": intent["initiated_by"],
            "p_operation_type": "enrollment.cancel.period_end.execute",
            "p_caller_request_key": intent["provider_caller_request_key"],
            "p_request_sha256": intent["provider_request_sha256"],
            "p_stripe_connected_account_id": intent["stripe_connected_account_id"],
            "p_connect_account_generation": intent["connect_account_generation"],
            "p_lease_owner": params["p_worker_id"],
            "p_lease_seconds": params["p_lease_seconds"],
        })["operation"]
        intent["provider_operation_id"] = operation["id"]
        intent["revision"] += 1
        return {"outcome": "started", "intent": dict(intent), "operation": dict(operation)}

    def _rpc_complete_due_billing_enrollment_transition_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        if intent["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale due transition revision")
        intent["state"] = "completed"
        intent["revision"] += 1
        source = self.billing_enrollment_transition_intents[intent["source_intent_id"]]
        source["state"] = "completed"
        source["revision"] += 1
        return {"outcome": "completed", "intent": dict(intent)}

    def _rpc_complete_due_billing_enrollment_item_transition_v31(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        canonical_mappings = sorted(
            params["p_item_transitions"], key=lambda row: row["old_item_id"]
        )
        completion_evidence = hashlib.sha256(
            json.dumps(
                {
                    "provider_evidence_sha256": params[
                        "p_provider_evidence_sha256"
                    ],
                    "item_transitions": canonical_mappings,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        source = self.billing_enrollment_transition_intents[intent["source_intent_id"]]
        if intent["state"] == "completed" and source["state"] == "completed":
            if (
                intent.get("provider_evidence_sha256") != completion_evidence
                or source.get("provider_evidence_sha256") != completion_evidence
            ):
                raise AssertionError("due item completion replay conflict")
            return {"outcome": "replay", "intent": dict(intent)}
        if intent["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale due item transition revision")
        target = next(
            row
            for row in self.tables["student_billing_enrollments"]
            if row["id"] == intent["enrollment_id"]
            and row["studio_id"] == params["p_studio_id"]
        )
        mappings = {
            row["old_item_id"]: row
            for row in params["p_item_transitions"]
        }
        old_target_id = intent["stripe_subscription_item_id"]
        if old_target_id not in mappings:
            raise AssertionError("target item transition mapping missing")
        for row in self.tables["student_billing_enrollments"]:
            if (
                row["id"] != target["id"]
                and row.get("studio_id") == params["p_studio_id"]
                and row.get("billing_subscription_id")
                == intent["billing_subscription_id"]
                and row.get("status") in {"pending", "active"}
                and row.get("stripe_subscription_item_id") in mappings
            ):
                replacement = mappings[row["stripe_subscription_item_id"]][
                    "new_item_id"
                ]
                if replacement is None:
                    raise AssertionError("surviving item transition mapping is null")
                row["stripe_subscription_item_id"] = replacement
        target.update({
            "status": "canceled",
            "billing_status": "unpaid",
            "billing_subscription_id": None,
            "stripe_subscription_id": None,
            "stripe_subscription_item_id": None,
        })
        intent.update({
            "state": "completed",
            "provider_evidence_sha256": completion_evidence,
            "revision": intent["revision"] + 1,
        })
        source.update({
            "state": "completed",
            "provider_evidence_sha256": completion_evidence,
            "revision": source["revision"] + 1,
        })
        return {"outcome": "completed", "intent": dict(intent)}

    def _rpc_read_billing_enrollment_item_schedule_identity_v31(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        source = (
            intent
            if intent.get("transition_kind") == "schedule_period_end"
            else self.billing_enrollment_transition_intents[intent["source_intent_id"]]
        )
        operation = self._operation_by_id(source["provider_operation_id"])
        steps = self.billing_provider_step_plans[operation["id"]]["steps"]
        update_step = steps[1]
        schedule_id = operation.get("provider_secondary_object_id")
        if (
            intent.get("studio_id") != params["p_studio_id"]
            or source.get("studio_id") != params["p_studio_id"]
            or source.get("transition_kind") != "schedule_period_end"
            or source.get("mutation_strategy")
            != "subscription_item_delete_at_period_end"
            or operation.get("operation_type")
            != "enrollment.cancel.period_end.schedule"
            or operation.get("state") not in {"provider_succeeded", "projected", "completed"}
            or operation.get("provider_object_id")
            != source.get("stripe_subscription_item_id")
            or not schedule_id
            or update_step.get("step_order") != 2
            or update_step.get("step_name") != "schedule_update"
            or update_step.get("state") != "provider_succeeded"
            or update_step.get("provider_secondary_object_id") != schedule_id
        ):
            raise AssertionError("item schedule identity mismatch")
        return {
            "outcome": "read",
            "schedule_identity": {
                "source_intent_id": source["id"],
                "provider_operation_id": operation["id"],
                "schedule_id": schedule_id,
            },
        }

    def _rpc_mark_billing_enrollment_due_readback_reconciliation_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        if intent["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale due reconciliation revision")
        intent.update({
            "state": "reconciliation_required",
            "provider_evidence_sha256": params["p_provider_evidence_sha256"],
            "reconciliation_reason_code": params["p_reconciliation_reason_code"],
            "revision": intent["revision"] + 1,
        })
        source = self.billing_enrollment_transition_intents[intent["source_intent_id"]]
        source.update({
            "state": "reconciliation_required",
            "provider_evidence_sha256": params["p_provider_evidence_sha256"],
            "reconciliation_reason_code": params["p_reconciliation_reason_code"],
            "revision": source["revision"] + 1,
        })
        return {"outcome": "reconciliation_required", "intent": dict(intent)}

    def _rpc_mark_billing_enrollment_due_pre_provider_reconciliation_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        intent = self.billing_enrollment_transition_intents[params["p_intent_id"]]
        if intent["revision"] != params["p_expected_revision"] or intent.get("provider_operation_id"):
            raise AssertionError("due transition is not pre-provider reconcilable")
        intent.update({
            "state": "reconciliation_required",
            "provider_evidence_sha256": params["p_provider_evidence_sha256"],
            "reconciliation_reason_code": params["p_reconciliation_reason_code"],
            "revision": intent["revision"] + 1,
        })
        source = self.billing_enrollment_transition_intents[intent["source_intent_id"]]
        source.update({
            "state": "reconciliation_required",
            "provider_evidence_sha256": params["p_provider_evidence_sha256"],
            "reconciliation_reason_code": params["p_reconciliation_reason_code"],
            "revision": source["revision"] + 1,
        })
        return {"outcome": "reconciliation_required", "intent": dict(intent)}

    def _rpc_register_billing_provider_operation_step_plan_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        existing = self.billing_provider_step_plans.get(operation["id"])
        if existing is not None:
            if existing["plan_sha256"] != params["p_plan_sha256"]:
                raise AssertionError("step plan conflict")
            return {
                "outcome": "replay",
                "operation": dict(operation),
                "steps": [dict(step) for step in existing["steps"]],
            }
        if operation["state"] != "started" or operation["revision"] != params["p_expected_parent_revision"]:
            raise AssertionError("parent is not registerable")
        steps = [
            {
                **step,
                "step_order": index,
                "state": "pending",
                "provider_request_attempt_count": 0,
                "provider_object_id": None,
                "provider_secondary_object_id": None,
                "provider_request_id": None,
                "result_code": None,
                "error_code": None,
                "reconciliation_reason_code": None,
                "revision": 1,
            }
            for index, step in enumerate(params["p_steps"], start=1)
        ]
        self.billing_provider_step_plans[operation["id"]] = {
            "plan_sha256": params["p_plan_sha256"],
            "steps": steps,
        }
        operation["revision"] += 1
        return {
            "outcome": "registered",
            "operation": dict(operation),
            "steps": [dict(step) for step in steps],
        }

    def _rpc_read_billing_provider_operation_step_plan_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        plan = self.billing_provider_step_plans.get(operation["id"])
        if plan is None or plan["plan_sha256"] != params["p_plan_sha256"]:
            raise AssertionError("step plan not found")
        return {
            "outcome": "read",
            "operation": dict(operation),
            "steps": [dict(step) for step in plan["steps"]],
        }

    def _rpc_claim_billing_provider_operation_step_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        step = self._step_for_params(operation, params)
        prior = self.billing_provider_step_plans[operation["id"]]["steps"][: step["step_order"] - 1]
        if any(candidate["state"] != "provider_succeeded" for candidate in prior):
            raise AssertionError("step predecessor is incomplete")
        state = step["state"]
        if state == "provider_succeeded":
            outcome = "replay"
        elif state == "provider_request_in_flight":
            outcome = "provider_request_in_flight"
        elif state == "reconciliation_required":
            outcome = "reconciliation_required"
        elif state in {"definitive_failed", "definitive_rejected"}:
            outcome = "replay"
        else:
            outcome = "claimed"
        return {"outcome": outcome, "operation": dict(operation), "step": dict(step)}

    def _rpc_transition_billing_provider_operation_step_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        step = self._step_for_params(operation, params)
        if step["revision"] != params["p_expected_step_revision"]:
            raise AssertionError("stale step revision")
        step["state"] = params["p_to_state"]
        if step["state"] == "provider_request_in_flight":
            step["provider_request_attempt_count"] += 1
        for field, param in (
            ("provider_object_id", "p_provider_object_id"),
            ("provider_secondary_object_id", "p_provider_secondary_object_id"),
            ("provider_request_id", "p_provider_request_id"),
            ("result_code", "p_result_code"),
            ("error_code", "p_error_code"),
            ("reconciliation_reason_code", "p_reconciliation_reason_code"),
        ):
            if params.get(param) is not None:
                step[field] = params[param]
        step["revision"] += 1
        if (
            operation.get("operation_type")
            == "enrollment.cancel.period_end.schedule"
            and step["state"] in {
                "reconciliation_required",
                "definitive_failed",
                "definitive_rejected",
            }
        ):
            operation.update({
                "state": "reconciliation_required",
                "reconciliation_reason_code": (
                    params.get("p_reconciliation_reason_code")
                    or "provider_step_phase_incomplete"
                ),
                "revision": operation["revision"] + 1,
            })
        return {"outcome": "transitioned", "operation": dict(operation), "step": dict(step)}

    def _rpc_complete_billing_provider_operation_provider_phase_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        plan = self.billing_provider_step_plans[operation["id"]]
        steps = plan["steps"]
        if (
            operation["state"] == "provider_succeeded"
            and operation.get("result_code") == "provider_step_phase_completed"
        ):
            return {
                "outcome": "replay",
                "operation": dict(operation),
                "steps": [dict(step) for step in steps],
            }
        if operation["revision"] != params["p_expected_parent_revision"]:
            raise AssertionError("stale provider phase parent revision")
        if all(step["state"] == "provider_succeeded" for step in steps):
            operation["state"] = "provider_succeeded"
            operation["provider_request_attempt_count"] = 1
            operation["provider_object_id"] = steps[-1]["provider_object_id"]
            operation["result_code"] = "provider_step_phase_completed"
            outcome = "completed"
        elif any(
            step["state"] in {
                "provider_request_in_flight",
                "reconciliation_required",
                "definitive_failed",
                "definitive_rejected",
            }
            for step in steps
        ):
            operation["state"] = "reconciliation_required"
            operation["reconciliation_reason_code"] = "provider_step_phase_incomplete"
            outcome = "reconciliation_required"
        else:
            outcome = "incomplete"
        operation["revision"] += 1
        return {
            "outcome": outcome,
            "operation": dict(operation),
            "steps": [dict(step) for step in steps],
        }

    def _rpc_complete_billing_provider_operation_provider_phase_v31(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        plan = self.billing_provider_step_plans[operation["id"]]
        steps = plan["steps"]
        final_step = steps[-1]
        if (
            operation["state"] == "provider_succeeded"
            and operation.get("result_code") == "provider_step_phase_completed"
        ):
            if (
                operation.get("provider_object_id")
                != final_step.get("provider_object_id")
                or operation.get("provider_secondary_object_id")
                != final_step.get("provider_secondary_object_id")
                or operation.get("lease_owner") != params["p_lease_owner"]
            ):
                raise AssertionError("provider phase replay identity mismatch")
            return {
                "outcome": "replay",
                "operation": dict(operation),
                "steps": [dict(step) for step in steps],
            }
        if operation["revision"] != params["p_expected_parent_revision"]:
            raise AssertionError("stale provider phase parent revision")
        if all(step["state"] == "provider_succeeded" for step in steps):
            operation["state"] = "provider_succeeded"
            operation["provider_request_attempt_count"] = 1
            operation["provider_object_id"] = final_step["provider_object_id"]
            operation["provider_secondary_object_id"] = final_step.get(
                "provider_secondary_object_id"
            )
            operation["lease_owner"] = params["p_lease_owner"]
            operation["result_code"] = "provider_step_phase_completed"
            outcome = "provider_succeeded"
        elif any(
            step["state"]
            in {
                "provider_request_in_flight",
                "reconciliation_required",
                "definitive_failed",
                "definitive_rejected",
            }
            for step in steps
        ):
            operation["state"] = "reconciliation_required"
            operation["reconciliation_reason_code"] = (
                "provider_step_phase_incomplete"
            )
            operation["lease_owner"] = None
            outcome = "reconciliation_required"
        else:
            outcome = "incomplete"
        operation["revision"] += 1
        return {
            "outcome": outcome,
            "operation": dict(operation),
            "steps": [dict(step) for step in steps],
        }

    def _rpc_authorize_billing_provider_operation_step_recovery_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        step = self._step_for_params(operation, params)
        step.update({
            "state": "recovery_authorized",
            "recovery_actor_id": params["p_recovery_actor_id"],
            "recovery_proof_sha256": params["p_recovery_proof_sha256"],
            "recovery_outcome": params["p_recovery_outcome"],
            "revision": step["revision"] + 1,
        })
        return {"outcome": "recovery_authorized", "operation": dict(operation), "step": dict(step)}

    def _operation_for_params(self, params: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_by_id(params["p_operation_id"])
        for field, param in (
            ("studio_id", "p_studio_id"),
            ("actor_id", "p_actor_id"),
            ("operation_type", "p_operation_type"),
            ("caller_request_key", "p_caller_request_key"),
            ("request_sha256", "p_request_sha256"),
            ("request_sha256", "p_parent_request_sha256"),
            ("stripe_connected_account_id", "p_stripe_connected_account_id"),
            ("connect_account_generation", "p_connect_account_generation"),
        ):
            if param in params and operation[field] != params[param]:
                raise AssertionError(f"operation identity mismatch: {field}")
        if (
            operation.get("operation_type") in {"invoice.finalize", "invoice.void"}
            and "p_lease_owner" in params
            and operation.get("lease_owner") != params["p_lease_owner"]
        ):
            raise AssertionError("operation identity mismatch: lease_owner")
        return operation

    def _operation_by_id(self, operation_id: str) -> dict[str, Any]:
        operation = next(
            (
                candidate
                for candidate in self.billing_provider_operations.values()
                if candidate["id"] == operation_id
            ),
            None,
        )
        if operation is None:
            raise AssertionError("operation not found")
        return operation

    @staticmethod
    def _assert_resource_request_matches(
        operation: dict[str, Any],
        params: dict[str, Any],
    ) -> None:
        if any(
            operation[field] != params[param]
            for field, param in (
                ("studio_id", "p_studio_id"),
                ("actor_id", "p_actor_id"),
                ("operation_type", "p_operation_type"),
                ("request_sha256", "p_request_sha256"),
                ("stripe_connected_account_id", "p_stripe_connected_account_id"),
                ("connect_account_generation", "p_connect_account_generation"),
            )
        ):
            raise _operation_conflict()

    def _step_for_params(
        self,
        operation: dict[str, Any],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        plan = self.billing_provider_step_plans.get(operation["id"])
        if plan is None or plan["plan_sha256"] != params["p_plan_sha256"]:
            raise AssertionError("step plan not found")
        step = next(
            (
                candidate
                for candidate in plan["steps"]
                if candidate["step_order"] == params["p_step_order"]
            ),
            None,
        )
        if step is None:
            raise AssertionError("step not found")
        return step
