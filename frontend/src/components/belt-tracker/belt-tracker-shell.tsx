"use client";

import type { ReactNode } from "react";
import { Header } from "@/components/header";
import { ProgramPicker } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import type { Program } from "@/types";
import { Award, Settings } from "lucide-react";

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
    <>
      <Header
        title="Belt Tracker"
        description="Track rank progression and promotion readiness."
      >
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
        <div className="flex items-center gap-4 px-8 py-3 border-b border-border">
          {TABS.filter((item) => item.id !== "ladder" || canConfigureBelts).map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`text-sm pb-2 border-b-2 cursor-pointer transition-colors ${
                tab === item.id
                  ? "text-text-primary border-accent font-medium"
                  : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            {beltPrograms.length > 0 ? (
              <div className="w-64">
                <ProgramPicker
                  programs={beltPrograms}
                  value={selectedProgramId ?? ""}
                  onChange={onSelectProgram}
                  disabled={dirty || isSwitchingLadder}
                />
                {dirty && (
                  <p className="mt-1 text-[11px] text-warning">
                    Save or discard changes before switching programs.
                  </p>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted">
                {programsLoaded ? "No programs yet" : "Loading programs..."}
              </span>
            )}
          </div>
        </div>

        {actionMessage ? (
          <div className="px-8 pt-4">
            <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
              {actionMessage}
            </DismissibleNotice>
          </div>
        ) : null}

        {children}
      </div>
    </>
  );
}
