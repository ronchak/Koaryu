from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import BackgroundTasks, FastAPI, HTTPException, status
from fastapi.testclient import TestClient

from app.api.v1.endpoints import billing as billing_endpoints
from app.api.v1.endpoints import students as student_endpoints
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.main import app
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
    def test_invoice_retry_idempotency_header_is_required_and_length_bounded_in_openapi(self):
        operation = app.openapi()["paths"]["/api/v1/billing/invoices/{invoice_id}/retry"]["post"]
        header = next(
            parameter
            for parameter in operation["parameters"]
            if parameter["in"] == "header" and parameter["name"] == "Idempotency-Key"
        )

        self.assertTrue(header["required"])
        self.assertEqual(header["schema"]["minLength"], 1)
        self.assertEqual(header["schema"]["maxLength"], 255)

    def assert_admin_required(self, coroutine_factory):
        with (
            patch("app.api.v1.endpoints.billing._admin_studio_id", side_effect=_front_desk_forbidden) as admin_studio,
            patch("app.api.v1.endpoints.billing._manager_studio_id", side_effect=AssertionError("write used manager resolver")),
            patch("app.api.v1.endpoints.billing._routine_studio_id", side_effect=AssertionError("admin action used routine resolver")),
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
                    request_idempotency_key="invoice-retry-key",
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

    def test_retry_invoice_propagates_request_idempotency_key(self):
        with (
            patch("app.api.v1.endpoints.billing._admin_studio_id", return_value="studio_1"),
            patch("app.api.v1.endpoints.billing.BillingService") as billing_service,
        ):
            billing_service.return_value.retry_invoice_payment = AsyncMock(return_value={"id": "invoice_1"})

            response = asyncio.run(billing_endpoints.retry_invoice_payment(
                "invoice_1",
                request_idempotency_key="client-operation-1",
                user_id="admin_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

        self.assertEqual(response, {"id": "invoice_1"})
        billing_service.return_value.retry_invoice_payment.assert_awaited_once_with(
            "invoice_1",
            "studio_1",
            "admin_1",
            "client-operation-1",
        )

    def test_retry_invoice_preserves_safe_definitive_payment_status_for_client(self):
        safe_error = HTTPException(
            status_code=402,
            detail="Stripe declined the invoice payment. Review the payer payment method and retry.",
        )
        with (
            patch("app.api.v1.endpoints.billing._admin_studio_id", return_value="studio_1"),
            patch("app.api.v1.endpoints.billing.BillingService") as billing_service,
        ):
            billing_service.return_value.retry_invoice_payment = AsyncMock(side_effect=safe_error)
            with self.assertRaises(HTTPException) as response:
                asyncio.run(billing_endpoints.retry_invoice_payment(
                    "invoice_1",
                    request_idempotency_key="declined-operation",
                    user_id="admin_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ))

        self.assertEqual(response.exception.status_code, 402)
        self.assertEqual(response.exception.detail, safe_error.detail)

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

    def test_front_desk_can_use_only_the_named_routine_billing_writes(self):
        service = AsyncMock()
        service.add_student_billing_enrollment = AsyncMock(return_value={"id": "enrollment_1"})
        service.record_external_payment = AsyncMock(return_value={"id": "payment_1"})
        service.reconcile_invoice = AsyncMock(return_value={"id": "invoice_1"})

        enrollment = StudentBillingEnrollmentCreate(
            student_id="student_1",
            plan_id="plan_1",
            collection_mode="external",
        )
        payment = ExternalPaymentCreate(
            payer_id="payer_1",
            amount_cents=1000,
            external_method="cash",
        )
        with (
            patch("app.api.v1.endpoints.billing._routine_studio_id", return_value="studio_1") as routine_studio,
            patch("app.api.v1.endpoints.billing._admin_studio_id", side_effect=AssertionError("routine action used admin resolver")),
            patch("app.api.v1.endpoints.billing.BillingService", return_value=service),
        ):
            enrollment_result = asyncio.run(billing_endpoints.create_enrollment(
                enrollment,
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))
            payment_result = asyncio.run(billing_endpoints.record_external_payment(
                payment,
                request_idempotency_key="payment-key",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))
            invoice_result = asyncio.run(billing_endpoints.reconcile_invoice(
                "invoice_1",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

        self.assertEqual(enrollment_result, {"id": "enrollment_1"})
        self.assertEqual(payment_result, {"id": "payment_1"})
        self.assertEqual(invoice_result, {"id": "invoice_1"})
        self.assertEqual(routine_studio.call_count, 3)
        service.add_student_billing_enrollment.assert_awaited_once_with(
            enrollment, "studio_1", "front_desk_1"
        )
        service.record_external_payment.assert_awaited_once_with(
            payment, "studio_1", "front_desk_1", "payment-key"
        )
        service.reconcile_invoice.assert_awaited_once_with(
            "invoice_1", "studio_1", "front_desk_1"
        )

    def test_contract_only_rejects_provider_enrollment_and_invoice_targeted_external_payment(self):
        with (
            patch("app.api.v1.endpoints.billing._routine_studio_id", return_value="studio_1"),
            patch("app.api.v1.endpoints.billing.BillingService") as service,
        ):
            with self.assertRaises(HTTPException) as enrollment_error:
                asyncio.run(billing_endpoints.create_enrollment(
                    StudentBillingEnrollmentCreate(
                        student_id="student_1",
                        plan_id="plan_1",
                        payer_id="payer_1",
                        collection_mode="invoice_link",
                    ),
                    user_id="admin_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ))
            with self.assertRaises(HTTPException) as payment_error:
                asyncio.run(billing_endpoints.record_external_payment(
                    ExternalPaymentCreate(
                        invoice_id="invoice_1",
                        amount_cents=1000,
                        external_method="cash",
                    ),
                    request_idempotency_key="payment-key",
                    user_id="admin_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                ))

        self.assertEqual(enrollment_error.exception.status_code, 409)
        self.assertEqual(payment_error.exception.status_code, 409)
        self.assertEqual(
            payment_error.exception.detail,
            billing_endpoints.PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL,
        )
        service.assert_not_called()

    def test_contract_only_external_payment_http_boundary_rejects_missing_or_invoice_targets(self):
        test_app = FastAPI()
        test_app.include_router(billing_endpoints.router)
        test_app.dependency_overrides[get_current_user_id] = lambda: "admin_1"
        test_app.dependency_overrides[get_requested_studio_id] = lambda: "studio_1"
        test_app.dependency_overrides[get_supabase] = lambda: object()

        rejected_payloads = (
            {"amount_cents": 1000, "external_method": "cash"},
            {"invoice_id": "invoice_1", "amount_cents": 1000, "external_method": "cash"},
            {
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "amount_cents": 1000,
                "external_method": "cash",
            },
        )

        with (
            patch(
                "app.api.v1.endpoints.billing._routine_studio_id",
                return_value="studio_1",
            ) as routine_studio,
            patch("app.api.v1.endpoints.billing.BillingService") as service,
        ):
            client = TestClient(test_app)
            for payload in rejected_payloads:
                with self.subTest(payload=payload):
                    response = client.post(
                        "/billing/payments/external",
                        headers={"Idempotency-Key": "payment-key"},
                        json=payload,
                    )

                    self.assertEqual(response.status_code, 409, response.text)
                    self.assertEqual(
                        response.json(),
                        {"detail": billing_endpoints.PAYER_EXTERNAL_PAYMENT_ONLY_DETAIL},
                    )

        self.assertEqual(routine_studio.call_count, len(rejected_payloads))
        service.assert_not_called()

    def test_front_desk_can_create_student_scoped_external_enrollment_only(self):
        service = AsyncMock()
        service.add_student_billing_enrollment = AsyncMock(return_value={"id": "enrollment_1"})
        with (
            patch(
                "app.api.v1.endpoints.students.resolve_billing_routine_write_staff_role_for_user",
                return_value={"studio_id": "studio_1", "role": "front_desk"},
            ) as routine_resolver,
            patch("app.api.v1.endpoints.students.BillingService", return_value=service),
        ):
            result = asyncio.run(student_endpoints.add_student_billing_enrollment(
                "student_1",
                StudentBillingEnrollmentForStudentCreate(
                    plan_id="plan_1",
                    collection_mode="external",
                ),
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

        self.assertEqual(result, {"id": "enrollment_1"})
        routine_resolver.assert_called_once()
        payload = service.add_student_billing_enrollment.await_args.args[0]
        self.assertEqual(payload.collection_mode, "external")
        self.assertEqual(payload.student_id, "student_1")


if __name__ == "__main__":
    unittest.main()
