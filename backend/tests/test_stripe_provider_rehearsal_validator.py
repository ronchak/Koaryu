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
        "terminal_counts": {key: 0 for key in MODULE.TERMINAL_COUNT_KEYS},
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
        evidence["terminal_counts"]["wrong_generation"] = 1

        errors = self.errors(evidence)

        self.assertTrue(any("gross and refundable" in error for error in errors))
        self.assertTrue(any("invoice receivable" in error for error in errors))
        self.assertTrue(any("one mutation and zero retries" in error for error in errors))
        self.assertTrue(any("terminal counts" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
