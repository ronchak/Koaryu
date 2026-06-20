import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Dashboard"
      description="Preparing the roster, leads, classes, and rank snapshot."
    />
  );
}
