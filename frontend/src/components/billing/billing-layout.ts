export const billingOverviewMetricsClass = "grid gap-2 p-2 sm:grid-cols-2 xl:grid-cols-4";
export const billingOverviewProvidersClass = "grid gap-5 lg:grid-cols-2";
export const billingReportMetricsClass = "grid gap-4 md:grid-cols-2";
export const billingEnrollmentFormClass =
  "grid gap-3 lg:grid-cols-[1fr_1fr_1fr_0.8fr_0.7fr_0.7fr_0.7fr_auto] lg:items-end";
export const billingExternalPaymentFormClass =
  "grid gap-3 md:grid-cols-[1fr_0.6fr_0.7fr_1fr_auto] md:items-end";

export const billingLedgerLayout = {
  plans: {
    columns: 5,
    header:
      "hidden grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid",
    row: "grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 last:border-b-0 md:min-h-14 md:grid-cols-[1fr_auto_auto_auto_auto] md:items-center md:gap-4 md:py-2",
  },
  families: {
    columns: 5,
    header:
      "hidden grid-cols-[1.1fr_1fr_1fr_auto_1.3fr] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid",
    row: "grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 md:min-h-14 md:grid-cols-[1.1fr_1fr_1fr_auto_1.3fr] md:items-center md:gap-4 md:py-2",
  },
  enrollments: {
    columns: 4,
    header:
      "hidden grid-cols-[1fr_1fr_0.8fr_1.35fr] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid",
    row: "grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 md:min-h-14 md:grid-cols-[1fr_1fr_0.8fr_1.35fr] md:items-center md:gap-4 md:py-2",
  },
  invoices: {
    columns: 6,
    header:
      "hidden grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted md:grid",
    row: "grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 md:min-h-14 md:grid-cols-[1fr_auto_auto_auto_auto_auto] md:items-center md:gap-4 md:py-1.5",
  },
} as const;

export const billingPaymentHeaderClass =
  "hidden gap-4 border-b border-border px-4 py-3 text-xs font-medium text-muted sm:grid";
export const billingPaymentRowClass =
  "grid min-w-0 grid-cols-1 gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0 sm:min-h-14 sm:items-center sm:gap-4 sm:py-1.5";

export function billingPaymentGridColumns(canRefundPayments: boolean) {
  return canRefundPayments ? "sm:grid-cols-[1fr_auto_auto_auto]" : "sm:grid-cols-[1fr_auto_auto]";
}
