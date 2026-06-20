import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Billing"
      description="Loading tuition plans, family payers, invoices, and payment readiness."
      variant="billing"
    />
  );
}
