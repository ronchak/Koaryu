"use client";
import { useEffect, useMemo } from "react";
import { markDashboardReadiness } from "@/lib/performance";

import { BeltTrackerDialogs } from "@/components/belt-tracker/belt-tracker-dialogs";
import {
  BeltTrackerShell,
  type BeltTrackerOutlook,
} from "@/components/belt-tracker/belt-tracker-shell";
import { EligibilityLoading, EligibilityPanel } from "@/components/belt-tracker/eligibility-panel";
import { RankPlanPanel } from "@/components/belt-tracker/rank-plan-panel";
import { Button } from "@/components/ui/button";
import { HorizonPanel } from "@/components/ui/horizon";
import { summarizeEligibility, type EligibilityGroup } from "@/lib/belt-tracker-page-model";
import { hasStaffPermission } from "@/lib/staff-permissions";
import styles from "@/components/belt-tracker/belt-tracker.module.css";
import { useBeltTrackerPageController } from "@/lib/belt-tracker-page-controller";
import { useBeltStore, useConfigStore, useProgramStore, useStudioStore } from "@/lib/store";

const NO_GROUPS: EligibilityGroup[] = [];

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
        outlook={loadError ? { state: "unavailable" } : { state: "loading" }}
        showBeltTestsLink={isPreviewMode || (identityReady && currentRole === "admin")}
      >
        <div className={styles.eligibilityWorkspace}>
          {loadError ? (
            <section role="alert">
              <HorizonPanel title="Belt plans unavailable">
                <div className={styles.retryLine}>
                  <p>{loadError}</p>
                  <Button variant="secondary" size="sm" onClick={retryInitialization}>
                    Retry belt plans
                  </Button>
                </div>
              </HorizonPanel>
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
  const { eligibilityLoadError, hasLoadedEligibility, isEligibilityLoading } =
    controller.eligibilityPanelProps;
  const eligibilityGroups = controller.eligibilityPanelProps.eligibilityGroups ?? NO_GROUPS;
  const summary = useMemo(() => summarizeEligibility(eligibilityGroups), [eligibilityGroups]);
  const studentCountByRankId = useMemo(
    () => new Map(eligibilityGroups.map((group) => [group.key, group.entries.length])),
    [eligibilityGroups],
  );
  const hasRetainedEligibility = hasLoadedEligibility || eligibilityGroups.length > 0;
  const outlook: BeltTrackerOutlook = hasRetainedEligibility
    ? { state: "ready", summary }
    : isEligibilityLoading
      ? { state: "loading" }
      : eligibilityLoadError || loadError
        ? { state: "unavailable" }
        : { state: "ready", summary };

  return (
    <>
      <BeltTrackerShell
        {...controller.shellProps}
        outlook={outlook}
        showBeltTestsLink={isPreviewMode || currentRole === "admin"}
      >
        {loadError ? (
          <div role="alert" className={styles.retryLine}>
            <p>{loadError}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry belt plans
            </Button>
          </div>
        ) : null}
        {controller.tab === "eligibility" ? (
          <EligibilityPanel {...controller.eligibilityPanelProps} />
        ) : (
          <RankPlanPanel
            {...controller.rankPlanPanelProps}
            studentCountByRankId={hasRetainedEligibility ? studentCountByRankId : null}
          />
        )}
      </BeltTrackerShell>

      <BeltTrackerDialogs {...controller.dialogsProps} />
    </>
  );
}
