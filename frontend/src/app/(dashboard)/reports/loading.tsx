import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Reports"
      description="Loading studio reporting panels and export controls."
      variant="table"
    />
  );
}
