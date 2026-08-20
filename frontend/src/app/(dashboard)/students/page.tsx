"use client";

import { StudentRosterPageContent } from "@/components/students/student-roster-page-content";
import {
  useConfigStore,
  useProgramStore,
  useScheduleStore,
  useStudentStore,
  useStudioStore,
} from "@/lib/store";
import { useStudentsPageController } from "@/lib/students-page-controller";

export default function StudentsPage() {
  const controller = useStudentsPageController({
    config: useConfigStore(),
    programsStore: useProgramStore(),
    scheduleStore: useScheduleStore(),
    studentsStore: useStudentStore(),
    studioStore: useStudioStore(),
  });

  return <StudentRosterPageContent {...controller.contentProps} />;
}
