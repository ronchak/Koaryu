import type {
  BillingInvoiceCreate,
  BillingPlan,
  BillingPlanCreate,
  BillingPayerCreate,
  ExternalPaymentCreate,
  StudentBillingEnrollment,
  StudentBillingEnrollmentCreate,
} from "@/types";

export type BillingFormPayloadResult<T> =
  | { ok: true; payload: T }
  | { ok: false; error: string };

export type ExternalBillingPaymentPayload = ExternalPaymentCreate;

export function requiresPayerForStudentBillingEnrollment(
  collectionMode: StudentBillingEnrollment["collection_mode"]
) {
  return collectionMode !== "external";
}

export function canSubmitStudentBillingEnrollmentForm({
  canManageStudioBilling,
  collectionMode,
  isActionLoading,
  payerCount,
  planCount,
}: {
  canManageStudioBilling: boolean;
  collectionMode: StudentBillingEnrollment["collection_mode"];
  isActionLoading: boolean;
  payerCount: number;
  planCount: number;
}) {
  return Boolean(
    canManageStudioBilling
      && !isActionLoading
      && planCount > 0
      && (!requiresPayerForStudentBillingEnrollment(collectionMode) || payerCount > 0)
  );
}

export function shouldDisableStudentBillingEnrollmentPayerSelect({
  canManageStudioBilling,
  collectionMode,
  payerCount,
}: {
  canManageStudioBilling: boolean;
  collectionMode: StudentBillingEnrollment["collection_mode"];
  payerCount: number;
}) {
  return !canManageStudioBilling
    || (requiresPayerForStudentBillingEnrollment(collectionMode) && payerCount === 0);
}

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function moneyInputToCents(value: string) {
  return Math.round(Number(value) * 100);
}

export function buildBillingPlanCreatePayload({
  planName,
  planDescription,
  planAmount,
  planInterval,
  planProgramIds,
  planSignupFee,
  planTrialDays,
}: {
  planName: string;
  planDescription: string;
  planAmount: string;
  planInterval: BillingPlan["billing_interval"];
  planProgramIds: string[];
  planSignupFee: string;
  planTrialDays: string;
}): BillingFormPayloadResult<BillingPlanCreate> {
  const amount = Number(planAmount);
  const signupFee = planSignupFee ? Number(planSignupFee) : 0;
  const trialDays = planTrialDays ? Number(planTrialDays) : 0;

  if (!planName.trim()) {
    return { ok: false, error: "Plan name is required." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid plan amount." };
  }
  if (planProgramIds.length === 0) {
    return { ok: false, error: "Choose at least one program for this billing plan." };
  }
  if (!Number.isFinite(signupFee) || signupFee < 0) {
    return { ok: false, error: "Enter a valid signup fee." };
  }
  if (!Number.isInteger(trialDays) || trialDays < 0) {
    return { ok: false, error: "Trial days must be a whole number." };
  }

  return {
    ok: true,
    payload: {
      name: planName.trim(),
      description: optionalText(planDescription),
      amount_cents: Math.round(amount * 100),
      currency: "usd",
      billing_interval: planInterval,
      program_ids: planProgramIds,
      signup_fee_cents: Math.round(signupFee * 100),
      trial_days: trialDays,
      proration_behavior: "next_cycle",
    },
  };
}

export function buildBillingPayerCreatePayload({
  payerName,
  payerEmail,
  payerPhone,
}: {
  payerName: string;
  payerEmail: string;
  payerPhone: string;
}): BillingFormPayloadResult<BillingPayerCreate> {
  if (!payerName.trim()) {
    return { ok: false, error: "Payer name is required." };
  }

  return {
    ok: true,
    payload: {
      display_name: payerName.trim(),
      email: optionalText(payerEmail),
      phone: optionalText(payerPhone),
    },
  };
}

export function buildStudentBillingEnrollmentCreatePayload({
  enrollmentStudentId,
  enrollmentPayerId,
  enrollmentPlanId,
  enrollmentCollectionMode,
  enrollmentStartDate,
  enrollmentEndDate,
  enrollmentNextBillDate,
}: {
  enrollmentStudentId: string;
  enrollmentPayerId: string;
  enrollmentPlanId: string;
  enrollmentCollectionMode: StudentBillingEnrollment["collection_mode"];
  enrollmentStartDate: string;
  enrollmentEndDate: string;
  enrollmentNextBillDate: string;
}): BillingFormPayloadResult<StudentBillingEnrollmentCreate> {
  if (!enrollmentStudentId || !enrollmentPlanId) {
    return { ok: false, error: "Choose a student and plan." };
  }
  if (enrollmentCollectionMode !== "external" && !enrollmentPayerId) {
    return { ok: false, error: "Choose a student, payer, and plan." };
  }
  if (!enrollmentStartDate) {
    return { ok: false, error: "Start date is required." };
  }

  return {
    ok: true,
    payload: {
      student_id: enrollmentStudentId,
      payer_id: enrollmentPayerId || null,
      billing_plan_id: enrollmentPlanId,
      collection_mode: enrollmentCollectionMode,
      start_date: enrollmentStartDate,
      end_date: enrollmentEndDate || null,
      next_bill_on: enrollmentNextBillDate || null,
    },
  };
}

export function buildBillingInvoiceCreatePayload({
  invoicePayerId,
  invoiceEnrollmentId,
  invoiceStudentId,
  invoiceAmount,
  invoiceDueDate,
  invoiceDescription,
  invoiceSendHosted,
}: {
  invoicePayerId: string;
  invoiceEnrollmentId: string;
  invoiceStudentId: string;
  invoiceAmount: string;
  invoiceDueDate: string;
  invoiceDescription: string;
  invoiceSendHosted: boolean;
}): BillingFormPayloadResult<BillingInvoiceCreate> {
  const amount = Number(invoiceAmount);
  if (!invoicePayerId) {
    return { ok: false, error: "Choose a payer for this invoice." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid invoice amount." };
  }

  return {
    ok: true,
    payload: {
      payer_id: invoicePayerId,
      enrollment_id: invoiceEnrollmentId || undefined,
      student_id: invoiceStudentId || undefined,
      amount_cents: moneyInputToCents(invoiceAmount),
      currency: "usd",
      invoice_type: "tuition",
      due_date: invoiceDueDate || undefined,
      description: optionalText(invoiceDescription),
      send_hosted_invoice: invoiceSendHosted,
    },
  };
}

export function buildExternalBillingPaymentPayload({
  externalPayerId,
  externalAmount,
  externalMethod,
  externalNote,
}: {
  externalPayerId: string;
  externalAmount: string;
  externalMethod: string;
  externalNote: string;
}): BillingFormPayloadResult<ExternalBillingPaymentPayload> {
  const amount = Number(externalAmount);
  if (!externalPayerId) {
    return { ok: false, error: "Choose a payer for this external payment." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a valid external payment amount." };
  }
  if (!externalMethod.trim()) {
    return { ok: false, error: "Enter the external payment method." };
  }

  return {
    ok: true,
    payload: {
      payer_id: externalPayerId,
      amount_cents: moneyInputToCents(externalAmount),
      currency: "usd",
      external_method: externalMethod.trim(),
      note: optionalText(externalNote),
    },
  };
}
