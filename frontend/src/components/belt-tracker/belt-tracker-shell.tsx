"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { Header } from "@/components/header";
import { ProgramPicker } from "@/components/programs/program-picker";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { Program } from "@/types";
import styles from "./belt-tracker.module.css";

export type BeltTrackerTab = "eligibility" | "ladder";

type BeltTrackerShellProps = {
  actionMessage: string | null;
  beltPrograms: Program[];
  canConfigureBelts: boolean;
  children: ReactNode;
  dirty: boolean;
  isSwitchingLadder: boolean;
  onDismissActionMessage: () => void;
  onSelectProgram: (programId: string | null) => void;
  onTabChange: (tab: BeltTrackerTab) => void;
  programsLoaded: boolean;
  selectedProgramId: string | null;
  tab: BeltTrackerTab;
};

const TABS: { id: BeltTrackerTab; label: string }[] = [
  { id: "eligibility", label: "Eligibility" },
  { id: "ladder", label: "Rank Plan" },
];

export function BeltTrackerShell({
  actionMessage,
  beltPrograms,
  canConfigureBelts,
  children,
  dirty,
  isSwitchingLadder,
  onDismissActionMessage,
  onSelectProgram,
  onTabChange,
  programsLoaded,
  selectedProgramId,
  tab,
}: BeltTrackerShellProps) {
  const visibleTabs = TABS.filter((item) => item.id !== "ladder" || canConfigureBelts);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentTab: BeltTrackerTab) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const currentIndex = visibleTabs.findIndex((item) => item.id === currentTab);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length;
    const nextTab = visibleTabs[nextIndex];
    if (!nextTab) return;

    onTabChange(nextTab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`belt-tab-${nextTab.id}`)?.focus();
    });
  }

  return (
    <div className={`flex min-h-full flex-col ${styles.beltPage}`}>
      <Header title="Belt Tracker" />

      <div className="flex-1 flex flex-col">
        <div className={`mx-4 sm:mx-6 lg:mx-8 ${styles.beltControls}`}>
          <div className={styles.beltTabs} role="tablist" aria-label="Belt tracker view">
            {visibleTabs.map((item) => (
              <button
                key={item.id}
                id={`belt-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`belt-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => onTabChange(item.id)}
                onKeyDown={(event) => handleTabKeyDown(event, item.id)}
                className={styles.beltTab}
                data-active={tab === item.id ? "true" : "false"}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className={styles.beltProgramControl}>
            {beltPrograms.length > 0 ? (
              <div className={styles.beltProgramPicker}>
                <ProgramPicker
                  programs={beltPrograms}
                  value={selectedProgramId ?? ""}
                  onChange={onSelectProgram}
                  disabled={dirty || isSwitchingLadder}
                />
              </div>
            ) : (
              <span className="text-xs text-muted">
                {programsLoaded ? "No programs yet" : "Loading programs..."}
              </span>
            )}
          </div>
        </div>

        {dirty ? (
          <p className={styles.beltProgramLockNotice}>
            Save or discard changes before switching programs.
          </p>
        ) : null}

        {actionMessage ? (
          <div className={styles.beltActionNotice}>
            <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
              {actionMessage}
            </DismissibleNotice>
          </div>
        ) : null}

        {children}
      </div>
    </div>
  );
}
