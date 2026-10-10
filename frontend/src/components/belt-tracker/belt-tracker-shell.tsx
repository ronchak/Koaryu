"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Header } from "@/components/header";
import { ProgramPicker } from "@/components/programs/program-picker";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { HorizonPage, HorizonStats, type HorizonStat } from "@/components/ui/horizon";
import { SlidingSegmentedControl } from "@/components/ui/sliding-segmented-control";
import type { EligibilitySummary } from "@/lib/belt-tracker-page-model";
import type { Program } from "@/types";
import styles from "./belt-tracker.module.css";

export type BeltTrackerTab = "eligibility" | "ladder";

/** What the page knows about this plan's students right now. */
export type BeltTrackerOutlook =
  { state: "loading" } | { state: "unavailable" } | { state: "ready"; summary: EligibilitySummary };

type BeltTrackerShellProps = {
  actionMessage: string | null;
  beltPrograms: Program[];
  canConfigureBelts: boolean;
  children: ReactNode;
  dirty: boolean;
  isEditing: boolean;
  isSwitchingLadder: boolean;
  onDismissActionMessage: () => void;
  onSelectProgram: (programId: string | null) => void;
  onTabChange: (tab: BeltTrackerTab) => void;
  outlook?: BeltTrackerOutlook;
  programsLoaded: boolean;
  selectedProgramId: string | null;
  tab: BeltTrackerTab;
  showBeltTestsLink?: boolean;
};

const TABS: { id: BeltTrackerTab; label: string }[] = [
  { id: "eligibility", label: "Promotions" },
  { id: "ladder", label: "Rank Plan" },
];

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

function describeOutlook(outlook: BeltTrackerOutlook | undefined) {
  if (!outlook || outlook.state === "loading") return "Checking who is ready for their next belt.";
  if (outlook.state === "unavailable") return "Promotion readiness is unavailable right now.";
  const { approval, closest, progress, ready, total } = outlook.summary;
  if (total === 0) return "No active students are on this plan yet.";
  const waiting = ready + approval;
  if (waiting === 0) {
    return closest
      ? `No one is ready yet. ${closest.student_name} is closest to ${closest.next_rank_name ?? "the next belt"}.`
      : "No one is ready for the next belt yet.";
  }
  const parts = [
    ready > 0 ? `${count(ready, "student")} ready to promote` : null,
    approval > 0 ? `${count(approval, "student")} awaiting approval` : null,
  ].filter(Boolean);
  return `${parts.join(", ")}. ${progress} still working toward the next belt.`;
}

function outlookStats(outlook: BeltTrackerOutlook | undefined): HorizonStat[] {
  if (!outlook || outlook.state === "unavailable") return [];
  if (outlook.state === "loading") {
    return [
      "Ready to promote",
      "Awaiting approval",
      "Working toward next belt",
      "On this plan",
    ].map((label) => ({ id: label, label, pending: true }));
  }
  const { approval, closest, progress, ready, total } = outlook.summary;
  return [
    {
      id: "ready",
      label: "Ready to promote",
      value: ready,
      note: ready > 0 ? "Requirements met" : "No one yet",
      tone: ready > 0 ? "calm" : undefined,
    },
    {
      id: "approval",
      label: "Awaiting approval",
      value: approval,
      note: approval > 0 ? "Needs an instructor" : "None waiting",
      tone: approval > 0 ? "warn" : undefined,
    },
    {
      id: "progress",
      label: "Working toward next belt",
      value: progress,
      note: closest ? `Closest: ${closest.student_name}` : "Everyone is ready",
    },
    {
      id: "total",
      label: "On this plan",
      value: total,
      unit: total === 1 ? "student" : "students",
      note: "Active in this program",
    },
  ];
}

export function BeltTrackerShell({
  actionMessage,
  beltPrograms,
  canConfigureBelts,
  children,
  dirty,
  isEditing,
  isSwitchingLadder,
  onDismissActionMessage,
  onSelectProgram,
  onTabChange,
  outlook,
  programsLoaded,
  selectedProgramId,
  tab,
  showBeltTestsLink = false,
}: BeltTrackerShellProps) {
  const visibleTabs = TABS.filter((item) => item.id !== "ladder" || canConfigureBelts);
  const selectedProgram = beltPrograms.find((program) => program.id === selectedProgramId);
  const locked = dirty || isEditing || isSwitchingLadder;

  return (
    <div className={styles.beltPage}>
      <Header
        eyebrow={selectedProgram?.name ?? "Belt ranks"}
        title="Belt Tracker"
        description={describeOutlook(outlook)}
      >
        {showBeltTestsLink &&
          (locked ? (
            <span aria-disabled="true" className={styles.headerLinkDisabled}>
              <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
              Belt tests
            </span>
          ) : (
            <Button asChild variant="secondary">
              <Link href="/belt-tests">
                <ClipboardCheck aria-hidden="true" className="h-4 w-4" />
                Belt tests
              </Link>
            </Button>
          ))}
      </Header>

      <HorizonPage className={styles.beltBody}>
        <HorizonStats label="Promotion readiness" items={outlookStats(outlook)} />

        <div className={styles.beltControls}>
          <SlidingSegmentedControl
            activeValue={tab}
            ariaLabel="Belt tracker view"
            className={styles.beltTabs}
            idPrefix="belt-tab"
            items={visibleTabs.map((item) => ({
              ...item,
              disabled: !programsLoaded,
              controls: `belt-panel-${item.id}`,
            }))}
            mode="tabs"
            onChange={onTabChange}
          />
          <div className={styles.beltProgramControl}>
            {dirty ? (
              <p className={styles.beltProgramLockNotice}>
                Save or discard changes before switching programs.
              </p>
            ) : null}
            {beltPrograms.length > 0 ? (
              <div className={styles.beltProgramPicker}>
                <ProgramPicker
                  programs={beltPrograms}
                  value={selectedProgramId ?? ""}
                  onChange={onSelectProgram}
                  disabled={locked}
                />
              </div>
            ) : programsLoaded ? (
              <span className={styles.toolbarMeta}>No programs yet</span>
            ) : (
              <div
                className={`koaryu-skeleton-reveal ${styles.programPending}`}
                role="status"
                aria-live="polite"
              >
                <span className="sr-only">Loading programs.</span>
              </div>
            )}
          </div>
        </div>

        {actionMessage ? (
          <DismissibleNotice tone="success" onDismiss={onDismissActionMessage}>
            {actionMessage}
          </DismissibleNotice>
        ) : null}

        {children}
      </HorizonPage>
    </div>
  );
}
