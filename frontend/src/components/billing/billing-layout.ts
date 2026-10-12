// Shared column templates: the loaded tabs and their cold-load placeholders use the
// same strings, so a placeholder always has the geometry of the view it stands in for.
export const billingOverviewMetricsClass = "grid gap-x-6 gap-y-4 sm:grid-cols-2";
export const billingOverviewProvidersClass = "grid items-start gap-5 lg:grid-cols-2";
export const billingReportMetricsClass = "grid gap-3 sm:grid-cols-2";
export const billingEnrollmentFormClass = "grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end";
export const billingExternalPaymentFormClass =
  "grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] lg:items-end";

const ledgerHeader =
  "hidden gap-4 border-b border-border px-5 pb-2.5 pt-1 text-xs font-semibold text-muted lg:grid lg:items-end";
const ledgerRow =
  "grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-5 py-4 text-sm last:border-b-0 lg:min-h-16 lg:items-center lg:gap-4 lg:py-3";
// Ledgers with several row actions switch to columns only once the actions fit beside them.
const wideLedgerHeader =
  "hidden gap-4 border-b border-border px-5 pb-2.5 pt-1 text-xs font-semibold text-muted xl:grid xl:items-end";
const wideLedgerRow =
  "grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-5 py-4 text-sm last:border-b-0 xl:min-h-16 xl:items-center xl:gap-4 xl:py-3";

export const billingLedgerLayout = {
  plans: {
    columns: 5,
    header: `${ledgerHeader} lg:grid-cols-[minmax(0,1fr)_8rem_11rem_7.5rem_8.5rem]`,
    row: `${ledgerRow} lg:grid-cols-[minmax(0,1fr)_8rem_11rem_7.5rem_8.5rem]`,
  },
  families: {
    columns: 5,
    header: `${wideLedgerHeader} xl:grid-cols-[minmax(0,1.1fr)_9rem_minmax(0,1fr)_minmax(0,1fr)_21rem]`,
    row: `${wideLedgerRow} xl:grid-cols-[minmax(0,1.1fr)_9rem_minmax(0,1fr)_minmax(0,1fr)_21rem]`,
  },
  enrollments: {
    columns: 4,
    header: `${ledgerHeader} lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.3fr)]`,
    row: `${ledgerRow} lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.3fr)]`,
  },
  invoices: {
    columns: 6,
    header: `${wideLedgerHeader} xl:grid-cols-[minmax(0,1fr)_6.5rem_6rem_7.5rem_6rem_20.5rem]`,
    row: `${wideLedgerRow} xl:grid-cols-[minmax(0,1fr)_6.5rem_6rem_7.5rem_6rem_20.5rem]`,
  },
} as const;

export const billingPaymentHeaderClass = ledgerHeader;
export const billingPaymentRowClass = ledgerRow;

export function billingPaymentGridColumns(canRefundPayments: boolean) {
  return canRefundPayments
    ? "lg:grid-cols-[minmax(0,1fr)_11rem_9rem_17rem]"
    : "lg:grid-cols-[minmax(0,1fr)_11rem_9rem]";
}
