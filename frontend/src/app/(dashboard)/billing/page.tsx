"use client";

import { Suspense } from "react";
import { BillingPageContent } from "@/components/billing/billing-page-content";
import { useBillingPageController } from "@/lib/billing-page-controller";
import { useConfigStore, useProgramStore, useStudentStore, useStudioStore } from "@/lib/store";

function BillingPageWithSearchParams() {
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

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingPageWithSearchParams />
    </Suspense>
  );
}
