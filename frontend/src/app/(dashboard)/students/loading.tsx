import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Students"
      description="Loading roster, filters, and student actions."
      variant="table"
    />
  );
}
