import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";

export default function Loading() {
  return (
    <DashboardLoadingSkeleton
      title="Settings"
      description="Loading studio settings, programs, and staff controls."
      variant="settings"
    />
  );
}
