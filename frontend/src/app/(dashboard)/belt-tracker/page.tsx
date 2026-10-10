"use client";
import { useEffect } from "react";
import { markDashboardReadiness } from "@/lib/performance";

import { BeltTrackerDialogs } from "@/components/belt-tracker/belt-tracker-dialogs";
import { BeltTrackerShell } from "@/components/belt-tracker/belt-tracker-shell";
import { EligibilityLoading, EligibilityPanel } from "@/components/belt-tracker/eligibility-panel";
import { RankPlanPanel } from "@/components/belt-tracker/rank-plan-panel";
import { hasStaffPermission } from "@/lib/staff-permissions";
import styles from "@/components/belt-tracker/belt-tracker.module.css";
import { useBeltTrackerPageController } from "@/lib/belt-tracker-page-controller";
import { useBeltStore, useConfigStore, useProgramStore, useStudioStore } from "@/lib/store";

export default function BeltTrackerPage() {
  const {
    beltLaddersLoadError,
    currentLadderId,
    eligibilityLadderId,
    eligibilityPendingLadderId,
    eligibilityLoadError,
  } = useBeltStore();
  const { programsLoaded, programsLoadError } = useProgramStore();
  const { retryInitialization, identityGeneration, identityReady, currentRole } = useStudioStore();
  const { isPreviewMode } = useConfigStore();
  const loadError = beltLaddersLoadError || (!programsLoaded ? programsLoadError : null);
  const useful = identityReady && programsLoaded && !loadError;
  const complete =
    useful &&
    !eligibilityLoadError &&
    (!currentLadderId || (eligibilityLadderId === currentLadderId && !eligibilityPendingLadderId));
  useEffect(
    () => markDashboardReadiness("belt-tracker", identityGeneration, { useful, complete }),
    [identityGeneration, useful, complete],
  );
  if (!programsLoaded) {
    return (
      <BeltTrackerShell
        actionMessage={null}
        beltPrograms={[]}
        canConfigureBelts={identityReady && hasStaffPermission(currentRole, "configure_belts")}
        dirty={false}
        isEditing={false}
        isSwitchingLadder={false}
        onDismissActionMessage={() => {}}
        onSelectProgram={() => {}}
        onTabChange={() => {}}
        programsLoaded={false}
        selectedProgramId={null}
        tab="eligibility"
        showBeltTestsLink={isPreviewMode || (identityReady && currentRole === "admin")}
      >
        <div className={styles.eligibilityWorkspace}>
          {loadError ? (
            <section role="alert">
              <h2 className="text-lg font-semibold">Belt plans unavailable</h2>
              <p className="mt-2 text-sm">{loadError}</p>
              <button
                type="button"
                onClick={retryInitialization}
                className="mt-4 rounded border border-border px-4 py-2"
              >
                Retry belt plans
              </button>
            </section>
          ) : (
            <EligibilityLoading />
          )}
        </div>
      </BeltTrackerShell>
    );
  }
  return <ReadyBeltTrackerPage loadError={loadError} onRetry={retryInitialization} />;
}

function ReadyBeltTrackerPage({
  loadError,
  onRetry,
}: {
  loadError: string | null;
  onRetry: () => void;
}) {
  const { isPreviewMode, currentRole } = useConfigStore();
  const controller = useBeltTrackerPageController({
    beltStore: useBeltStore(),
    config: useConfigStore(),
    programsStore: useProgramStore(),
  });

  return (
    <>
      <BeltTrackerShell
        {...controller.shellProps}
        showBeltTestsLink={isPreviewMode || currentRole === "admin"}
      >
        {loadError ? (
          <div role="alert" className="px-4 py-3 sm:px-6 lg:px-8">
            <p className="text-sm text-danger">{loadError}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded border border-border px-4 py-2"
            >
              Retry belt plans
            </button>
          </div>
        ) : null}
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
