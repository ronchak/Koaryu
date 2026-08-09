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
    for operation in MODULE.REQUIRED_MUTATION_OPERATIONS:
        mutations.append({
            "operation": operation,
            "studio_id": studio_id,
            "scope": MODULE.MUTATION_SCOPES[operation],
            "stripe_account_id": None if operation == "connect_account.create" else account_id,
            "automatic_retry_count": 0,
            "outcome": "succeeded",
            "idempotency_key": f"test:{operation}",
        })
    return {
        "schema_version": 2,
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
        mutation["idempotency_key"] = ""
        mutation["scope"] = "connect_payments"

        errors = self.errors(evidence)

        self.assertTrue(any("deterministic idempotency key" in error for error in errors))
        self.assertTrue(any("wrong authorization scope" in error for error in errors))

    def test_rejects_retry_unknown_outcome_and_missing_required_mutation(self):
        evidence = _valid_evidence()
        evidence["mutation_attempts"] = [
            mutation
            for mutation in evidence["mutation_attempts"]
            if mutation["operation"] != "connected_refund.create"
        ]
        evidence["mutation_attempts"][0]["automatic_retry_count"] = 1
        evidence["mutation_attempts"][0]["outcome"] = "unknown"

        errors = self.errors(evidence)

        self.assertTrue(any("connected_refund.create" in error for error in errors))
        self.assertTrue(any("retried" in error for error in errors))
        self.assertTrue(any("successful idempotency/event readback" in error for error in errors))

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


if __name__ == "__main__":
    unittest.main()
