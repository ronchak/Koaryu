"use client";

import { StudentDetailPageContent } from "@/components/students/student-detail-page-content";
import { useBeltStore, useConfigStore, useProgramStore, useStudentStore } from "@/lib/store";
import { useStudentDetailPageController } from "@/lib/student-detail-page-controller";

export default function StudentDetailPage() {
  const controller = useStudentDetailPageController({
    beltStore: useBeltStore(),
    config: useConfigStore(),
    programsStore: useProgramStore(),
    studentsStore: useStudentStore(),
  });

  return <StudentDetailPageContent {...controller.contentProps} />;
}
