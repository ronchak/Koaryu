from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "verify-stripe-provider-rehearsal.py"
SPEC = importlib.util.spec_from_file_location("stripe_provider_rehearsal_validator", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SHA = "a" * 40
ORIGIN = "https://staging-api.example.invalid"


def _delivery(*, surface: str, event_id: str, event_type: str) -> dict:
    connect = surface == "connect"
    return {
        "surface": surface,
        "endpoint_url": f"{ORIGIN}/api/v1/webhooks/stripe/{surface}",
        "connect": connect,
        "event_id": event_id,
        "event_type": event_type,
        "studio_id": "studio_1",
        "stripe_account_id": "acct_Test1" if connect else None,
        "connect_account_generation": 1 if connect else None,
        "provider_delivery_status": "delivered",
        "provider_http_status": 200,
        "local_event_id": event_id,
        "local_processing_status": "processed",
    }


def _valid_evidence() -> dict:
    studio_id = "studio_1"
    account_id = "acct_Test1"
    steps = []
    for name in MODULE.REQUIRED_STEPS:
        step = {"name": name, "status": "pass"}
        if name != "health_exact_candidate":
            step["studio_id"] = studio_id
        step["stripe_account_id"] = (
            None if name == "health_exact_candidate" or name in MODULE.PLATFORM_SCOPED_STEPS
            else account_id
        )
        steps.append(step)
    mutations = []
    key_digest = "c" * 64
    for step_name, expected in MODULE.REQUIRED_MUTATIONS.items():
        workflow_id, operation, scope, actor_role, uses_account = expected
        mutations.append({
            "step_name": step_name,
            "workflow_id": workflow_id,
            "operation": operation,
            "actor_role": actor_role,
            "studio_id": studio_id,
            "scope": scope,
            "stripe_account_id": account_id if uses_account else None,
            "automatic_retry_count": 0,
            "provider_mutation_count": 1,
            "outcome": "reconciled" if step_name == "payer.customer_create" else "succeeded",
            "caller_request_key_sha256": key_digest if step_name == "payer.customer_create" else "d" * 64,
        })
    boundary = "2026-08-28T17:00:00Z"
    def readback(source: str, status: str) -> dict:
        return {"source": source, "status": status, "capture_boundary": boundary}
    return {
        "schema_version": 4,
        "candidate_sha": SHA,
        "health_commit_sha": SHA,
        "health_ready_url": f"{ORIGIN}/health/ready",
        "stripe_mode": "test",
        "livemode": False,
        "secrets_redacted": True,
        "financial_canary_performed": False,
        "studio_id": studio_id,
        "stripe_account_id": account_id,
        "connect_account_generation": 1,
        "role_capabilities": {"admin": MODULE.ADMIN_WORKFLOWS, "front_desk": MODULE.FRONT_DESK_WORKFLOWS, "instructor": []},
        "workflow_facts": {
            "product_id": "prod_Test1", "price_id": "price_Test1", "payer_id": "payer_1", "customer_id": "cus_Test1",
            "consent_payer_id": "payer_1", "setup_request_id": "setup_request_1", "consent_id": "consent_1",
            "setup_intent_id": "seti_Test1", "payment_method_id": "pm_Test1", "terms_version": "v1",
            "consent_accepted": True, "consent_completed": True, "duplicate_consent_completion_outcome": "replay",
            "student_ids": ["student_1", "student_2"], "subscription_id": "sub_Test1", "subscription_item_id": "si_Test1",
            "shared_provider_quantity": 2, "shared_local_active_count": 2,
            "invoice_link_id": "invoice_link_1", "invoice_link_stripe_id": "in_Link1",
            "invoice_link_finalized": True, "invoice_link_sent": True,
            "automatic_invoice_id": "invoice_auto_1", "automatic_payment_intent_id": "pi_Test1", "automatic_charge_id": "ch_Test1",
            "automatic_amount_cents": 10000, "application_fee_bps": 50, "provider_application_fee_cents": 50,
            "failed_payment_invoice_id": "invoice_failed_1",
            "failed_payment_retry_workflow": "invoice.retry", "failed_payment_retry_outcome": "succeeded", "failed_payment_retry_mutation_count": 1,
            "period_schedule_state": "scheduled", "period_revoke_state": "revoked", "period_due_state": "completed",
            "period_schedule_intent_id": "intent_schedule_1", "period_revoke_intent_id": "intent_revoke_1", "period_due_intent_id": "intent_due_1",
            "period_revoke_schedule_id": "sub_sched_Revoke1", "period_due_schedule_id": "sub_sched_Due1",
            "period_strategy": "subscription_schedule_shared_item_delete_at_period_end", "period_quantity_before": 2, "period_quantity_after": 1,
            "adjusted_payment_id": "payment_1", "refund_id": "re_Test1", "dispute_id": "dp_Test1",
            "gross_paid_cents": 10000, "refunded_cents": 1000, "disputed_cents": 0, "net_collected_cents": 9000,
            "refundable_remaining_cents": 9000, "invoice_remaining_before_cents": 0, "invoice_remaining_after_cents": 0,
            "payer_status_before": "current", "payer_status_after": "current", "adjustment_reconciliation_required": False,
            "ambiguous_mutation_step_name": "payer.customer_create", "ambiguous_caller_key_sha256": key_digest,
            "ambiguous_provider_mutation_count": 1, "ambiguous_automatic_retry_count": 0,
            "ambiguous_provider_readback_count": 1, "ambiguous_recovery_outcome": "reconciled", "ambiguous_final_state": "completed",
        },
        "supplemental_evidence": {
            "invoice_void": {"workflow_id": "invoice.void", "operation": "connected_invoice.void", "actor_role": "admin", "provider_attempt_count": 1, "provider_mutation_count": 1, "automatic_retry_count": 0, "caller_request_key_sha256": "f" * 64, "durable_operation_id": "operation_void_1", "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["invoice_void.provider"], "void"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["invoice_void.local"], "void")},
            "immediate_cancellation": {"workflow_id": "enrollment.cancel.immediate", "strategy": "whole_subscription_cancel", "operation": "connected_subscription.cancel", "actor_role": "admin", "provider_attempt_count": 1, "provider_mutation_count": 1, "automatic_retry_count": 0, "caller_request_key_sha256": "1" * 64, "durable_operation_id": "operation_cancel_1", "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["immediate_cancellation.provider"], "canceled"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["immediate_cancellation.local"], "canceled")},
            "external_payment": {"workflow_id": "payment.external.record", "local_payment_id": "payment_external_1", "local_status": "externally_recorded", "replay_payment_id": "payment_external_1", "caller_request_key_sha256": "e" * 64, "replay_outcome": "same_row", "audit_count": 1, "invoice_id": None, "provider_mutation_count": 0, "provider_operation_inventory_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["external_payment.inventory"], "zero"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["external_payment.local"], "externally_recorded")},
            "unsupported_operations": [
                {"subject": subject, "classification": "unsupported", "denial_reason_code": reason, "provider_mutation_count": 0, "denial_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["unsupported.denial"], "denied"), "provider_operation_inventory_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["unsupported.inventory"], "zero")}
                for subject, reason in MODULE.UNSUPPORTED_CONTRACT.items()
            ],
            "failed_payment_retry": {"workflow_id": "invoice.retry", "operation": "connected_invoice.pay", "failed_provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_provider"], "failed"), "failed_local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_local"], "failed"), "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["failed_payment_retry.provider"], "paid"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["failed_payment_retry.local"], "succeeded")},
            "period_advancement": {"method": "stripe_test_clock.advance", "test_clock_id": "clock_Test1", "advances_to": 1787936400, "observed_provider_boundary": 1787936400, "direct_database_timestamp_edit": False, "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["period_advancement.provider"], "advanced"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["period_advancement.local"], "completed")},
            "dispute_lifecycle": {"dispute_id": "dp_Test1", "created_event": {"event_id": "evt_disputeCreated1", "event_type": "charge.dispute.created", "local_event_id": "evt_disputeCreated1", "local_processing_status": "processed"}, "closed_event": {"event_id": "evt_disputeClosed1", "event_type": "charge.dispute.closed", "local_event_id": "evt_disputeClosed1", "local_processing_status": "processed"}, "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["dispute.provider"], "won"), "local_readback": {"source": MODULE.SUPPLEMENTAL_SOURCES["dispute.local"], "status": "won", "state_category": "won", "capture_boundary": boundary}},
            "ambiguity_recovery": {"workflow_id": "payer.sync", "durable_operation_id": "operation_1", "durable_step_id": "step_1", "provider_mutation_count": 1, "automatic_retry_count": 0, "caller_request_key_sha256": key_digest, "mutation_step_name": "payer.customer_create", "provider_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["ambiguity.provider"], "found"), "local_readback": readback(MODULE.SUPPLEMENTAL_SOURCES["ambiguity.local"], "completed")},
        },
        "terminal_counts": {"capture_boundary": boundary, "counts": {key: {"count": 0, "source": MODULE.TERMINAL_SOURCES[key], "readback_boundary": boundary} for key in MODULE.TERMINAL_COUNT_KEYS}, "wrong_mode_components": [{"surface": surface, "count": 0, "source": MODULE.WRONG_MODE_SOURCES[surface], "readback_boundary": boundary} for surface in ("provider", "local")]},
        "steps": steps,
        "mutation_attempts": mutations,
        "webhook_delivery_evidence": {
            "platform": _delivery(
                surface="platform",
                event_id="evt_platform1",
                event_type="customer.subscription.updated",
            ),
            "connect": _delivery(
                surface="connect",
                event_id="evt_connect1",
                event_type="account.updated",
            ),
        },
    }


class StripeProviderRehearsalValidatorTest(unittest.TestCase):
    def errors(self, evidence: dict, *, origin: str = ORIGIN) -> list[str]:
        return MODULE.validate_evidence(evidence, SHA, origin)

    def test_accepts_complete_sanitized_exact_candidate_test_evidence(self):
        self.assertEqual(self.errors(_valid_evidence()), [])

    def test_role_capability_contract_includes_supplemental_supported_workflows(self):
        self.assertIn("invoice.void", MODULE.ADMIN_WORKFLOWS)
        self.assertIn("payment.external.record", MODULE.ADMIN_WORKFLOWS)
        self.assertIn("payment.external.record", MODULE.FRONT_DESK_WORKFLOWS)
        self.assertNotIn("invoice.void", MODULE.FRONT_DESK_WORKFLOWS)

    def test_rejects_legacy_flat_or_missing_endpoint_surfaces(self):
        for deliveries in (
            None,
            {"platform": _valid_evidence()["webhook_delivery_evidence"]["platform"]},
            {"connect": _valid_evidence()["webhook_delivery_evidence"]["connect"]},
        ):
            with self.subTest(deliveries=deliveries):
                evidence = _valid_evidence()
                evidence.pop("webhook_delivery_evidence")
                evidence["webhook_event_ids"] = ["evt_legacy"]
                if deliveries is not None:
                    evidence["webhook_delivery_evidence"] = deliveries
                self.assertTrue(any("distinct platform and Connect" in error for error in self.errors(evidence)))

    def test_rejects_wrong_endpoint_flag_and_event_contract(self):
        evidence = _valid_evidence()
        platform = evidence["webhook_delivery_evidence"]["platform"]
        platform["endpoint_url"] = f"{ORIGIN}/api/v1/webhooks/stripe/connect"
        platform["connect"] = True
        platform["event_type"] = "account.updated"

        errors = self.errors(evidence)

        self.assertTrue(any("pinned endpoint URL" in error for error in errors))
        self.assertTrue(any("Connect delivery flag" in error for error in errors))
        self.assertTrue(any("endpoint contract" in error for error in errors))

    def test_rejects_provider_only_local_only_and_duplicate_event_proof(self):
        evidence = _valid_evidence()
        platform = evidence["webhook_delivery_evidence"]["platform"]
        connect = evidence["webhook_delivery_evidence"]["connect"]
        platform["provider_delivery_status"] = "pending"
        platform["provider_http_status"] = 500
        connect["local_event_id"] = "evt_different"
        connect["local_processing_status"] = "processing"
        connect["event_id"] = platform["event_id"]

        errors = self.errors(evidence)

        self.assertTrue(any("provider delivery success" in error for error in errors))
        self.assertTrue(any("provider-observed 2xx" in error for error in errors))
        self.assertTrue(any("local readback does not match" in error for error in errors))
        self.assertTrue(any("not fully processed" in error for error in errors))
        self.assertTrue(any("must be unique" in error for error in errors))

    def test_rejects_wrong_platform_and_connect_account_context(self):
        evidence = _valid_evidence()
        evidence["webhook_delivery_evidence"]["platform"]["stripe_account_id"] = "acct_Test1"
        evidence["webhook_delivery_evidence"]["connect"]["stripe_account_id"] = "acct_other"
        evidence["webhook_delivery_evidence"]["connect"]["connect_account_generation"] = 2

        errors = self.errors(evidence)

        self.assertTrue(any("platform account context" in error for error in errors))
        self.assertTrue(any("rehearsal account" in error for error in errors))
        self.assertTrue(any("account generation" in error for error in errors))

    def test_platform_step_is_not_forced_to_connected_account_scope(self):
        evidence = _valid_evidence()
        platform_step = next(
            step for step in evidence["steps"]
            if step["name"] == "platform_webhook_delivery_readback"
        )
        self.assertIsNone(platform_step["stripe_account_id"])
        self.assertEqual(self.errors(evidence), [])

        platform_step["stripe_account_id"] = "acct_Test1"
        self.assertTrue(any("platform account context" in error for error in self.errors(evidence)))

    def test_rejects_missing_initial_link_idempotency_and_wrong_scope(self):
        evidence = _valid_evidence()
        mutation = next(
            row for row in evidence["mutation_attempts"]
            if row["operation"] == "connect_onboarding_link.create"
        )
        mutation["caller_request_key_sha256"] = ""
        mutation["scope"] = "connect_payments"

        errors = self.errors(evidence)

        self.assertTrue(any("caller-key digest" in error for error in errors))
        self.assertTrue(any("exact workflow contract" in error for error in errors))

    def test_rejects_retry_unknown_outcome_and_missing_required_mutation(self):
        evidence = _valid_evidence()
        evidence["mutation_attempts"] = [
            mutation
            for mutation in evidence["mutation_attempts"]
            if mutation["step_name"] != "payment.refund"
        ]
        evidence["mutation_attempts"][0]["automatic_retry_count"] = 1
        evidence["mutation_attempts"][0]["outcome"] = "unknown"

        errors = self.errors(evidence)

        self.assertTrue(any("schema-v4 workflow plan" in error for error in errors))
        self.assertTrue(any("retried" in error for error in errors))
        self.assertTrue(any("successful idempotency/event readback" in error for error in errors))

    def test_rejects_missing_retried_or_misattributed_schedule_lifecycle_mutations(self):
        for step_name in (
            "period_end.revoke_schedule_create",
            "period_end.revoke_schedule_update",
            "period_end.revoke_release",
            "period_end.due_schedule_create",
            "period_end.due_schedule_update",
            "period_end.due_release",
        ):
            with self.subTest(step_name=step_name):
                evidence = _valid_evidence()
                mutation = next(
                    row for row in evidence["mutation_attempts"]
                    if row["step_name"] == step_name
                )
                mutation["automatic_retry_count"] = 1
                mutation["workflow_id"] = "enrollment.cancel.period_end.schedule"
                errors = self.errors(evidence)
                self.assertTrue(any("retried" in error for error in errors))
                if step_name in {"period_end.revoke_release", "period_end.due_release"}:
                    self.assertTrue(any("exact workflow contract" in error for error in errors))

                evidence = _valid_evidence()
                evidence["mutation_attempts"] = [
                    row for row in evidence["mutation_attempts"]
                    if row["step_name"] != step_name
                ]
                self.assertTrue(any("schema-v4 workflow plan" in error for error in self.errors(evidence)))
    def test_rejects_wrong_candidate_mode_origin_and_live_financial_claim(self):
        evidence = _valid_evidence()
        evidence["health_commit_sha"] = "b" * 40
        evidence["stripe_mode"] = "live"
        evidence["livemode"] = True
        evidence["financial_canary_performed"] = True

        errors = self.errors(evidence, origin="https://different.example.invalid")

        self.assertTrue(any("exact candidate SHA" in error for error in errors))
        self.assertTrue(any("test mode" in error for error in errors))
        self.assertTrue(any("live financial canary" in error for error in errors))
        self.assertTrue(any("pinned readiness URL" in error for error in errors))

    def test_rejects_ambiguous_expected_origin_before_evidence(self):
        self.assertEqual(
            self.errors(_valid_evidence(), origin="https://user@example.invalid/path"),
            ["expected backend origin must be one exact HTTPS origin"],
        )

    def test_rejects_extra_payload_or_secret_shaped_fields(self):
        evidence = _valid_evidence()
        evidence["provider_payload"] = {"client_secret": "redacted-is-not-proof"}
        evidence["mutation_attempts"][0]["request_body"] = {"unexpected": True}

        errors = self.errors(evidence)

        self.assertTrue(any("exact sanitized schema fields" in error for error in errors))
        self.assertTrue(any("mutation evidence must contain only" in error for error in errors))

    def test_rejects_role_consent_quantity_fee_and_period_drift(self):
        evidence = _valid_evidence()
        evidence["role_capabilities"]["instructor"] = ["payment.refund"]
        facts = evidence["workflow_facts"]
        facts["duplicate_consent_completion_outcome"] = "completed"
        facts["shared_provider_quantity"] = 1
        facts["provider_application_fee_cents"] = 49
        facts["period_due_state"] = "reconciliation_required"

        errors = self.errors(evidence)

        self.assertTrue(any("Instructor capabilities" in error for error in errors))
        self.assertTrue(any("duplicate completion replay" in error for error in errors))
        self.assertTrue(any("quantity two" in error for error in errors))
        self.assertTrue(any("50 bps" in error for error in errors))
        self.assertTrue(any("period-end schedule" in error for error in errors))

    def test_rejects_accounting_ambiguity_and_terminal_nonzero_state(self):
        evidence = _valid_evidence()
        facts = evidence["workflow_facts"]
        facts["net_collected_cents"] = 8999
        facts["invoice_remaining_after_cents"] = 1
        facts["ambiguous_provider_mutation_count"] = 2
        facts["ambiguous_automatic_retry_count"] = 1
        evidence["terminal_counts"]["counts"]["wrong_generation"]["count"] = 1

        errors = self.errors(evidence)

        self.assertTrue(any("gross and refundable" in error for error in errors))
        self.assertTrue(any("invoice receivable" in error for error in errors))
        self.assertTrue(any("one mutation and zero retries" in error for error in errors))
        self.assertTrue(any("terminal count wrong_generation" in error for error in errors))

    def test_rejects_missing_extra_and_contradictory_supplemental_fields(self):
        evidence = _valid_evidence()
        del evidence["supplemental_evidence"]["invoice_void"]["local_readback"]
        evidence["supplemental_evidence"]["external_payment"]["provider_payload"] = {}
        evidence["supplemental_evidence"]["external_payment"]["replay_payment_id"] = "payment_other"
        errors = self.errors(evidence)
        self.assertTrue(any("invoice void evidence" in error and "exact" in error for error in errors))
        self.assertTrue(any("external payment evidence" in error and "exact" in error for error in errors))

    def test_rejects_nonzero_unsourced_and_mismatched_terminal_counts(self):
        evidence = _valid_evidence()
        rows = evidence["terminal_counts"]["counts"]
        rows["failed"]["count"] = 1
        rows["stuck"]["source"] = ""
        rows["unmapped"]["readback_boundary"] = "stale-boundary"
        errors = self.errors(evidence)
        for name in ("failed", "stuck", "unmapped"):
            self.assertTrue(any(f"terminal count {name}" in error for error in errors))
        evidence = _valid_evidence()
        evidence["terminal_counts"]["wrong_mode_components"][0]["count"] = 1
        self.assertTrue(any("wrong-mode provider component" in error for error in self.errors(evidence)))

    def test_rejects_wrong_strategy_direct_timestamp_edit_and_missing_dispute_closure(self):
        evidence = _valid_evidence()
        evidence["supplemental_evidence"]["immediate_cancellation"]["strategy"] = "generic_cancel"
        evidence["supplemental_evidence"]["period_advancement"]["direct_database_timestamp_edit"] = True
        evidence["supplemental_evidence"]["dispute_lifecycle"]["closed_event"]["event_type"] = None
        errors = self.errors(evidence)
        self.assertTrue(any("wrong strategy or operation" in error for error in errors))
        self.assertTrue(any("direct database timestamp" in error for error in errors))
        self.assertTrue(any("created-to-closed" in error for error in errors))

    def test_rejects_noncanonical_sources_and_malformed_boundary(self):
        evidence = _valid_evidence()
        evidence["supplemental_evidence"]["invoice_void"]["provider_readback"]["source"] = "arbitrary.source"
        evidence["terminal_counts"]["counts"]["failed"]["source"] = "arbitrary.count"
        evidence["terminal_counts"]["wrong_mode_components"][0]["source"] = "arbitrary.provider"
        evidence["terminal_counts"]["capture_boundary"] = "2026-08-28 17:00:00"
        errors = self.errors(evidence)
        self.assertTrue(any("canonical source" in error for error in errors))
        self.assertTrue(any("terminal count failed" in error for error in errors))
        self.assertTrue(any("wrong-mode provider component" in error for error in errors))
        self.assertTrue(any("UTC RFC3339" in error for error in errors))

    def test_rejects_duplicate_mismatched_unprocessed_dispute_events_and_wrong_terminal(self):
        evidence = _valid_evidence()
        dispute = evidence["supplemental_evidence"]["dispute_lifecycle"]
        dispute["closed_event"]["event_id"] = dispute["created_event"]["event_id"]
        dispute["closed_event"]["local_event_id"] = "evt_other"
        dispute["created_event"]["local_processing_status"] = "processing"
        dispute["provider_readback"]["status"] = "closed"
        dispute["local_readback"]["status"] = "closed"
        dispute["local_readback"]["state_category"] = "active"
        errors = self.errors(evidence)
        self.assertTrue(any("created-to-closed" in error for error in errors))
        self.assertTrue(any("provider readback has the wrong status" in error for error in errors))
        self.assertTrue(any("canonical won status" in error for error in errors))

    def test_rejects_unbound_mutation_inventory_retry_and_period_evidence(self):
        evidence = _valid_evidence()
        supplemental = evidence["supplemental_evidence"]
        supplemental["invoice_void"]["caller_request_key_sha256"] = "raw-key"
        supplemental["immediate_cancellation"]["durable_operation_id"] = ""
        supplemental["external_payment"]["provider_operation_inventory_readback"]["status"] = "one"
        supplemental["unsupported_operations"][0]["provider_operation_inventory_readback"]["status"] = "one"
        supplemental["failed_payment_retry"]["failed_provider_readback"]["status"] = "paid"
        supplemental["period_advancement"]["observed_provider_boundary"] += 1
        supplemental["ambiguity_recovery"]["caller_request_key_sha256"] = "2" * 64
        errors = self.errors(evidence)
        self.assertTrue(any("invoice void evidence" in error for error in errors))
        self.assertTrue(any("wrong strategy or operation" in error for error in errors))
        self.assertGreaterEqual(sum("wrong status" in error for error in errors), 3)
        self.assertTrue(any("test-clock advancement" in error for error in errors))
        self.assertTrue(any("does not bind workflow facts" in error for error in errors))

    def test_private_validator_rejects_period_timestamp_sentinels(self):
        evidence = _valid_evidence()
        period = evidence["supplemental_evidence"]["period_advancement"]
        period["advances_to"] = 0
        period["observed_provider_boundary"] = 0

        self.assertTrue(any(
            "test-clock advancement" in error for error in self.errors(evidence)
        ))

    def test_rejects_provider_activity_for_external_and_unsupported_cases(self):
        evidence = _valid_evidence()
        evidence["supplemental_evidence"]["external_payment"]["provider_mutation_count"] = 1
        evidence["supplemental_evidence"]["unsupported_operations"][0]["provider_mutation_count"] = 1
        errors = self.errors(evidence)
        self.assertTrue(any("external payment" in error and "no invoice or provider mutation" in error for error in errors))
        self.assertTrue(any("unsupported operation" in error and "provider activity" in error for error in errors))

    def test_rejects_secret_url_and_card_values_in_supplemental_evidence(self):
        for value in ("https://setup.example.invalid/private", "sk_test_sensitive", "4242 4242 4242 4242"):
            with self.subTest(value=value):
                evidence = _valid_evidence()
                evidence["supplemental_evidence"]["external_payment"]["local_payment_id"] = value
                evidence["supplemental_evidence"]["external_payment"]["replay_payment_id"] = value
                self.assertTrue(any("raw URL, secret, or payment-card" in error for error in self.errors(evidence)))

    def test_rejects_stale_supplemental_readback_boundary_and_missing_ambiguity_owner(self):
        evidence = _valid_evidence()
        evidence["supplemental_evidence"]["failed_payment_retry"]["provider_readback"]["capture_boundary"] = "stale-boundary"
        evidence["supplemental_evidence"]["ambiguity_recovery"]["durable_step_id"] = ""
        errors = self.errors(evidence)
        self.assertTrue(any("shared capture boundary" in error for error in errors))
        self.assertTrue(any("durable operation and step" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
