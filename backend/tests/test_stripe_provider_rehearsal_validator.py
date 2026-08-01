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


def _valid_evidence() -> dict:
    studio_id = "studio_1"
    account_id = "acct_test_1"
    steps = [
        {
            "name": name,
            "status": "pass",
            "studio_id": studio_id,
            **({} if name == "health_exact_candidate" else {"stripe_account_id": account_id}),
        }
        for name in MODULE.REQUIRED_STEPS
    ]
    mutations = []
    for operation in MODULE.REQUIRED_MUTATION_OPERATIONS:
        mutation = {
            "operation": operation,
            "studio_id": studio_id,
            "scope": "connect_onboarding" if operation.startswith("connect_") else "connect_payments",
            "stripe_account_id": None if operation == "connect_account.create" else account_id,
            "automatic_retry_count": 0,
            "outcome": "succeeded",
        }
        if operation not in MODULE.MUTATIONS_WITHOUT_IDEMPOTENCY_KEY:
            mutation["idempotency_key"] = f"test:{operation}"
        mutations.append(mutation)
    return {
        "candidate_sha": SHA,
        "health_commit_sha": SHA,
        "stripe_mode": "test",
        "livemode": False,
        "secrets_redacted": True,
        "financial_canary_performed": False,
        "steps": steps,
        "mutation_attempts": mutations,
        "webhook_event_ids": ["evt_test_1", "evt_test_2"],
    }


class StripeProviderRehearsalValidatorTest(unittest.TestCase):
    def test_accepts_complete_sanitized_exact_candidate_test_evidence(self):
        self.assertEqual(MODULE.validate_evidence(_valid_evidence(), SHA), [])

    def test_rejects_retry_unknown_outcome_and_missing_required_mutation(self):
        evidence = _valid_evidence()
        evidence["mutation_attempts"] = [
            mutation
            for mutation in evidence["mutation_attempts"]
            if mutation["operation"] != "connected_refund.create"
        ]
        evidence["mutation_attempts"][0]["automatic_retry_count"] = 1
        evidence["mutation_attempts"][0]["outcome"] = "unknown"

        errors = MODULE.validate_evidence(evidence, SHA)

        self.assertTrue(any("connected_refund.create" in error for error in errors))
        self.assertTrue(any("retried" in error for error in errors))
        self.assertTrue(any("successful idempotency/event readback" in error for error in errors))

    def test_rejects_wrong_candidate_mode_and_duplicate_webhook_ids(self):
        evidence = _valid_evidence()
        evidence["health_commit_sha"] = "b" * 40
        evidence["stripe_mode"] = "live"
        evidence["livemode"] = True
        evidence["webhook_event_ids"] = ["evt_duplicate", "evt_duplicate"]

        errors = MODULE.validate_evidence(evidence, SHA)

        self.assertTrue(any("exact candidate SHA" in error for error in errors))
        self.assertTrue(any("test mode" in error for error in errors))
        self.assertTrue(any("present and unique" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
