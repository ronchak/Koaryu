"use client";

import type { ReactNode } from "react";
import { Header } from "@/components/header";
import { ProgramPicker } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { Program } from "@/types";
import { Award, Settings } from "lucide-react";
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
  return (
    <div className={`flex min-h-full flex-col ${styles.beltPage}`}>
      <Header title="Belt Tracker">
        {tab === "eligibility" && canConfigureBelts ? (
          <Button variant="secondary" size="sm" onClick={() => onTabChange("ladder")}>
            <Settings className="w-3.5 h-3.5" />
            Configure ranks
          </Button>
        ) : tab === "ladder" ? (
          <Button variant="secondary" size="sm" onClick={() => onTabChange("eligibility")}>
            <Award className="w-3.5 h-3.5" />
            View eligibility
          </Button>
        ) : null}
      </Header>

      <div className="flex-1 flex flex-col">
        <div className={`mx-4 flex items-center gap-2 px-2 py-2 sm:mx-6 lg:mx-8 ${styles.beltControls}`}>
          {TABS.filter((item) => item.id !== "ladder" || canConfigureBelts).map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`min-h-11 rounded-[10px] px-3 text-sm cursor-pointer transition-colors ${
                tab === item.id
                  ? "bg-surface-raised text-text-primary font-medium"
                  : "text-text-secondary hover:bg-surface-raised/60 hover:text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {beltPrograms.length > 0 ? (
              <div className="w-full min-w-0 sm:w-64">
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
          <div className="px-8 pt-4">
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
