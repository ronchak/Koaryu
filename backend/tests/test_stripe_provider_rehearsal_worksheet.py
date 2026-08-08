from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CHECKER = ROOT / "scripts" / "check-stripe-provider-rehearsal-worksheet.py"
VALIDATOR = ROOT / "scripts" / "verify-stripe-provider-rehearsal.py"
WORKSHEET = ROOT / "docs" / "stripe-test-provider-rehearsal-capture.md"
SPEC = importlib.util.spec_from_file_location("stripe_provider_rehearsal_worksheet_checker", CHECKER)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
VALIDATOR_SPEC = importlib.util.spec_from_file_location("stripe_provider_rehearsal_validator", VALIDATOR)
assert VALIDATOR_SPEC and VALIDATOR_SPEC.loader
VALIDATOR_MODULE = importlib.util.module_from_spec(VALIDATOR_SPEC)
VALIDATOR_SPEC.loader.exec_module(VALIDATOR_MODULE)


class StripeProviderRehearsalWorksheetTest(unittest.TestCase):
    def test_template_matches_validator_source(self):
        self.assertEqual(MODULE.validate_template(MODULE.load_template(WORKSHEET)), [])
        self.assertEqual(MODULE.VALIDATOR.TOP_LEVEL_KEYS, VALIDATOR_MODULE.TOP_LEVEL_KEYS)

    def test_representative_schema_drift_fails(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        del template["mutation_attempts"][0]["idempotency_key"]
        template["webhook_event_ids"] = ["<LEGACY_GLOBAL_EVENT_ID>"]

        errors = MODULE.validate_template(template)

        self.assertTrue(any("top-level template" in error for error in errors))
        self.assertTrue(any("mutation" in error and "keys" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
