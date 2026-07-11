import type {
  BillingInvoice,
  BillingPayer,
  BillingPayment,
  BillingPaymentCohortSummary,
  BillingPlan,
  BillingSubscription,
  Program,
  Student,
  StudentBillingEnrollment,
  StudioPaymentAccount,
} from "@/types";

const PREVIEW_BILLING_STUDENT_OPTIONS = [
  { id: "student-akira", name: "Akira Tanaka" },
  { id: "student-jun", name: "Jun Park" },
  { id: "student-omar", name: "Omar Haddad Jr." },
];

export interface BillingPageModelInput {
  billingMetricsAsOf?: Date;
  billingPaymentCohortSummary?: BillingPaymentCohortSummary | null;
  billingConnect: StudioPaymentAccount | null;
  billingEnrollments: StudentBillingEnrollment[];
  billingInvoices: BillingInvoice[];
  billingPayers: BillingPayer[];
  billingPayments: BillingPayment[];
  billingPlans: BillingPlan[];
  billingSubscriptions: BillingSubscription[];
  isPreviewMode: boolean;
  previewEnrollments: Pick<StudentBillingEnrollment, "student_id">[];
  programs: Program[];
  students: Student[];
}

const COLLECTED_PAYMENT_STATUSES = new Set(["succeeded", "refunded", "externally_recorded"]);

export function currentMonthPaymentTotals(
  payments: BillingPayment[],
  asOf: Date = new Date()
) {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  let externalPaymentTotal = 0;
  let stripePaymentTotal = 0;
  let paymentCount = 0;

  for (const payment of payments) {
    if (!COLLECTED_PAYMENT_STATUSES.has(payment.status)) continue;
    const timestamp = payment.processed_at || payment.created_at;
    const processedAt = timestamp ? new Date(timestamp) : null;
    if (
      !processedAt
      || Number.isNaN(processedAt.getTime())
      || processedAt.getUTCFullYear() !== year
      || processedAt.getUTCMonth() !== month
    ) {
      continue;
    }
    const netAmount = Math.max(
      0,
      payment.amount_cents - (payment.refunded_amount_cents || 0)
    );
    paymentCount += 1;
    if (payment.status === "externally_recorded") {
      externalPaymentTotal += netAmount;
    } else {
      stripePaymentTotal += netAmount;
    }
  }

  return {
    externalPaymentTotal,
    paidRevenue: externalPaymentTotal + stripePaymentTotal,
    paymentCount,
    stripePaymentTotal,
  };
}

export function buildBillingPageModel({
  billingMetricsAsOf,
  billingPaymentCohortSummary,
  billingConnect,
  billingEnrollments,
  billingInvoices,
  billingPayers,
  billingPayments,
  billingPlans,
  billingSubscriptions,
  isPreviewMode,
  previewEnrollments,
  programs,
  students,
}: BillingPageModelInput) {
  const activePrograms = programs.filter((program) => !program.archived_at && !program.is_system);
  const activeStudents = students.filter((student) => student.status === "active").length;
  const billingStudentOptions = students
    .filter((student) => student.status === "active")
    .map((student) => ({
      id: student.id,
      name: `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`,
    }));
  const clientCohortTotals = currentMonthPaymentTotals(billingPayments, billingMetricsAsOf);
  const {
    externalPaymentTotal,
    paidRevenue,
    paymentCount: currentMonthPaymentCount,
    stripePaymentTotal,
  } = isPreviewMode
    ? clientCohortTotals
    : billingPaymentCohortSummary
      ? {
          externalPaymentTotal: billingPaymentCohortSummary.external_net_amount_cents,
          paidRevenue: billingPaymentCohortSummary.net_amount_cents,
          paymentCount: billingPaymentCohortSummary.payment_count,
          stripePaymentTotal: billingPaymentCohortSummary.stripe_net_amount_cents,
        }
      : {
          externalPaymentTotal: 0,
          paidRevenue: 0,
          paymentCount: 0,
          stripePaymentTotal: 0,
        };
  const openInvoiceTotal = billingInvoices
    .filter((invoice) => invoice.status === "open" || invoice.status === "draft")
    .reduce((sum, invoice) => sum + Math.max(invoice.amount_due_cents - invoice.amount_paid_cents, 0), 0);
  const failedInvoiceCount = billingPayers.filter(
    (payer) => payer.billing_status === "past_due" || payer.billing_status === "failed"
  ).length;
  const studentNameById = new Map<string, string>();

  students.forEach((student) => {
    studentNameById.set(
      student.id,
      `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`
    );
  });
  previewEnrollments.forEach((enrollment) => {
    if (!studentNameById.has(enrollment.student_id)) {
      studentNameById.set(enrollment.student_id, enrollment.student_id.replace(/^student-/, ""));
    }
  });

  return {
    activePrograms,
    activeStudents,
    activeSubscriptionCount: billingSubscriptions.filter(
      (subscription) => subscription.status === "active" || subscription.status === "trialing"
    ).length,
    billingStudentOptions:
      isPreviewMode && billingStudentOptions.length === 0
        ? PREVIEW_BILLING_STUDENT_OPTIONS
        : billingStudentOptions,
    currentMonthPaymentCount,
    externalPaymentTotal,
    failedInvoiceCount,
    hasBillingPlans: billingPlans.some((plan) => !plan.archived_at),
    hasCollectionHistory: billingInvoices.length > 0 || billingPayments.length > 0,
    hasFamilyAccounts: billingPayers.length > 0,
    hasStudentBilling: billingEnrollments.some(
      (enrollment) => enrollment.status !== "canceled" && enrollment.status !== "ended"
    ),
    koaryuFeeBasis: Math.max(stripePaymentTotal, 0),
    openInvoiceTotal,
    paidRevenue,
    paymentCohortAvailable: isPreviewMode || Boolean(billingPaymentCohortSummary),
    payerNameById: new Map(billingPayers.map((payer) => [payer.id, payer.display_name])),
    paymentsReady: Boolean(billingConnect?.charges_enabled),
    planNameById: new Map(billingPlans.map((plan) => [plan.id, plan.name])),
    stripePaymentTotal,
    studentNameById,
  };
}
