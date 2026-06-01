"use client";

import { StudentRosterPageContent } from "@/components/students/student-roster-page-content";
import { useProgramStore, useScheduleStore, useStudentStore } from "@/lib/store";
import { useStudentsPageController } from "@/lib/students-page-controller";

export default function StudentsPage() {
  const controller = useStudentsPageController({
    programsStore: useProgramStore(),
    scheduleStore: useScheduleStore(),
    studentsStore: useStudentStore(),
  });

  return <StudentRosterPageContent {...controller.contentProps} />;
}
