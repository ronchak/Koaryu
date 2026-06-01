import type { DashboardSummary } from "@/types/dashboard";
import type { StaffRoleName } from "@/types";

export type DashboardBillingSummary = {
  paymentAttentionCount: number | null;
  hasPlans: boolean | null;
  paymentsReady: boolean | null;
};

export type DashboardBillingActionKind = "payment-issues" | "payments-setup";

export function canViewDashboardBilling({
  currentRole,
  summary,
}: {
  currentRole: StaffRoleName | null;
  summary: DashboardSummary | null;
}) {
  if (summary) {
    return summary.billing.can_view_billing;
  }

  return currentRole === "admin" || currentRole === "front_desk";
}

export function selectDashboardBillingSummary({
  isPreviewMode,
  summary,
}: {
  isPreviewMode: boolean;
  summary: DashboardSummary | null;
}): DashboardBillingSummary {
  if (summary?.billing) {
    if (!summary.billing.can_view_billing) {
      return {
        paymentAttentionCount: null,
        hasPlans: null,
        paymentsReady: null,
      };
    }

    return {
      paymentAttentionCount: summary.billing.payment_attention_count ?? null,
      hasPlans: summary.billing.has_plans ?? null,
      paymentsReady: summary.billing.payments_ready ?? null,
    };
  }

  if (isPreviewMode) {
    return {
      paymentAttentionCount: 1,
      hasPlans: true,
      paymentsReady: true,
    };
  }

  return {
    paymentAttentionCount: null,
    hasPlans: null,
    paymentsReady: null,
  };
}

export function isDashboardBillingSetupComplete({
  billingSummary,
  summary,
}: {
  billingSummary: DashboardBillingSummary;
  summary: DashboardSummary | null;
}) {
  const hasTuitionPlans = summary?.setup.has_tuition_plans ?? billingSummary.hasPlans;
  return hasTuitionPlans === true;
}

export function getDashboardBillingActionKind({
  billingSummary,
  canSeeBilling,
}: {
  billingSummary: DashboardBillingSummary;
  canSeeBilling: boolean;
}): DashboardBillingActionKind | null {
  if (!canSeeBilling) {
    return null;
  }

  if (
    billingSummary.paymentAttentionCount !== null &&
    billingSummary.paymentAttentionCount > 0
  ) {
    return "payment-issues";
  }

  if (billingSummary.paymentsReady === false) {
    return "payments-setup";
  }

  return null;
}
