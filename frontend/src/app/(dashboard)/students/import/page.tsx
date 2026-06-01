"use client";

import { StudentImportPageContent } from "@/components/students/student-import-page-content";
import { useConfigStore, useStudentStore } from "@/lib/store";
import { useStudentImportPageController } from "@/lib/student-import-page-controller";

export default function ImportPage() {
  const controller = useStudentImportPageController({
    config: useConfigStore(),
    studentsStore: useStudentStore(),
  });

  return <StudentImportPageContent {...controller.contentProps} />;
}
