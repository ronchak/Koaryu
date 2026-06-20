"use client";

import { DashboardPageContent } from "@/components/dashboard/dashboard-page-content";
import { useDashboardPageController } from "@/lib/dashboard-page-controller";
import {
  useBeltStore,
  useConfigStore,
  useDashboardStore,
  useLeadStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";

export default function DashboardPage() {
  const config = useConfigStore();
  const dashboardStore = useDashboardStore();
  const studioStore = useStudioStore();
  const studentsStore = useStudentStore();
  const leadStore = useLeadStore();
  const programsStore = useProgramStore();
  const scheduleStore = useScheduleStore();
  const beltStore = useBeltStore();
  const { contentProps } = useDashboardPageController({
    beltStore,
    config,
    dashboardStore,
    leadStore,
    programsStore,
    scheduleStore,
    studentsStore,
    studioStore,
  });

  return <DashboardPageContent {...contentProps} />;
}
