"use client";

import { BillingPageContent } from "@/components/billing/billing-page-content";
import { useBillingPageController } from "@/lib/billing-page-controller";
import { useConfigStore, useProgramStore, useStudentStore, useStudioStore } from "@/lib/store";

export default function BillingPage() {
  const config = useConfigStore();
  const programsStore = useProgramStore();
  const studentsStore = useStudentStore();
  const studioStore = useStudioStore();
  const { contentProps } = useBillingPageController({
    config,
    programsStore,
    studentsStore,
    studioStore,
  });

  return <BillingPageContent {...contentProps} />;
}
