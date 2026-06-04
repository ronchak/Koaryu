import unittest

from pydantic import ValidationError

from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingInvoiceItemCreate,
    ConnectOnboardingLinkRequest,
    BillingPlanCreate,
    BillingPlanUpdate,
    BillingPayerAutopaySetupRequest,
    BillingPayerCreate,
    BillingPayerResponse,
    BillingPayerUpdate,
    BillingReconcileRequest,
    BillingRefundCreate,
    ExportJobCreate,
    ExternalPaymentCreate,
    PlatformCheckoutRequest,
    PlatformPortalRequest,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentForStudentCreate,
)


def payer_payload(**overrides):
    payload = {
        "id": "payer_1",
        "studio_id": "studio_1",
        "display_name": "Avery Parent",
        "created_at": "2026-05-24T12:00:00+00:00",
        "updated_at": "2026-05-24T12:00:00+00:00",
    }
    payload.update(overrides)
    return payload


class BillingPayerResponseTest(unittest.TestCase):
    def test_card_brand_aliases_to_card_payment_method_type(self):
        payer = BillingPayerResponse(**payer_payload(
            default_payment_method_id="pm_1",
            default_payment_method_brand="visa",
            default_payment_method_last4="4242",
        ))

        self.assertEqual(payer.stripe_payment_method_id, "pm_1")
        self.assertEqual(payer.stripe_payment_method_brand, "visa")
        self.assertEqual(payer.stripe_payment_method_last4, "4242")
        self.assertEqual(payer.stripe_payment_method_type, "card")

    def test_non_card_default_method_keeps_method_type_alias(self):
        payer = BillingPayerResponse(**payer_payload(
            default_payment_method_id="pm_link",
            default_payment_method_brand="link",
        ))

        self.assertEqual(payer.stripe_payment_method_brand, "link")
        self.assertEqual(payer.stripe_payment_method_type, "link")

    def test_explicit_payment_method_type_is_not_overwritten(self):
        payer = BillingPayerResponse(**payer_payload(
            default_payment_method_id="pm_bank",
            default_payment_method_brand="visa",
            stripe_payment_method_type="us_bank_account",
        ))

        self.assertEqual(payer.stripe_payment_method_type, "us_bank_account")


class BillingRequestSchemaTest(unittest.TestCase):
    def test_connect_onboarding_request_rejects_checkout_fields(self):
        with self.assertRaises(ValidationError) as context:
            ConnectOnboardingLinkRequest(success_url="https://app.koaryu.test/billing")

        self.assertIn("Extra inputs are not permitted", str(context.exception))

    def test_platform_checkout_request_rejects_connect_fields(self):
        with self.assertRaises(ValidationError) as context:
            PlatformCheckoutRequest(business_entity_type="individual")

        self.assertIn("Extra inputs are not permitted", str(context.exception))

    def test_platform_portal_request_accepts_only_return_url(self):
        request = PlatformPortalRequest(return_url="https://app.koaryu.test/billing")

        self.assertEqual(request.return_url, "https://app.koaryu.test/billing")

    def test_top_level_enrollment_create_requires_student_id(self):
        with self.assertRaises(ValidationError) as context:
            StudentBillingEnrollmentCreate(plan_id="plan_1", payer_id="payer_1")

        self.assertIn("student_id", str(context.exception))

    def test_student_scoped_enrollment_create_rejects_body_student_id(self):
        with self.assertRaises(ValidationError) as context:
            StudentBillingEnrollmentForStudentCreate(
                student_id="student_1",
                plan_id="plan_1",
                payer_id="payer_1",
            )

        self.assertIn("Extra inputs are not permitted", str(context.exception))

    def test_non_external_enrollment_requires_payer_id(self):
        with self.assertRaises(ValidationError) as context:
            StudentBillingEnrollmentCreate(
                student_id="student_1",
                plan_id="plan_1",
                collection_mode="invoice_link",
            )

        self.assertIn("Payer is required for Stripe billing enrollment.", str(context.exception))

    def test_external_enrollment_allows_missing_payer_id(self):
        enrollment = StudentBillingEnrollmentCreate(
            student_id="student_1",
            plan_id="plan_1",
            collection_mode="external",
        )

        self.assertEqual(enrollment.billing_plan_id, "plan_1")
        self.assertIsNone(enrollment.payer_id)

    def test_external_payment_requires_positive_amount(self):
        with self.assertRaises(ValidationError) as context:
            ExternalPaymentCreate(
                payer_id="payer_1",
                amount_cents=0,
                external_method="cash",
            )

        self.assertIn("greater than or equal to 1", str(context.exception))

    def test_external_payment_requires_payer_or_invoice_target(self):
        with self.assertRaises(ValidationError) as context:
            ExternalPaymentCreate(amount_cents=500, external_method="cash")

        self.assertIn("External payments must target a payer or invoice.", str(context.exception))

    def test_public_billing_mutation_schemas_reject_extra_fields(self):
        cases = [
            (BillingReconcileRequest, {"object_type": "invoice", "unexpected": True}),
            (BillingPlanCreate, {"name": "Core", "amount_cents": 1000, "unexpected": True}),
            (BillingPlanUpdate, {"name": "Core", "unexpected": True}),
            (BillingPayerCreate, {"display_name": "Avery", "unexpected": True}),
            (BillingPayerUpdate, {"phone": "555-0100", "unexpected": True}),
            (BillingPayerAutopaySetupRequest, {"terms_accepted": True, "unexpected": True}),
            (BillingInvoiceItemCreate, {"description": "Tuition", "amount_cents": 1000, "unexpected": True}),
            (BillingInvoiceCreate, {"payer_id": "payer_1", "amount_cents": 1000, "unexpected": True}),
            (ExternalPaymentCreate, {"payer_id": "payer_1", "amount_cents": 500, "external_method": "cash", "unexpected": True}),
            (ExportJobCreate, {"export_type": "billing_payments", "unexpected": True}),
            (BillingRefundCreate, {"amount_cents": 500, "unexpected": True}),
        ]

        for model, payload in cases:
            with self.subTest(model=model.__name__):
                with self.assertRaises(ValidationError) as context:
                    model.model_validate(payload)

                self.assertIn("Extra inputs are not permitted", str(context.exception))


if __name__ == "__main__":
    unittest.main()
