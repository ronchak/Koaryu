from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import billing as billing_endpoints
from app.schemas.billing import (
    BillingEnrollmentTransitionRequest,
    BillingEnrollmentTransitionRevokeRequest,
)


def test_schedule_and_revoke_use_routine_staff_authority_and_forward_keys():
    service = AsyncMock()
    service.schedule_enrollment_period_end = AsyncMock(return_value={"outcome": "claimed"})
    service.revoke_enrollment_period_end = AsyncMock(return_value={"outcome": "claimed"})
    with (
        patch("app.api.v1.endpoints.billing._routine_studio_id", return_value="studio_1") as routine,
        patch("app.api.v1.endpoints.billing._admin_studio_id", side_effect=AssertionError("admin resolver used")),
        patch("app.api.v1.endpoints.billing.BillingService", return_value=service),
        patch(
            "app.api.v1.endpoints.billing.get_settings",
            return_value=SimpleNamespace(BILLING_TRANSITION_SCHEDULER_ENABLED=True),
        ),
    ):
        scheduled = asyncio.run(billing_endpoints.schedule_enrollment_period_end(
            "enrollment_1",
            BillingEnrollmentTransitionRequest(reason_code="staff_requested"),
            request_idempotency_key="schedule-key",
            user_id="front_desk_1",
            requested_studio_id="studio_1",
            supabase=object(),
        ))
        revoked = asyncio.run(billing_endpoints.revoke_scheduled_enrollment_transition(
            "intent_1",
            BillingEnrollmentTransitionRevokeRequest(
                expected_revision=4,
                reason_code="staff_requested",
            ),
            request_idempotency_key="revoke-key",
            user_id="front_desk_1",
            requested_studio_id="studio_1",
            supabase=object(),
        ))

    assert scheduled == {"outcome": "claimed"}
    assert revoked == {"outcome": "claimed"}
    assert routine.call_count == 2
    service.schedule_enrollment_period_end.assert_awaited_once_with(
        "enrollment_1", "studio_1", "front_desk_1", "schedule-key", "staff_requested"
    )
    service.revoke_enrollment_period_end.assert_awaited_once_with(
        "intent_1", 4, "studio_1", "front_desk_1", "revoke-key", "staff_requested"
    )


def test_schedule_fails_closed_before_authorization_when_worker_is_disabled():
    with (
        patch(
            "app.api.v1.endpoints.billing.get_settings",
            return_value=SimpleNamespace(BILLING_TRANSITION_SCHEDULER_ENABLED=False),
        ),
        patch(
            "app.api.v1.endpoints.billing._routine_studio_id",
            side_effect=AssertionError("authorization ran while scheduler was disabled"),
        ),
    ):
        with pytest.raises(HTTPException) as disabled:
            asyncio.run(billing_endpoints.schedule_enrollment_period_end(
                "enrollment_1",
                BillingEnrollmentTransitionRequest(reason_code="staff_requested"),
                request_idempotency_key="schedule-key",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

    assert disabled.value.status_code == 503
    assert disabled.value.detail == (
        "Period-end cancellation scheduling is unavailable until its worker is active."
    )


def test_immediate_cancel_requires_admin_and_never_calls_service_when_denied():
    service = AsyncMock()
    with (
        patch(
            "app.api.v1.endpoints.billing._admin_studio_id",
            side_effect=HTTPException(status_code=403, detail="Admin required."),
        ),
        patch("app.api.v1.endpoints.billing.BillingService", return_value=service),
    ):
        with pytest.raises(HTTPException) as denied:
            asyncio.run(billing_endpoints.cancel_enrollment_immediate(
                "enrollment_1",
                BillingEnrollmentTransitionRequest(reason_code="staff_requested"),
                request_idempotency_key="immediate-key",
                user_id="front_desk_1",
                requested_studio_id="studio_1",
                supabase=object(),
            ))

    assert denied.value.status_code == 403
    service.cancel_enrollment_immediate.assert_not_called()


def test_immediate_cancel_uses_admin_authority_and_forwards_key():
    service = AsyncMock()
    service.cancel_enrollment_immediate = AsyncMock(return_value={"outcome": "claimed"})
    with (
        patch("app.api.v1.endpoints.billing._admin_studio_id", return_value="studio_1") as admin,
        patch("app.api.v1.endpoints.billing._routine_studio_id", side_effect=AssertionError("routine resolver used")),
        patch("app.api.v1.endpoints.billing.BillingService", return_value=service),
    ):
        result = asyncio.run(billing_endpoints.cancel_enrollment_immediate(
            "enrollment_1",
            BillingEnrollmentTransitionRequest(reason_code="staff_requested"),
            request_idempotency_key="immediate-key",
            user_id="admin_1",
            requested_studio_id="studio_1",
            supabase=object(),
        ))

    assert result == {"outcome": "claimed"}
    admin.assert_called_once()
    service.cancel_enrollment_immediate.assert_awaited_once_with(
        "enrollment_1", "studio_1", "admin_1", "immediate-key", "staff_requested"
    )
