from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.api.v1.endpoints import students as student_endpoints
from app.schemas.billing import StudentBillingEnrollmentForStudentCreate
from app.services.staging_provider_enrollment_policy import (
    allows_provider_enrollment_preparation,
)


def _settings(*, environment: str, mode: object = "test", key: str = "sk_test_fixture"):
    return SimpleNamespace(
        ENVIRONMENT=environment,
        STRIPE_MODE=mode,
        STRIPE_SECRET_KEY=key,
    )


class StagingProviderEnrollmentPolicyTest(unittest.TestCase):
    def test_allows_only_exact_staging_with_configured_test_mode(self):
        self.assertTrue(
            allows_provider_enrollment_preparation(
                _settings(environment="staging")
            )
        )

        denied_settings = (
            _settings(environment="production"),
            _settings(environment="development"),
            _settings(environment="Staging"),
            _settings(environment="staging", mode="live", key="sk_live_fixture"),
            _settings(environment="staging", mode="test", key="sk_live_fixture"),
            _settings(environment="staging", mode="invalid"),
            _settings(environment="staging", mode=None, key="malformed"),
        )
        for settings in denied_settings:
            with self.subTest(settings=settings):
                self.assertFalse(allows_provider_enrollment_preparation(settings))


class StudentStagingProviderEnrollmentEndpointTest(unittest.TestCase):
    def setUp(self):
        self.data = StudentBillingEnrollmentForStudentCreate(
            plan_id="plan_1",
            payer_id="payer_1",
            collection_mode="invoice_link",
        )

    def test_staging_test_creates_pending_provider_enrollment_locally(self):
        service = AsyncMock()
        service.add_student_billing_enrollment = AsyncMock(
            return_value={"id": "enrollment_1", "status": "pending"}
        )
        with (
            patch(
                "app.api.v1.endpoints.students.resolve_billing_routine_write_staff_role_for_user",
                return_value={"studio_id": "studio_1", "role": "front_desk"},
            ) as role_resolver,
            patch(
                "app.services.staging_provider_enrollment_policy.get_settings",
                return_value=_settings(environment="staging"),
            ),
            patch(
                "app.api.v1.endpoints.students.BillingService",
                return_value=service,
            ),
        ):
            result = asyncio.run(
                student_endpoints.add_student_billing_enrollment(
                    "student_1",
                    self.data,
                    user_id="front_desk_1",
                    requested_studio_id="studio_1",
                    supabase=object(),
                )
            )

        self.assertEqual(result, {"id": "enrollment_1", "status": "pending"})
        role_resolver.assert_called_once_with(
            unittest.mock.ANY,
            "front_desk_1",
            "studio_1",
            require_platform_subscription=True,
        )
        payload = service.add_student_billing_enrollment.await_args.args[0]
        self.assertEqual(payload.student_id, "student_1")
        self.assertEqual(payload.collection_mode, "invoice_link")
        service.add_student_billing_enrollment.assert_awaited_once_with(
            payload,
            "studio_1",
            "front_desk_1",
        )

    def test_non_staging_test_modes_reject_before_service_construction(self):
        denied_settings = (
            _settings(environment="production"),
            _settings(environment="development"),
            _settings(environment="staging", mode="live", key="sk_live_fixture"),
            _settings(environment="staging", mode="test", key="sk_live_fixture"),
            _settings(environment="staging", mode="malformed"),
        )
        for settings in denied_settings:
            with self.subTest(settings=settings):
                with (
                    patch(
                        "app.api.v1.endpoints.students.resolve_billing_routine_write_staff_role_for_user",
                        return_value={"studio_id": "studio_1", "role": "admin"},
                    ),
                    patch(
                        "app.services.staging_provider_enrollment_policy.get_settings",
                        return_value=settings,
                    ),
                    patch("app.api.v1.endpoints.students.BillingService") as service,
                ):
                    with self.assertRaises(HTTPException) as raised:
                        asyncio.run(
                            student_endpoints.add_student_billing_enrollment(
                                "student_1",
                                self.data,
                                user_id="admin_1",
                                requested_studio_id="studio_1",
                                supabase=object(),
                            )
                        )

                self.assertEqual(raised.exception.status_code, 409)
                self.assertEqual(
                    raised.exception.detail,
                    "Billing attachments currently support external collection only.",
                )
                service.assert_not_called()


if __name__ == "__main__":
    unittest.main()
