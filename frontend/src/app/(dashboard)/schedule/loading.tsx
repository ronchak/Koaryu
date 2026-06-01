import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Schedule"
      description="Loading classes, attendance state, and calendar controls."
      variant="calendar"
    />
  );
}
