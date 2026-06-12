from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import BackgroundTasks, HTTPException, status

from app.api.v1.endpoints import billing as billing_endpoints
from app.api.v1.endpoints import students as student_endpoints
from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingPayerAutopaySetupRequest,
    BillingPayerCreate,
    BillingPayerUpdate,
    BillingPlanCreate,
    BillingPlanUpdate,
    BillingReconcileRequest,
    BillingRefundCreate,
    ConnectOnboardingLinkRequest,
    ExportJobCreate,
    ExternalPaymentCreate,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentForStudentCreate,
    StudentBillingEnrollmentUpdate,
)


def _front_desk_forbidden(*_args, **_kwargs):
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only studio admins can perform this billing action.",
    )


class BillingEndpointPermissionTest(unittest.TestCase):
    def assert_admin_required(self, coroutine_factory):
        with (
            patch("app.api.v1.endpoints.billing._admin_studio_id", side_effect=_front_desk_forbidden) as admin_studio,
            patch("app.api.v1.endpoints.billing._manager_studio_id", side_effect=AssertionError("write used manager resolver")),
            patch("app.api.v1.endpoints.billing.BillingService") as billing_service,
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(coroutine_factory())

        self.assertEqual(context.exception.status_code, 403)
        self.assertGreaterEqual(admin_studio.call_count, 1)
        billing_service.assert_not_called()

    def test_front_desk_cannot_use_billing_mutation_endpoints(self):
        cases = [
            (
                "create_connect_onboarding_link",
                lambda: billing_endpoints.create_connect_onboarding_link(
                    ConnectOnboardingLinkRequest(),
                    BackgroundTasks(),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "sync_connect_status",
                lambda: billing_endpoints.sync_connect_status(
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "reset_connect_account",
                lambda: billing_endpoints.reset_connect_account(
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_connect_dashboard_link",
                lambda: billing_endpoints.create_connect_dashboard_link(
                    BackgroundTasks(),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "get_billing_system_status",
                lambda: billing_endpoints.get_billing_system_status(
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "reconcile_billing_from_stripe",
                lambda: billing_endpoints.reconcile_billing_from_stripe(
                    BillingReconcileRequest(object_type="invoice", stripe_object_id="in_1"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_plan",
                lambda: billing_endpoints.create_plan(
                    BillingPlanCreate(name="Core", amount_cents=1000),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "update_plan",
                lambda: billing_endpoints.update_plan(
                    "plan_1",
                    BillingPlanUpdate(name="Core Updated"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "archive_plan",
                lambda: billing_endpoints.archive_plan(
                    "plan_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "sync_plan",
                lambda: billing_endpoints.sync_plan(
                    "plan_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_payer",
                lambda: billing_endpoints.create_payer(
                    BillingPayerCreate(display_name="Avery Parent"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "update_payer",
                lambda: billing_endpoints.update_payer(
                    "payer_1",
                    BillingPayerUpdate(phone="555-0100"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "sync_payer",
                lambda: billing_endpoints.sync_payer(
                    "payer_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_autopay_setup_link",
                lambda: billing_endpoints.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(terms_accepted=True),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "disable_autopay",
                lambda: billing_endpoints.disable_autopay(
                    "payer_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_enrollment",
                lambda: billing_endpoints.create_enrollment(
                    StudentBillingEnrollmentCreate(
                        student_id="student_1",
                        plan_id="plan_1",
                        payer_id="payer_1",
                    ),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "update_enrollment",
                lambda: billing_endpoints.update_enrollment(
                    "enrollment_1",
                    StudentBillingEnrollmentUpdate(collection_mode="invoice_link"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "pause_enrollment",
                lambda: billing_endpoints.pause_enrollment(
                    "enrollment_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "resume_enrollment",
                lambda: billing_endpoints.resume_enrollment(
                    "enrollment_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "cancel_enrollment",
                lambda: billing_endpoints.cancel_enrollment(
                    "enrollment_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_invoice",
                lambda: billing_endpoints.create_invoice(
                    BillingInvoiceCreate(payer_id="payer_1", amount_cents=1000),
                    request_idempotency_key="invoice-key",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "finalize_invoice",
                lambda: billing_endpoints.finalize_invoice(
                    "invoice_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "retry_invoice_payment",
                lambda: billing_endpoints.retry_invoice_payment(
                    "invoice_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "void_invoice",
                lambda: billing_endpoints.void_invoice(
                    "invoice_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "reconcile_invoice",
                lambda: billing_endpoints.reconcile_invoice(
                    "invoice_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "record_external_payment",
                lambda: billing_endpoints.record_external_payment(
                    ExternalPaymentCreate(
                        payer_id="payer_1",
                        amount_cents=1000,
                        external_method="cash",
                    ),
                    request_idempotency_key="payment-key",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "refund_payment",
                lambda: billing_endpoints.refund_payment(
                    "payment_1",
                    BillingRefundCreate(amount_cents=500),
                    request_idempotency_key="refund-key",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "create_export_job",
                lambda: billing_endpoints.create_export_job(
                    ExportJobCreate(export_type="billing_payments"),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
            (
                "get_export_job",
                lambda: billing_endpoints.get_export_job(
                    "export_1",
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ),
            ),
        ]

        for name, coroutine_factory in cases:
            with self.subTest(endpoint=name):
                self.assert_admin_required(coroutine_factory)

    def test_front_desk_can_still_use_billing_read_endpoint(self):
        service = AsyncMock()
        service.list_payers = AsyncMock(return_value=[])

        with (
            patch("app.api.v1.endpoints.billing._manager_studio_id", return_value="studio_1") as manager_studio,
            patch("app.api.v1.endpoints.billing._admin_studio_id", side_effect=AssertionError("read used admin resolver")),
            patch("app.api.v1.endpoints.billing.BillingService", return_value=service),
        ):
            result = asyncio.run(billing_endpoints.list_payers(
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

        self.assertEqual(result, [])
        manager_studio.assert_called_once()
        service.list_payers.assert_awaited_once_with("studio_1")

    def test_student_scoped_billing_enrollment_is_admin_only(self):
        with (
            patch(
                "app.api.v1.endpoints.students.resolve_billing_admin_staff_role_for_user",
                side_effect=_front_desk_forbidden,
            ) as admin_resolver,
            patch(
                "app.api.v1.endpoints.students.resolve_billing_manager_staff_role_for_user",
                side_effect=AssertionError("student billing write used manager resolver"),
            ),
            patch("app.api.v1.endpoints.students.BillingService") as billing_service,
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(student_endpoints.add_student_billing_enrollment(
                    "student_1",
                    StudentBillingEnrollmentForStudentCreate(
                        plan_id="plan_1",
                        payer_id="payer_1",
                    ),
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ))

        self.assertEqual(context.exception.status_code, 403)
        admin_resolver.assert_called_once()
        billing_service.assert_not_called()


if __name__ == "__main__":
    unittest.main()
