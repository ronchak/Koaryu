import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBillingPageModel,
  currentMonthPaymentTotals,
} from "../src/lib/billing-page-model.ts";
import {
  PREVIEW_CONNECT,
  PREVIEW_BILLING_METRICS_AS_OF,
  PREVIEW_ENROLLMENTS,
  PREVIEW_INVOICES,
  PREVIEW_PAYERS,
  PREVIEW_PAYMENTS,
  PREVIEW_PLANS,
  PREVIEW_SUBSCRIPTIONS,
} from "../src/lib/billing-preview-data.ts";

function program(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    color_hex: "#22C55E",
    sort_order: 0,
    is_system: false,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    usage: { active_student_count: 0, active_schedule_template_count: 0 },
    ...overrides,
  };
}

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    program_memberships: [],
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function plan(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    name: id,
    amount_cents: 10000,
    currency: "usd",
    billing_interval: "monthly",
    status: "active",
    programs: [],
    can_accept_payments: true,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function payer(id, billingStatus) {
  return {
    id,
    studio_id: "studio-1",
    display_name: id,
    email: `${id}@example.test`,
    autopay_status: "enabled",
    billing_status: billingStatus,
    balance_cents: 0,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

function invoice(id, status, amountDue, amountPaid = 0) {
  return {
    id,
    studio_id: "studio-1",
    payer_id: "payer-1",
    status,
    amount_due_cents: amountDue,
    amount_paid_cents: amountPaid,
    currency: "usd",
    due_date: "2026-05-24",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

function payment(id, status, amount, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    payer_id: "payer-1",
    status,
    amount_cents: amount,
    currency: "usd",
    method: "card",
    paid_at: "2026-05-24T00:00:00.000Z",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function subscription(id, status) {
  return {
    id,
    studio_id: "studio-1",
    payer_id: "payer-1",
    enrollment_id: "enrollment-1",
    plan_id: "plan-1",
    student_id: "student-1",
    status,
    collection_mode: "autopay",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

function enrollment(id, status) {
  return {
    id,
    studio_id: "studio-1",
    student_id: "student-1",
    payer_id: "payer-1",
    plan_id: "plan-1",
    collection_mode: "autopay",
    status,
    start_date: "2026-05-24",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

const DEFAULT_INPUT = {
  billingConnect: { studio_id: "studio-1", status: "charges_enabled", charges_enabled: true },
  billingEnrollments: [],
  billingInvoices: [],
  billingPayers: [],
  billingPayments: [],
  billingPlans: [],
  billingSubscriptions: [],
  isPreviewMode: false,
  previewEnrollments: [],
  programs: [],
  students: [],
};

describe("billing page model", () => {
  it("derives billing metrics, lookup maps, and setup flags", () => {
    const model = buildBillingPageModel({
      ...DEFAULT_INPUT,
      billingMetricsAsOf: new Date("2026-05-31T12:00:00Z"),
      billingPaymentCohortSummary: {
        period_start: "2026-05-01T00:00:00Z",
        period_end: "2026-06-01T00:00:00Z",
        timezone: "UTC",
        payment_count: 2,
        stripe_net_amount_cents: 10000,
        external_net_amount_cents: 2500,
        net_amount_cents: 12500,
        scope: "payment_cohort_net_of_cumulative_refunds",
        disclosure: "test cohort",
      },
      billingEnrollments: [enrollment("active-enrollment", "active"), enrollment("ended-enrollment", "ended")],
      billingInvoices: [
        invoice("open-invoice", "open", 10000, 3000),
        invoice("draft-credit", "draft", 2000, 3000),
        invoice("paid-invoice", "paid", 5000, 5000),
      ],
      billingPayers: [
        payer("current-payer", "current"),
        payer("past-due-payer", "past_due"),
        payer("failed-payer", "failed"),
      ],
      billingPayments: [
        payment("stripe-payment", "succeeded", 10000),
        payment("external-payment", "externally_recorded", 2500),
        payment("failed-payment", "failed", 8000),
      ],
      billingPlans: [plan("active-plan"), plan("archived-plan", { archived_at: "2026-05-01" })],
      billingSubscriptions: [
        subscription("active-sub", "active"),
        subscription("trial-sub", "trialing"),
        subscription("past-due-sub", "past_due"),
      ],
      previewEnrollments: [{ student_id: "student-preview-only" }],
      programs: [
        program("kids"),
        program("system", { is_system: true }),
        program("archived", { archived_at: "2026-05-01" }),
      ],
      students: [
        student("student-active", { preferred_name: "Ace", legal_first_name: "Ari", legal_last_name: "Stone" }),
        student("student-inactive", { status: "inactive" }),
      ],
    });

    assert.deepEqual(model.activePrograms.map((item) => item.id), ["kids"]);
    assert.equal(model.activeStudents, 1);
    assert.deepEqual(model.billingStudentOptions, [{ id: "student-active", name: "Ace Stone" }]);
    assert.equal(model.paidRevenue, 12500);
    assert.equal(model.currentMonthPaymentCount, 2);
    assert.equal(model.externalPaymentTotal, 2500);
    assert.equal(model.stripePaymentTotal, 10000);
    assert.equal(model.koaryuFeeBasis, 10000);
    assert.equal(model.openInvoiceTotal, 7000);
    assert.equal(model.failedInvoiceCount, 2);
    assert.equal(model.activeSubscriptionCount, 2);
    assert.equal(model.hasBillingPlans, true);
    assert.equal(model.hasFamilyAccounts, true);
    assert.equal(model.hasStudentBilling, true);
    assert.equal(model.hasCollectionHistory, true);
    assert.equal(model.paymentsReady, true);
    assert.equal(model.studentNameById.get("student-preview-only"), "preview-only");
    assert.equal(model.payerNameById.get("failed-payer"), "failed-payer");
    assert.equal(model.planNameById.get("active-plan"), "active-plan");
  });

  it("date-bounds current-month collection totals and subtracts refunds", () => {
    const totals = currentMonthPaymentTotals([
      payment("current-stripe", "succeeded", 10000, {
        processed_at: "2026-05-01T00:00:00.000Z",
        refunded_amount_cents: 2500,
      }),
      payment("current-external", "externally_recorded", 4000, {
        processed_at: "2026-05-31T23:59:59.999Z",
      }),
      payment("prior-month", "succeeded", 9000, {
        processed_at: "2026-04-30T23:59:59.999Z",
      }),
      payment("next-month", "succeeded", 8000, {
        processed_at: "2026-06-01T00:00:00.000Z",
      }),
      payment("fully-refunded", "refunded", 3000, {
        processed_at: "2026-05-15T00:00:00.000Z",
        refunded_amount_cents: 3000,
      }),
      payment("failed", "failed", 7000, {
        processed_at: "2026-05-15T00:00:00.000Z",
      }),
    ], new Date("2026-05-20T12:00:00.000Z"));

    assert.deepEqual(totals, {
      externalPaymentTotal: 4000,
      paidRevenue: 11500,
      paymentCount: 3,
      stripePaymentTotal: 7500,
    });
  });

  it("falls back to created_at and excludes invalid or missing payment timestamps", () => {
    const totals = currentMonthPaymentTotals([
      payment("created-this-month", "succeeded", 2500, { processed_at: null }),
      payment("invalid-date", "succeeded", 3000, {
        processed_at: "not-a-date",
      }),
      {
        id: "missing-date",
        studio_id: "studio-1",
        status: "succeeded",
        amount_cents: 5000,
        currency: "usd",
        refunded_amount_cents: 0,
      },
    ], new Date("2026-05-20T12:00:00.000Z"));

    assert.equal(totals.paidRevenue, 2500);
    assert.equal(totals.paymentCount, 1);
  });

  it("does not present the limited live payment list as a complete cohort", () => {
    const withoutServerSummary = buildBillingPageModel({
      ...DEFAULT_INPUT,
      billingPayments: [payment("limited-row", "succeeded", 999999)],
      isPreviewMode: false,
    });
    const withServerSummary = buildBillingPageModel({
      ...DEFAULT_INPUT,
      billingPaymentCohortSummary: {
        period_start: "2026-05-01T00:00:00Z",
        period_end: "2026-06-01T00:00:00Z",
        timezone: "UTC",
        payment_count: 250,
        stripe_net_amount_cents: 40000,
        external_net_amount_cents: 5000,
        net_amount_cents: 45000,
        scope: "payment_cohort_net_of_cumulative_refunds",
        disclosure: "test cohort",
      },
      billingPayments: [payment("limited-row", "succeeded", 999999)],
      isPreviewMode: false,
    });

    assert.equal(withoutServerSummary.paidRevenue, 0);
    assert.equal(withoutServerSummary.paymentCohortAvailable, false);
    assert.equal(withServerSummary.paidRevenue, 45000);
    assert.equal(withServerSummary.paymentCohortAvailable, true);
    assert.equal(withServerSummary.currentMonthPaymentCount, 250);
  });

  it("uses preview student options only when the live active roster is empty", () => {
    const model = buildBillingPageModel({
      ...DEFAULT_INPUT,
      isPreviewMode: true,
      students: [student("student-inactive", { status: "inactive" })],
    });

    assert.deepEqual(
      model.billingStudentOptions.map((option) => option.id),
      ["student-akira", "student-jun", "student-omar"]
    );
  });

  it("keeps extracted preview billing fixtures internally consistent", () => {
    const payerIds = new Set(PREVIEW_PAYERS.map((payer) => payer.id));
    const invoiceIds = new Set(PREVIEW_INVOICES.map((invoice) => invoice.id));

    assert.equal(PREVIEW_INVOICES.every((invoice) => payerIds.has(invoice.payer_id)), true);
    assert.equal(PREVIEW_PAYMENTS.every((payment) => invoiceIds.has(payment.invoice_id)), true);
    assert.equal(PREVIEW_ENROLLMENTS.every((enrollment) => payerIds.has(enrollment.payer_id)), true);

    const model = buildBillingPageModel({
      ...DEFAULT_INPUT,
      billingMetricsAsOf: PREVIEW_BILLING_METRICS_AS_OF,
      billingConnect: PREVIEW_CONNECT,
      billingEnrollments: PREVIEW_ENROLLMENTS,
      billingInvoices: PREVIEW_INVOICES,
      billingPayers: PREVIEW_PAYERS,
      billingPayments: PREVIEW_PAYMENTS,
      billingPlans: PREVIEW_PLANS,
      billingSubscriptions: PREVIEW_SUBSCRIPTIONS,
      isPreviewMode: true,
      previewEnrollments: PREVIEW_ENROLLMENTS,
    });

    assert.equal(model.paidRevenue, 30800);
    assert.equal(model.externalPaymentTotal, 17900);
    assert.equal(model.stripePaymentTotal, 12900);
    assert.equal(model.openInvoiceTotal, 12900);
    assert.equal(model.failedInvoiceCount, 1);
    assert.equal(model.activeSubscriptionCount, 1);
    assert.equal(model.paymentsReady, true);
  });
});
