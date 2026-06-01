import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBillingInvoiceCreatePayload,
  buildBillingPayerCreatePayload,
  buildBillingPlanCreatePayload,
  canSubmitStudentBillingEnrollmentForm,
  buildExternalBillingPaymentPayload,
  buildStudentBillingEnrollmentCreatePayload,
  shouldDisableStudentBillingEnrollmentPayerSelect,
} from "../src/lib/billing-page-form-model.ts";

describe("billing page form model", () => {
  it("validates and builds billing plan create payloads", () => {
    assert.deepEqual(
      buildBillingPlanCreatePayload({
        planName: " ",
        planDescription: "",
        planAmount: "129",
        planInterval: "monthly",
        planProgramIds: ["program-1"],
        planSignupFee: "",
        planTrialDays: "",
      }),
      { ok: false, error: "Plan name is required." }
    );

    assert.deepEqual(
      buildBillingPlanCreatePayload({
        planName: "Monthly Tuition",
        planDescription: " Core program ",
        planAmount: "129.50",
        planInterval: "monthly",
        planProgramIds: ["program-1", "program-2"],
        planSignupFee: "25",
        planTrialDays: "7",
      }),
      {
        ok: true,
        payload: {
          name: "Monthly Tuition",
          description: "Core program",
          amount_cents: 12950,
          currency: "usd",
          billing_interval: "monthly",
          program_ids: ["program-1", "program-2"],
          signup_fee_cents: 2500,
          trial_days: 7,
          proration_behavior: "next_cycle",
        },
      }
    );
  });

  it("keeps payer payload trimming and optional fields stable", () => {
    assert.deepEqual(
      buildBillingPayerCreatePayload({
        payerName: "",
        payerEmail: "",
        payerPhone: "",
      }),
      { ok: false, error: "Payer name is required." }
    );

    assert.deepEqual(
      buildBillingPayerCreatePayload({
        payerName: " Family One ",
        payerEmail: " billing@example.test ",
        payerPhone: " ",
      }),
      {
        ok: true,
        payload: {
          display_name: "Family One",
          email: "billing@example.test",
          phone: undefined,
        },
      }
    );
  });

  it("validates and builds enrollment payloads", () => {
    assert.deepEqual(
      buildStudentBillingEnrollmentCreatePayload({
        enrollmentStudentId: "student-1",
        enrollmentPayerId: "",
        enrollmentPlanId: "plan-1",
        enrollmentCollectionMode: "autopay",
        enrollmentStartDate: "2026-06-01",
        enrollmentEndDate: "",
        enrollmentNextBillDate: "",
      }),
      { ok: false, error: "Choose a student, payer, and plan." }
    );

    assert.deepEqual(
      buildStudentBillingEnrollmentCreatePayload({
        enrollmentStudentId: "student-1",
        enrollmentPayerId: "payer-1",
        enrollmentPlanId: "plan-1",
        enrollmentCollectionMode: "invoice_link",
        enrollmentStartDate: "2026-06-01",
        enrollmentEndDate: "",
        enrollmentNextBillDate: "2026-07-01",
      }),
      {
        ok: true,
        payload: {
          student_id: "student-1",
          payer_id: "payer-1",
          billing_plan_id: "plan-1",
          collection_mode: "invoice_link",
          start_date: "2026-06-01",
          end_date: null,
          next_bill_on: "2026-07-01",
        },
      }
    );

    assert.deepEqual(
      buildStudentBillingEnrollmentCreatePayload({
        enrollmentStudentId: "student-1",
        enrollmentPayerId: "",
        enrollmentPlanId: "plan-1",
        enrollmentCollectionMode: "external",
        enrollmentStartDate: "2026-06-01",
        enrollmentEndDate: "",
        enrollmentNextBillDate: "",
      }),
      {
        ok: true,
        payload: {
          student_id: "student-1",
          payer_id: null,
          billing_plan_id: "plan-1",
          collection_mode: "external",
          start_date: "2026-06-01",
          end_date: null,
          next_bill_on: null,
        },
      }
    );
  });

  it("allows payerless external enrollments while keeping Stripe collections payer-bound", () => {
    assert.equal(
      canSubmitStudentBillingEnrollmentForm({
        canManageStudioBilling: true,
        collectionMode: "external",
        isActionLoading: false,
        payerCount: 0,
        planCount: 1,
      }),
      true
    );
    assert.equal(
      shouldDisableStudentBillingEnrollmentPayerSelect({
        canManageStudioBilling: true,
        collectionMode: "external",
        payerCount: 0,
      }),
      false
    );
    assert.equal(
      canSubmitStudentBillingEnrollmentForm({
        canManageStudioBilling: true,
        collectionMode: "autopay",
        isActionLoading: false,
        payerCount: 0,
        planCount: 1,
      }),
      false
    );
    assert.equal(
      shouldDisableStudentBillingEnrollmentPayerSelect({
        canManageStudioBilling: true,
        collectionMode: "invoice_link",
        payerCount: 0,
      }),
      true
    );
  });

  it("validates and builds invoice payloads", () => {
    assert.deepEqual(
      buildBillingInvoiceCreatePayload({
        invoicePayerId: "",
        invoiceEnrollmentId: "",
        invoiceStudentId: "",
        invoiceAmount: "129",
        invoiceDueDate: "",
        invoiceDescription: "",
        invoiceSendHosted: true,
      }),
      { ok: false, error: "Choose a payer for this invoice." }
    );

    assert.deepEqual(
      buildBillingInvoiceCreatePayload({
        invoicePayerId: "payer-1",
        invoiceEnrollmentId: "",
        invoiceStudentId: "student-1",
        invoiceAmount: "129.5",
        invoiceDueDate: "2026-06-15",
        invoiceDescription: " June tuition ",
        invoiceSendHosted: false,
      }),
      {
        ok: true,
        payload: {
          payer_id: "payer-1",
          enrollment_id: undefined,
          student_id: "student-1",
          amount_cents: 12950,
          currency: "usd",
          invoice_type: "tuition",
          due_date: "2026-06-15",
          description: "June tuition",
          send_hosted_invoice: false,
        },
      }
    );
  });

  it("validates and builds external payment payloads", () => {
    assert.deepEqual(
      buildExternalBillingPaymentPayload({
        externalPayerId: "payer-1",
        externalAmount: "10",
        externalMethod: " ",
        externalNote: "",
      }),
      { ok: false, error: "Enter the external payment method." }
    );

    assert.deepEqual(
      buildExternalBillingPaymentPayload({
        externalPayerId: "payer-1",
        externalAmount: "75.25",
        externalMethod: " Check ",
        externalNote: " paid at front desk ",
      }),
      {
        ok: true,
        payload: {
          payer_id: "payer-1",
          amount_cents: 7525,
          currency: "usd",
          external_method: "Check",
          note: "paid at front desk",
        },
      }
    );
  });
});
