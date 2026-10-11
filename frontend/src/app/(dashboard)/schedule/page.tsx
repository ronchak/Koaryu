"use client";

import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { markDashboardReadiness } from "@/lib/performance";
import { parseScheduleTarget } from "@/lib/route-targets";
import { SchedulePageContent } from "@/components/schedule/schedule-page-content";
import { useSchedulePageController } from "@/lib/schedule-page-controller";
import {
  useConfigStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";

export default function SchedulePage() {
  const { identityGeneration, identityReady } = useStudioStore();
  const studentsStore = useStudentStore();
  const programsStore = useProgramStore();
  const scheduleStore = useScheduleStore();
  const config = useConfigStore();
  // Read during render so a link from another page opens on its day, not today's month.
  const searchParams = useSearchParams();
  const routeTarget = useMemo(
    () => parseScheduleTarget(searchParams, { allowPreviewIds: config.isPreviewMode }),
    [config.isPreviewMode, searchParams],
  );
  const { contentProps } = useSchedulePageController({
    config,
    programsStore,
    scheduleStore,
    studentsStore,
    routeTarget,
  });

  const usefulReady =
    identityReady && contentProps.hasLoadedRange && !contentProps.scheduleLoadError;
  const completeReady =
    usefulReady &&
    !contentProps.isRefreshingRange &&
    programsStore.programsLoaded &&
    !programsStore.programsLoadError;
  useEffect(
    () =>
      markDashboardReadiness("schedule", identityGeneration, {
        useful: usefulReady,
        complete: completeReady,
      }),
    [identityGeneration, usefulReady, completeReady],
  );

  return <SchedulePageContent {...contentProps} />;
}
