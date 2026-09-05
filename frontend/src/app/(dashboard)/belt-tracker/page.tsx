"use client";

import { BeltTrackerDialogs } from "@/components/belt-tracker/belt-tracker-dialogs";
import { BeltTrackerShell } from "@/components/belt-tracker/belt-tracker-shell";
import { EligibilityPanel } from "@/components/belt-tracker/eligibility-panel";
import { RankPlanPanel } from "@/components/belt-tracker/rank-plan-panel";
import { useBeltTrackerPageController } from "@/lib/belt-tracker-page-controller";
import { useBeltStore, useConfigStore, useProgramStore, useStudioStore } from "@/lib/store";

export default function BeltTrackerPage() {
  const { beltLaddersLoadError } = useBeltStore();
  const { programsLoaded, programsLoadError } = useProgramStore();
  const { retryInitialization } = useStudioStore();
  const loadError = beltLaddersLoadError || (!programsLoaded ? programsLoadError : null);
  if (loadError || !programsLoaded) {
    return (
      <section role={loadError ? "alert" : "status"} className="p-6">
        <h1 className="text-lg font-semibold">{loadError ? "Belt plans unavailable" : "Loading belt plans"}</h1>
        {loadError && <p className="mt-2 text-sm">{loadError}</p>}
        {loadError && <button type="button" onClick={retryInitialization} className="mt-4 rounded border border-border px-4 py-2">Retry belt plans</button>}
      </section>
    );
  }
  return <ReadyBeltTrackerPage />;
}

function ReadyBeltTrackerPage() {
  const controller = useBeltTrackerPageController({
    beltStore: useBeltStore(),
    config: useConfigStore(),
    programsStore: useProgramStore(),
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
