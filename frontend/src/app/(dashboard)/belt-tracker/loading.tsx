import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Belt Tracker"
      description="Loading belt ladders, eligibility, and promotion context."
      variant="table"
    />
  );
}
