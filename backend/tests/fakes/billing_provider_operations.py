from __future__ import annotations

import hashlib
import json
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
        self.billing_provider_operations = {}
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

    def _rpc_claim_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        key = (
            params["p_studio_id"],
            params["p_operation_type"],
            params["p_caller_request_key"],
        )
        operation = self.billing_provider_operations.get(key)
        if operation is None:
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
                "lease_expires_at": "2026-08-27T00:00:30Z",
                "provider_object_id": None,
                "provider_secondary_object_id": None,
                "provider_request_id": None,
                "result_code": None,
                "result_summary": None,
                "error_code": None,
                "error_summary": None,
                "reconciliation_reason_code": None,
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
        if state == "provider_request_in_flight":
            outcome = "provider_request_in_flight"
        elif state == "reconciliation_required":
            outcome = "reconciliation_required"
        elif state in {"completed", "definitive_failed", "definitive_rejected"}:
            outcome = "replay"
        else:
            outcome = "continued"
        return {"outcome": outcome, "operation": dict(operation)}

    def _rpc_claim_billing_provider_operation_resource_v1(
        self,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if params["p_operation_type"] in {
            "invoice.finalize",
            "invoice.retry",
            "invoice.void",
        }:
            return self._rpc_claim_billing_invoice_mutation_v31(params)
        return self._rpc_claim_billing_provider_operation_resource_unserialized(params)

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
        for owner in self.billing_invoice_mutation_owners.values():
            if (
                owner.get("studio_id") == consent.get("studio_id")
                and owner.get("payer_id") == consent.get("payer_id")
                and owner.get("operation_type") == "invoice.retry"
                and self._operation_by_id(owner["operation_id"]).get("state")
                in {
                    "started",
                    "provider_request_in_flight",
                    "recovery_authorized",
                }
            ):
                raise _invoice_mutation_in_progress()
        consent.update(updates)
        return dict(consent)

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
            if summary == "plan_sync_mode:product_update_only":
                matches = operation.get("provider_object_id") == plan.get("stripe_product_id")
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
        if payer.get("stripe_customer_id") != operation.get("provider_object_id"):
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
        return self._rpc_claim_billing_invoice_mutation_v31(params)

    def _rpc_transition_billing_provider_operation_v1(self, params: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_for_params(params)
        if operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation revision")
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
            raise AssertionError("active payer consent not found")
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
        operation.update({
            "state": "recovery_authorized",
            "recovery_actor_id": params["p_recovery_actor_id"],
            "recovery_proof_sha256": params["p_recovery_proof_sha256"],
            "recovery_outcome": params["p_recovery_outcome"],
            "lease_owner": params["p_lease_owner"],
            "revision": operation["revision"] + 1,
            "reconciliation_reason_code": None,
        })
        return {"outcome": "recovery_authorized", "operation": dict(operation)}

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
