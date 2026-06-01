import type {
  BillingInvoice,
  BillingPayer,
  BillingPayment,
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

export function buildBillingPageModel({
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
  const paidRevenue = billingPayments
    .filter((payment) => payment.status === "succeeded" || payment.status === "externally_recorded")
    .reduce((sum, payment) => sum + payment.amount_cents, 0);
  const openInvoiceTotal = billingInvoices
    .filter((invoice) => invoice.status === "open" || invoice.status === "draft")
    .reduce((sum, invoice) => sum + Math.max(invoice.amount_due_cents - invoice.amount_paid_cents, 0), 0);
  const failedInvoiceCount = billingPayers.filter(
    (payer) => payer.billing_status === "past_due" || payer.billing_status === "failed"
  ).length;
  const externalPaymentTotal = billingPayments
    .filter((payment) => payment.status === "externally_recorded")
    .reduce((sum, payment) => sum + payment.amount_cents, 0);
  const stripePaymentTotal = paidRevenue - externalPaymentTotal;
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
    payerNameById: new Map(billingPayers.map((payer) => [payer.id, payer.display_name])),
    paymentsReady: Boolean(billingConnect?.charges_enabled),
    planNameById: new Map(billingPlans.map((plan) => [plan.id, plan.name])),
    stripePaymentTotal,
    studentNameById,
  };
}
