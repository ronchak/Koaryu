"use client";

import { SchedulePageContent } from "@/components/schedule/schedule-page-content";
import { useSchedulePageController } from "@/lib/schedule-page-controller";
import { useProgramStore, useScheduleStore, useStudentStore } from "@/lib/store";

export default function SchedulePage() {
  const studentsStore = useStudentStore();
  const programsStore = useProgramStore();
  const scheduleStore = useScheduleStore();
  const { contentProps } = useSchedulePageController({
    programsStore,
    scheduleStore,
    studentsStore,
  });

  return <SchedulePageContent {...contentProps} />;
}
