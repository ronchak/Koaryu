"use client";

import { useEffect } from "react";
import { markDashboardReadiness } from "@/lib/performance";
import { StudentRosterPageContent } from "@/components/students/student-roster-page-content";
import {
  useBeltStore,
  useConfigStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";
import { useStudentsPageController } from "@/lib/students-page-controller";

export default function StudentsPage() {
  const studioStore = useStudioStore();
  // Read-only: belt names and colours for rows whose membership carries only a rank id.
  const { beltRanks } = useBeltStore();
  const controller = useStudentsPageController({
    config: useConfigStore(),
    programsStore: useProgramStore(),
    scheduleStore: useScheduleStore(),
    studentsStore: useStudentStore(),
    studioStore,
  });

  const { identityGeneration, identityReady } = studioStore;
  const { activeLoadError, isInitialRosterLoading, isPagedLoading, isRosterRefreshing } =
    controller.contentProps;
  const usefulReady = identityReady && !isInitialRosterLoading && !activeLoadError;
  const completeReady = usefulReady && !isPagedLoading && !isRosterRefreshing;
  useEffect(
    () =>
      markDashboardReadiness("students", identityGeneration, {
        useful: usefulReady,
        complete: completeReady,
      }),
    [identityGeneration, usefulReady, completeReady],
  );

  return <StudentRosterPageContent {...controller.contentProps} beltRanks={beltRanks} />;
}
