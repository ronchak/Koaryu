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
        self.assertEqual(MODULE.validate_worksheet(WORKSHEET), [])
        self.assertEqual(MODULE.VALIDATOR.TOP_LEVEL_KEYS, VALIDATOR_MODULE.TOP_LEVEL_KEYS)

    def test_representative_schema_drift_fails(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        del template["mutation_attempts"][0]["caller_request_key_sha256"]
        template["webhook_event_ids"] = ["<LEGACY_GLOBAL_EVENT_ID>"]

        errors = MODULE.validate_template(template)

        self.assertTrue(any("top-level template" in error for error in errors))
        self.assertTrue(any("mutation" in error and "keys" in error for error in errors))

    def test_role_workflow_and_terminal_drift_fail(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        template["role_capabilities"]["instructor"] = ["payment.refund"]
        del template["workflow_facts"]["replacement_consent_id"]
        template["terminal_counts"]["counts"]["reconciliation_required"]["count"] = 1

        errors = MODULE.validate_template(template)

        self.assertTrue(any("Instructor" in error for error in errors))
        self.assertTrue(any("workflow facts" in error for error in errors))
        self.assertTrue(any("terminal count" in error for error in errors))

    def test_supplemental_and_inventory_drift_fail(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        del template["supplemental_evidence"]["invoice_void"]["provider_readback"]
        template["supplemental_evidence"]["immediate_cancellation"]["operation"] = "connected_subscription_item.delete"
        template["steps"].pop()
        template["mutation_attempts"].pop()

        errors = MODULE.validate_template(template)

        self.assertTrue(any("invoice void" in error and "keys" in error for error in errors))
        self.assertTrue(any("strategy and operation" in error for error in errors))
        self.assertTrue(any("exactly 15" in error for error in errors))
        self.assertTrue(any("exactly 24" in error for error in errors))

    def test_canonical_source_label_drift_fails(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        template["supplemental_evidence"]["invoice_void"]["provider_readback"]["source"] = "arbitrary.source"
        template["terminal_counts"]["counts"]["failed"]["source"] = "arbitrary.count"
        template["terminal_counts"]["wrong_mode_components"][0]["source"] = "arbitrary.provider"

        errors = MODULE.validate_template(template)

        self.assertTrue(any("invoice void provider readback" in error and "canonical" in error for error in errors))
        self.assertTrue(any("terminal count failed" in error for error in errors))
        self.assertTrue(any("wrong-mode provider component" in error for error in errors))

    def test_period_sentinel_and_replacement_instruction_drift_fail(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        period = template["supplemental_evidence"]["period_advancement"]
        self.assertEqual((period["advances_to"], period["observed_provider_boundary"]), (0, 0))
        period["advances_to"] = 1787936400
        period["observed_provider_boundary"] = 1787936400

        errors = MODULE.validate_template(template)

        self.assertTrue(any("zero non-live timestamp sentinels" in error for error in errors))
        worksheet_text = WORKSHEET.read_text()
        self.assertEqual(MODULE.validate_instructions(worksheet_text), [])
        self.assertTrue(MODULE.validate_instructions(
            worksheet_text.replace(MODULE.PERIOD_SENTINEL_INSTRUCTION, "")
        ))

    def test_core_order_drift_fails(self):
        template = copy.deepcopy(MODULE.load_template(WORKSHEET))
        template["steps"][0], template["steps"][1] = template["steps"][1], template["steps"][0]
        template["mutation_attempts"][0], template["mutation_attempts"][1] = template["mutation_attempts"][1], template["mutation_attempts"][0]
        errors = MODULE.validate_template(template)
        self.assertTrue(any("steps do not match the canonical" in error for error in errors))
        self.assertTrue(any("mutation rows do not match the canonical" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
