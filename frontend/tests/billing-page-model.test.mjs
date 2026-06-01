import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBillingPageModel } from "../src/lib/billing-page-model.ts";
import {
  PREVIEW_CONNECT,
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

function payment(id, status, amount) {
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
