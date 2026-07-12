"use client";

import { Fragment } from "react";
import Link from "next/link";
import { ProgressBar, RankBadge } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { isEligibilityEntryReady, type EligibilityGroup } from "@/lib/belt-tracker-page-model";
import type { BeltRank, EligibilityEntry } from "@/types";
import {
  AlertTriangle,
  Award,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Settings,
  Users,
} from "lucide-react";

type EligibilityPanelProps = {
  canConfigureBelts: boolean;
  canPromoteStudents: boolean;
  collapsedGroups: Set<string>;
  eligibilityGroups: EligibilityGroup[];
  eligibilityLoadError: string | null;
  isEligibilityLoading: boolean;
  isEligibilityLoadErrorDismissed: boolean;
  isProgramsLoadErrorDismissed: boolean;
  ladderError: string | null;
  onConfigureRanks: () => void;
  onDismissEligibilityLoadError: () => void;
  onDismissLadderError: () => void;
  onDismissProgramsLoadError: () => void;
  onStartPromotion: (entry: EligibilityEntry) => void;
  onToggleGroup: (groupKey: string) => void;
  onViewStudents: () => void;
  programsLoadError: string | null;
  rankById: Map<string, BeltRank>;
  selectedProgramName: string | null;
};

export function EligibilityPanel({
  canConfigureBelts,
  canPromoteStudents,
  collapsedGroups,
  eligibilityGroups,
  eligibilityLoadError,
  isEligibilityLoading,
  isEligibilityLoadErrorDismissed,
  isProgramsLoadErrorDismissed,
  ladderError,
  onConfigureRanks,
  onDismissEligibilityLoadError,
  onDismissLadderError,
  onDismissProgramsLoadError,
  onStartPromotion,
  onToggleGroup,
  onViewStudents,
  programsLoadError,
  rankById,
  selectedProgramName,
}: EligibilityPanelProps) {
  return (
    <div className="flex-1 overflow-x-auto">
      {ladderError && (
        <div className="mx-8 mt-6">
          <DismissibleNotice tone="danger" onDismiss={onDismissLadderError}>
            {ladderError}
          </DismissibleNotice>
        </div>
      )}
      {programsLoadError && !isProgramsLoadErrorDismissed && (
        <div className="mx-8 mt-6">
          <DismissibleNotice tone="danger" onDismiss={onDismissProgramsLoadError}>
            {programsLoadError}
          </DismissibleNotice>
        </div>
      )}
      {eligibilityLoadError && !isEligibilityLoading && !isEligibilityLoadErrorDismissed && (
        <div className="mx-8 mt-6">
          <DismissibleNotice tone="danger" onDismiss={onDismissEligibilityLoadError}>
            {eligibilityLoadError}
          </DismissibleNotice>
        </div>
      )}

      {isEligibilityLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Clock className="w-8 h-8 text-muted mb-3 animate-pulse" />
          <p className="text-sm text-text-secondary">
            Loading eligibility for {selectedProgramName || "this program"}...
          </p>
        </div>
      ) : eligibilityGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Award className="w-8 h-8 text-muted mb-3" />
          <p className="text-sm text-text-secondary">
            {selectedProgramName
              ? `No active students are ready in ${selectedProgramName} yet.`
              : "No active students to evaluate."}
          </p>
          <div className="mt-4 flex items-center gap-3">
            {canConfigureBelts ? (
              <Button variant="secondary" size="sm" onClick={onConfigureRanks}>
                <Settings className="w-3.5 h-3.5" />
                Configure ranks
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={onViewStudents}>
              <Users className="w-3.5 h-3.5" />
              View students
            </Button>
          </div>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary">Student</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Current Rank</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Next Rank</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-44">Classes</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary w-44">Time at Rank</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-text-secondary">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {eligibilityGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.key);

              return (
                <Fragment key={group.key}>
                  <tr className="border-b border-border bg-surface-raised/60">
                    <td colSpan={7} className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onToggleGroup(group.key)}
                        className="flex w-full items-center justify-between gap-4 text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          {isCollapsed
                            ? <ChevronRight className="w-4 h-4 text-muted" />
                            : <ChevronDown className="w-4 h-4 text-muted" />}
                          {group.rank && group.color
                            ? (
                              <RankBadge
                                name={group.label}
                                color={group.color}
                                isTip={group.rank.is_tip}
                                tipColor={group.rank.tip_color_hex ?? undefined}
                              />
                            )
                            : (
                              <span className="inline-flex items-center rounded-[4px] border border-border px-2 py-0.5 text-xs font-medium text-text-secondary">
                                {group.label}
                              </span>
                            )}
                          <span className="text-xs text-muted">
                            {group.entries.length} student{group.entries.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          {group.eligibleCount > 0 && (
                            <span className="text-success">{group.eligibleCount} eligible</span>
                          )}
                          {group.approvalCount > 0 && (
                            <span className="text-warning">{group.approvalCount} need approval</span>
                          )}
                        </div>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed && group.entries.map((entry) => {
                    const allMet = isEligibilityEntryReady(entry);
                    const currentRank = entry.current_rank_id ? rankById.get(entry.current_rank_id) : undefined;
                    const nextRank = entry.next_rank_id ? rankById.get(entry.next_rank_id) : undefined;
                    return (
                      <tr
                        key={`${entry.student_program_membership_id ?? entry.program_id ?? "legacy"}-${entry.student_id}`}
                        className="border-b border-border hover:bg-surface-raised/50 transition-colors"
                      >
                        <td className="px-6 py-3">
                          <Link
                            href={`/students/${entry.student_id}`}
                            className="inline-flex rounded-[4px] font-medium text-text-primary transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                          >
                            {entry.student_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          {entry.current_rank_name && entry.current_rank_color
                            ? (
                              <RankBadge
                                name={entry.current_rank_name}
                                color={entry.current_rank_color}
                                isTip={currentRank?.is_tip}
                                tipColor={currentRank?.tip_color_hex ?? undefined}
                              />
                            )
                            : <span className="text-xs text-muted">Unranked</span>}
                        </td>
                        <td className="px-4 py-3">
                          {entry.next_rank_name && entry.next_rank_color
                            ? (
                              <RankBadge
                                name={entry.next_rank_name}
                                color={entry.next_rank_color}
                                isTip={nextRank?.is_tip}
                                tipColor={nextRank?.tip_color_hex ?? undefined}
                              />
                            )
                            : <span className="text-xs text-muted">{"\u2014"}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar
                            current={entry.classes_since_promo}
                            required={entry.classes_required}
                            met={entry.classes_met}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <ProgressBar
                            current={entry.days_at_rank}
                            required={entry.days_required}
                            met={entry.time_met}
                          />
                        </td>
                        <td className="px-4 py-3">
                          {allMet
                            ? entry.needs_approval
                              ? (
                                <span className="flex items-center gap-1 text-xs text-warning">
                                  <AlertTriangle className="w-3 h-3" />Needs approval
                                </span>
                              )
                              : (
                                <span className="flex items-center gap-1 text-xs text-success">
                                  <Check className="w-3 h-3" />Eligible
                                </span>
                              )
                            : (
                              <span className="flex items-center gap-1 text-xs text-muted">
                                <Clock className="w-3 h-3" />In progress
                              </span>
                            )}
                        </td>
                        <td className="px-4 py-3">
                          {allMet && canPromoteStudents && (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={!entry.next_rank_id}
                              onClick={() => {
                                if (!entry.next_rank_id) {
                                  return;
                                }
                                onStartPromotion(entry);
                              }}
                            >
                              <ChevronUp className="w-3 h-3" />Promote
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
