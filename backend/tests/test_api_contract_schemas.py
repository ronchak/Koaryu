import unittest

from pydantic import ValidationError

from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.billing import BillingSubscriptionResponse, StudentBillingEnrollmentResponse
from app.schemas.lead import LeadCreate, LeadResponse, LeadUpdate
from app.schemas.schedule import AttendanceCheckIn, ClassSessionResponse
from app.schemas.student import (
    BulkStatusUpdate,
    StudentCreate,
    StudentProgramMembershipResponse,
    StudentResponse,
    StudentUpdate,
)


class ApiContractSchemaTest(unittest.TestCase):
    def test_auth_role_uses_staff_role_contract(self):
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com"),
            studio_id="studio-1",
            role="front_desk",
        )

        self.assertEqual(auth.role, "front_desk")
        with self.assertRaises(ValidationError):
            AuthResponse(
                user=UserProfile(id="user-1", email="owner@example.com"),
                role="owner",
            )

    def test_student_statuses_are_narrowed_at_request_and_response_edges(self):
        created = StudentCreate(
            legal_first_name="Aiko",
            legal_last_name="Tanaka",
            status="trialing",
        )

        self.assertEqual(created.status, "trialing")
        self.assertEqual(StudentUpdate(status="paused").status, "paused")
        self.assertEqual(BulkStatusUpdate(student_ids=["student-1"], status="canceled").status, "canceled")
        self.assertEqual(
            StudentResponse(
                id="student-1",
                studio_id="studio-1",
                legal_first_name="Aiko",
                legal_last_name="Tanaka",
                status="active",
                created_at="2026-05-24T12:00:00+00:00",
                updated_at="2026-05-24T12:00:00+00:00",
            ).status,
            "active",
        )

        with self.assertRaises(ValidationError):
            StudentCreate(
                legal_first_name="Aiko",
                legal_last_name="Tanaka",
                status="graduated",
            )
        with self.assertRaises(ValidationError):
            StudentUpdate(status="prospect")
        with self.assertRaises(ValidationError):
            BulkStatusUpdate(student_ids=["student-1"], status="lead")
        with self.assertRaises(ValidationError):
            StudentResponse(
                id="student-1",
                studio_id="studio-1",
                legal_first_name="Aiko",
                legal_last_name="Tanaka",
                status="lead",
                created_at="2026-05-24T12:00:00+00:00",
                updated_at="2026-05-24T12:00:00+00:00",
            )

    def test_program_membership_statuses_are_not_student_statuses(self):
        membership = StudentProgramMembershipResponse(
            id="membership-1",
            studio_id="studio-1",
            student_id="student-1",
            program_id="program-1",
            status="paused",
            created_at="2026-05-24T12:00:00+00:00",
            updated_at="2026-05-24T12:00:00+00:00",
        )

        self.assertEqual(membership.status, "paused")
        with self.assertRaises(ValidationError):
            StudentProgramMembershipResponse(
                id="membership-1",
                studio_id="studio-1",
                student_id="student-1",
                program_id="program-1",
                status="trialing",
                created_at="2026-05-24T12:00:00+00:00",
                updated_at="2026-05-24T12:00:00+00:00",
            )

    def test_billing_subscription_and_enrollment_status_contracts_do_not_drift(self):
        subscription = BillingSubscriptionResponse(
            id="subscription-1",
            studio_id="studio-1",
            payer_id="payer-1",
            status="pending",
            created_at="2026-05-24T12:00:00+00:00",
            updated_at="2026-05-24T12:00:00+00:00",
        )

        self.assertEqual(subscription.status, "pending")
        enrollment = StudentBillingEnrollmentResponse(
            id="enrollment-1",
            studio_id="studio-1",
            student_id="student-1",
            payer_id=None,
            billing_plan_id="plan-1",
            billing_subscription_id="subscription-1",
            collection_mode="external",
            status="active",
            billing_status="externally_paid",
            start_date="2026-05-24",
            next_bill_on="2026-06-24",
            created_at="2026-05-24T12:00:00+00:00",
            updated_at="2026-05-24T12:00:00+00:00",
        )

        self.assertEqual(enrollment.plan_id, "plan-1")
        self.assertEqual(enrollment.subscription_id, "subscription-1")
        self.assertEqual(enrollment.next_bill_date, "2026-06-24")
        with self.assertRaises(ValidationError):
            StudentBillingEnrollmentResponse(
                id="enrollment-1",
                studio_id="studio-1",
                student_id="student-1",
                billing_plan_id="plan-1",
                collection_mode="external",
                status="trialing",
                billing_status="externally_paid",
                start_date="2026-05-24",
                created_at="2026-05-24T12:00:00+00:00",
                updated_at="2026-05-24T12:00:00+00:00",
            )

    def test_lead_stage_source_and_lost_reason_contracts_do_not_drift(self):
        lead = LeadResponse(
            id="lead-1",
            studio_id="studio-1",
            first_name="Aiko",
            last_name="Tanaka",
            source="referral",
            stage="trial_scheduled",
            is_minor=False,
            lost_reason="timing",
            created_at="2026-05-24T12:00:00+00:00",
            updated_at="2026-05-24T12:00:00+00:00",
        )

        self.assertEqual(lead.source, "referral")
        self.assertEqual(LeadCreate(first_name="Aiko", last_name="Tanaka", source="website").source, "website")
        self.assertEqual(LeadUpdate(stage="closed_lost", lost_reason="price_objection").stage, "closed_lost")
        with self.assertRaises(ValidationError):
            LeadCreate(first_name="Aiko", last_name="Tanaka", source="instagram")
        with self.assertRaises(ValidationError):
            LeadUpdate(stage="won")
        with self.assertRaises(ValidationError):
            LeadResponse(
                id="lead-1",
                studio_id="studio-1",
                first_name="Aiko",
                last_name="Tanaka",
                source="referral",
                stage="lost",
                is_minor=False,
                created_at="2026-05-24T12:00:00+00:00",
                updated_at="2026-05-24T12:00:00+00:00",
            )

    def test_schedule_status_contracts_do_not_drift(self):
        session = ClassSessionResponse(
            id="session-1",
            studio_id="studio-1",
            name="Basics",
            date="2026-05-24",
            start_time="17:00",
            end_time="18:00",
            status="scheduled",
            created_at="2026-05-24T12:00:00+00:00",
        )

        self.assertEqual(session.status, "scheduled")
        self.assertEqual(AttendanceCheckIn(session_id="session-1", student_id="student-1", status="late").status, "late")
        with self.assertRaises(ValidationError):
            ClassSessionResponse(
                id="session-1",
                studio_id="studio-1",
                name="Basics",
                date="2026-05-24",
                start_time="17:00",
                end_time="18:00",
                status="archived",
                created_at="2026-05-24T12:00:00+00:00",
            )
        with self.assertRaises(ValidationError):
            AttendanceCheckIn(session_id="session-1", student_id="student-1", status="checked_in")


if __name__ == "__main__":
    unittest.main()
