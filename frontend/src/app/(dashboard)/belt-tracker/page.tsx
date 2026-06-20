"use client";

import { BeltTrackerDialogs } from "@/components/belt-tracker/belt-tracker-dialogs";
import { BeltTrackerShell } from "@/components/belt-tracker/belt-tracker-shell";
import { EligibilityPanel } from "@/components/belt-tracker/eligibility-panel";
import { RankPlanPanel } from "@/components/belt-tracker/rank-plan-panel";
import { useBeltTrackerPageController } from "@/lib/belt-tracker-page-controller";
import { useBeltStore, useConfigStore, useProgramStore, useStudentStore } from "@/lib/store";

export default function BeltTrackerPage() {
  const controller = useBeltTrackerPageController({
    beltStore: useBeltStore(),
    config: useConfigStore(),
    programsStore: useProgramStore(),
    studentsStore: useStudentStore(),
  });

  return (
    <>
      <BeltTrackerShell {...controller.shellProps}>
        {controller.tab === "eligibility" ? (
          <EligibilityPanel {...controller.eligibilityPanelProps} />
        ) : (
          <RankPlanPanel {...controller.rankPlanPanelProps} />
        )}
      </BeltTrackerShell>

      <BeltTrackerDialogs {...controller.dialogsProps} />
    </>
  );
}
