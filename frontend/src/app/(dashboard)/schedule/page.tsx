"use client";

import { useEffect } from "react";
import { markDashboardReadiness } from "@/lib/performance";
import { SchedulePageContent } from "@/components/schedule/schedule-page-content";
import { useSchedulePageController } from "@/lib/schedule-page-controller";
import { useConfigStore, useProgramStore, useScheduleStore, useStudentStore, useStudioStore } from "@/lib/store";

export default function SchedulePage() {
  const { identityGeneration, identityReady } = useStudioStore();
  const studentsStore = useStudentStore();
  const programsStore = useProgramStore();
  const scheduleStore = useScheduleStore();
  const { contentProps } = useSchedulePageController({
    config: useConfigStore(),
    programsStore,
    scheduleStore,
    studentsStore,
  });

  const usefulReady = identityReady && contentProps.hasLoadedRange && !contentProps.scheduleLoadError;
  const completeReady = usefulReady && !contentProps.isRefreshingRange && programsStore.programsLoaded && !programsStore.programsLoadError;
  useEffect(() => markDashboardReadiness("schedule", identityGeneration, {
    useful: usefulReady, complete: completeReady,
  }), [identityGeneration, usefulReady, completeReady]);

  return <SchedulePageContent {...contentProps} />;
}
