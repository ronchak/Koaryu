from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, status

from app.api.v1.endpoints import billing as billing_endpoints
from app.api.v1.endpoints import students as student_endpoints
from app.schemas.billing import (
    BillingInvoiceCreate,
    BillingPayerUpdate,
    BillingPlanCreate,
    ExportJobCreate,
    ExternalPaymentCreate,
    StudentBillingEnrollmentForStudentCreate,
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

    def test_front_desk_cannot_use_representative_billing_write_endpoints(self):
        cases = [
            lambda: billing_endpoints.create_plan(
                BillingPlanCreate(name="Core", amount_cents=1000),
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ),
            lambda: billing_endpoints.update_payer(
                "payer_1",
                BillingPayerUpdate(phone="555-0100"),
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ),
            lambda: billing_endpoints.create_invoice(
                BillingInvoiceCreate(payer_id="payer_1", amount_cents=1000),
                request_idempotency_key="invoice-key",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ),
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
            lambda: billing_endpoints.create_export_job(
                ExportJobCreate(export_type="billing_payments"),
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ),
            lambda: billing_endpoints.get_export_job(
                "export_1",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ),
        ]

        for coroutine_factory in cases:
            with self.subTest(coroutine_factory=coroutine_factory):
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
