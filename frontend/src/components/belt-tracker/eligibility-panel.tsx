"use client";

import type { CSSProperties } from "react";
import { IntentPrefetchLink as Link } from "@/components/intent-prefetch-link";
import { MartialArtsBelt } from "@/components/icons/martial-arts-belt";
import { BeltSwatch, ProgressBar } from "@/components/belt-tracker/rank-visuals";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { CalmState, HorizonPanel, ToneTag } from "@/components/ui/horizon";
import {
  buildRankLadder,
  isEligibilityEntryReady,
  summarizeEligibility,
  type EligibilityGroup,
  type RankLadderStep,
} from "@/lib/belt-tracker-page-model";
import type { BeltRank, EligibilityEntry } from "@/types";
import { ArrowRight, ChevronDown, ChevronRight, ChevronUp, Settings, Users } from "lucide-react";
import styles from "./belt-tracker.module.css";

type EligibilityPanelProps = {
  canConfigureBelts: boolean;
  canPromoteStudents: boolean;
  collapsedGroups: Set<string>;
  eligibilityGroups: EligibilityGroup[];
  eligibilityLoadError: string | null;
  hasLoadedEligibility: boolean;
  isEligibilityLoading: boolean;
  isEligibilityLoadErrorDismissed: boolean;
  isProgramsLoadErrorDismissed: boolean;
  ladderError: string | null;
  onConfigureRanks: () => void;
  onDismissEligibilityLoadError: () => void;
  onDismissLadderError: () => void;
  onDismissProgramsLoadError: () => void;
  onRetryEligibility: () => void;
  onStartPromotion: (entry: EligibilityEntry) => void;
  onStartDemotion: (entry: EligibilityEntry) => void;
  onToggleGroup: (groupKey: string) => void;
  onViewStudents: () => void;
  programsLoadError: string | null;
  rankById: Map<string, BeltRank>;
  previousRankByCurrentRankId: Map<string, BeltRank>;
  selectedProgramName: string | null;
};

const plural = (value: number, one: string, many = `${one}s`) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

function readinessOf(entry: EligibilityEntry) {
  if (!isEligibilityEntryReady(entry)) return "progress" as const;
  return entry.needs_approval ? ("approval" as const) : ("ready" as const);
}

function ReadinessTag({ entry }: { entry: EligibilityEntry }) {
  const readiness = readinessOf(entry);
  if (readiness === "approval") return <ToneTag tone="warn">Needs approval</ToneTag>;
  if (readiness === "ready") return <ToneTag tone="calm">Ready</ToneTag>;
  return (
    <ToneTag tone="neutral" dot={false}>
      In progress
    </ToneTag>
  );
}

function requirementSummary(entry: EligibilityEntry) {
  const parts = [
    entry.classes_required > 0
      ? `${entry.classes_since_promo.toLocaleString()} of ${plural(entry.classes_required, "class", "classes")}`
      : null,
    entry.days_required > 0
      ? `${entry.days_at_rank.toLocaleString()} of ${plural(entry.days_required, "day")} at rank`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No class or time minimum";
}

function rankRequirement(rank: BeltRank | undefined, entry: EligibilityEntry) {
  const parts = rank
    ? [
        rank.min_classes > 0 ? plural(rank.min_classes, "class", "classes") : null,
        rank.min_months > 0 ? plural(rank.min_months, "month") : null,
        rank.requires_approval ? "instructor approval" : null,
      ]
    : [
        entry.classes_required > 0 ? plural(entry.classes_required, "class", "classes") : null,
        entry.days_required > 0 ? plural(entry.days_required, "day") : null,
      ];
  const words = parts.filter(Boolean);
  return words.length ? words.join(" · ") : "no minimum";
}

export function EligibilityPanel({
  canConfigureBelts,
  canPromoteStudents,
  collapsedGroups,
  eligibilityGroups,
  eligibilityLoadError,
  hasLoadedEligibility,
  isEligibilityLoading,
  isEligibilityLoadErrorDismissed,
  isProgramsLoadErrorDismissed,
  ladderError,
  onConfigureRanks,
  onDismissEligibilityLoadError,
  onDismissLadderError,
  onDismissProgramsLoadError,
  onRetryEligibility,
  onStartPromotion,
  onStartDemotion,
  onToggleGroup,
  onViewStudents,
  programsLoadError,
  rankById,
  previousRankByCurrentRankId,
  selectedProgramName,
}: EligibilityPanelProps) {
  const hasRetainedEligibility = hasLoadedEligibility || eligibilityGroups.length > 0;

  return (
    <div
      id="belt-panel-eligibility"
      role="tabpanel"
      aria-labelledby="belt-tab-eligibility"
      className={styles.eligibilityWorkspace}
      aria-busy={isEligibilityLoading}
    >
      {ladderError && (
        <DismissibleNotice tone="danger" onDismiss={onDismissLadderError}>
          {ladderError}
        </DismissibleNotice>
      )}
      {programsLoadError && !isProgramsLoadErrorDismissed && (
        <DismissibleNotice tone="danger" onDismiss={onDismissProgramsLoadError}>
          {programsLoadError}
        </DismissibleNotice>
      )}
      {eligibilityLoadError && !isEligibilityLoading && !isEligibilityLoadErrorDismissed && (
        <DismissibleNotice tone="danger" onDismiss={onDismissEligibilityLoadError}>
          {eligibilityLoadError}
        </DismissibleNotice>
      )}
      {eligibilityLoadError && !isEligibilityLoading ? (
        <div className={styles.retryLine} role="status">
          <p>
            {hasRetainedEligibility
              ? "Showing the last loaded eligibility. Current eligibility is unavailable."
              : "Student eligibility is unavailable."}
          </p>
          <Button variant="secondary" size="sm" onClick={onRetryEligibility}>
            Retry
          </Button>
        </div>
      ) : null}

      {isEligibilityLoading && !hasLoadedEligibility && !hasRetainedEligibility ? (
        <EligibilityLoading selectedProgramName={selectedProgramName} />
      ) : eligibilityLoadError && !hasRetainedEligibility ? null : eligibilityGroups.length ===
        0 ? (
        <HorizonPanel>
          <CalmState
            tone="neutral"
            icon={<MartialArtsBelt />}
            title="No students to evaluate"
            detail={
              selectedProgramName
                ? `There are no active students to evaluate in ${selectedProgramName} yet.`
                : "No active students to evaluate."
            }
            action={
              <div className={styles.calmActions}>
                {canConfigureBelts ? (
                  <Button variant="secondary" size="sm" onClick={onConfigureRanks}>
                    <Settings aria-hidden="true" className="h-3.5 w-3.5" />
                    Configure ranks
                  </Button>
                ) : null}
                <Button variant="primary" size="sm" onClick={onViewStudents}>
                  <Users aria-hidden="true" className="h-3.5 w-3.5" />
                  View students
                </Button>
              </div>
            }
          />
        </HorizonPanel>
      ) : (
        <>
          <ReadyPanel
            canPromoteStudents={canPromoteStudents}
            eligibilityGroups={eligibilityGroups}
            onStartPromotion={onStartPromotion}
            rankById={rankById}
          />
          <LadderPanel
            canPromoteStudents={canPromoteStudents}
            collapsedGroups={collapsedGroups}
            eligibilityGroups={eligibilityGroups}
            onStartDemotion={onStartDemotion}
            onStartPromotion={onStartPromotion}
            onToggleGroup={onToggleGroup}
            previousRankByCurrentRankId={previousRankByCurrentRankId}
            rankById={rankById}
          />
        </>
      )}
    </div>
  );
}

function ReadyPanel({
  canPromoteStudents,
  eligibilityGroups,
  onStartPromotion,
  rankById,
}: Pick<
  EligibilityPanelProps,
  "canPromoteStudents" | "eligibilityGroups" | "onStartPromotion" | "rankById"
>) {
  const ready = eligibilityGroups.flatMap((group) =>
    group.entries.filter((entry) => isEligibilityEntryReady(entry)),
  );
  const { closest } = summarizeEligibility(eligibilityGroups);

  return (
    <HorizonPanel
      title="Ready for the next belt"
      titleId="belt-ready-title"
      description={
        ready.length
          ? "Class and time requirements are met. Promoting records the new rank."
          : undefined
      }
    >
      {ready.length === 0 ? (
        <CalmState
          tone="neutral"
          icon={<MartialArtsBelt />}
          title="No one is ready yet"
          detail={
            closest
              ? `${closest.student_name} is closest to ${closest.next_rank_name ?? "the next belt"}: ${requirementSummary(closest)}.`
              : "Students appear here once they meet their next rank's requirements."
          }
        />
      ) : (
        <ul className={styles.readyGrid} aria-labelledby="belt-ready-title">
          {ready.map((entry) => {
            const currentRank = entry.current_rank_id
              ? rankById.get(entry.current_rank_id)
              : undefined;
            const nextRank = entry.next_rank_id ? rankById.get(entry.next_rank_id) : undefined;
            const readiness = readinessOf(entry);
            return (
              <li
                key={`${entry.student_program_membership_id ?? entry.program_id ?? "legacy"}-${entry.student_id}`}
                className={styles.readyTile}
                data-readiness={readiness}
              >
                <div className={styles.readyTileHead}>
                  <Link href={`/students/${entry.student_id}`} className={styles.readyName}>
                    {entry.student_name}
                  </Link>
                  <ReadinessTag entry={entry} />
                </div>
                <div className={styles.beltStep}>
                  <span className={styles.beltStepRank}>
                    <BeltSwatch
                      color={entry.current_rank_color}
                      isTip={currentRank?.is_tip}
                      tipColor={currentRank?.tip_color_hex}
                      size="md"
                    />
                    <span>{entry.current_rank_name ?? "Unranked"}</span>
                  </span>
                  <ArrowRight aria-hidden="true" className={styles.beltStepArrow} />
                  <span className={styles.beltStepRank} data-next="true">
                    <BeltSwatch
                      color={entry.next_rank_color}
                      isTip={nextRank?.is_tip}
                      tipColor={nextRank?.tip_color_hex}
                      size="lg"
                    />
                    <strong>{entry.next_rank_name ?? "No next rank"}</strong>
                  </span>
                </div>
                <p className={styles.readyMeta}>
                  {requirementSummary(entry)}
                  {readiness === "approval" ? " · an instructor signs off" : ""}
                </p>
                {canPromoteStudents ? (
                  <Button
                    variant="primary"
                    className={styles.readyAction}
                    disabled={!entry.next_rank_id}
                    aria-label={`Promote ${entry.student_name} to ${entry.next_rank_name ?? "the next rank"}`}
                    onClick={() => {
                      if (!entry.next_rank_id) return;
                      onStartPromotion(entry);
                    }}
                  >
                    <ChevronUp aria-hidden="true" className="h-4 w-4" />
                    Promote
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </HorizonPanel>
  );
}

function LadderChart({ steps }: { steps: RankLadderStep[] }) {
  const most = Math.max(1, ...steps.map((step) => step.count));
  return (
    <ol
      className={styles.ladderChart}
      aria-label="Students at each rank"
      style={{ "--ladder-steps": steps.length } as CSSProperties}
    >
      {steps.map((step) => {
        const waiting = step.eligibleCount + step.approvalCount;
        const body = (
          <>
            <span className={styles.ladderCount}>{step.count}</span>
            <span className={styles.ladderBarSlot}>
              <span
                className={styles.ladderBar}
                data-tip={step.rank?.is_tip && step.rank.tip_color_hex ? "true" : undefined}
                style={
                  {
                    "--belt": step.color || "var(--hz-tile)",
                    "--belt-tip": step.rank?.tip_color_hex ?? undefined,
                    "--share": step.count / most,
                  } as CSSProperties
                }
              />
            </span>
            <span className={styles.ladderName}>{step.label}</span>
            <span className={styles.ladderReady} data-tone={waiting ? "calm" : undefined}>
              {waiting ? `${waiting} ready` : ""}
            </span>
          </>
        );
        const name = `${step.label}: ${plural(step.count, "student")}${waiting ? `, ${waiting} ready` : ""}`;
        return (
          <li key={step.key} data-empty={step.count === 0 ? "true" : undefined}>
            {step.count > 0 ? (
              <a href={`#belt-rank-${step.key}`} className={styles.ladderStep} aria-label={name}>
                {body}
              </a>
            ) : (
              <span className={styles.ladderStep} aria-label={name} role="img">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function LadderPanel({
  canPromoteStudents,
  collapsedGroups,
  eligibilityGroups,
  onStartDemotion,
  onStartPromotion,
  onToggleGroup,
  previousRankByCurrentRankId,
  rankById,
}: Pick<
  EligibilityPanelProps,
  | "canPromoteStudents"
  | "collapsedGroups"
  | "eligibilityGroups"
  | "onStartDemotion"
  | "onStartPromotion"
  | "onToggleGroup"
  | "previousRankByCurrentRankId"
  | "rankById"
>) {
  const steps = buildRankLadder([...rankById.values()], eligibilityGroups);
  const students = eligibilityGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const occupied = steps.filter((step) => step.count > 0).length;

  return (
    <HorizonPanel
      title="Rank ladder"
      titleId="belt-ladder-title"
      description={`${plural(students, "student")} across ${occupied} of ${plural(steps.length, "rank")}. Select a rank to jump to its students.`}
      flush
    >
      <LadderChart steps={steps} />
      <table className={styles.eligibilityTable}>
        <caption className="sr-only">Promotion readiness grouped by current rank</caption>
        <EligibilityTableHead />
        {eligibilityGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.key);
          const nextIds = new Set(group.entries.map((entry) => entry.next_rank_id ?? ""));
          const sharedEntry = nextIds.size === 1 ? group.entries[0] : undefined;
          const sharedNextRank = sharedEntry?.next_rank_id
            ? rankById.get(sharedEntry.next_rank_id)
            : undefined;

          return (
            <tbody key={group.key} id={`belt-rank-${group.key}`} className={styles.rankGroupBody}>
              <tr className={styles.rankGroupHeader}>
                <th colSpan={5} scope="colgroup">
                  <button
                    type="button"
                    onClick={() => onToggleGroup(group.key)}
                    aria-expanded={!isCollapsed}
                    className={styles.rankGroupToggle}
                  >
                    {isCollapsed ? (
                      <ChevronRight aria-hidden="true" className={styles.rankGroupChevron} />
                    ) : (
                      <ChevronDown aria-hidden="true" className={styles.rankGroupChevron} />
                    )}
                    <BeltSwatch
                      color={group.color}
                      isTip={group.rank?.is_tip}
                      tipColor={group.rank?.tip_color_hex}
                      size="lg"
                    />
                    <span className={styles.rankGroupTitle}>
                      <strong>{group.label}</strong>
                      <span>
                        {plural(group.entries.length, "student")}
                        {sharedEntry?.next_rank_name
                          ? ` · next ${sharedEntry.next_rank_name} after ${rankRequirement(sharedNextRank, sharedEntry)}`
                          : ""}
                      </span>
                    </span>
                    <span className={styles.rankGroupTags}>
                      {group.eligibleCount > 0 ? (
                        <ToneTag tone="calm">{group.eligibleCount} ready</ToneTag>
                      ) : null}
                      {group.approvalCount > 0 ? (
                        <ToneTag tone="warn">{group.approvalCount} need approval</ToneTag>
                      ) : null}
                    </span>
                  </button>
                </th>
              </tr>
              {!isCollapsed &&
                group.entries.map((entry) => {
                  const readiness = readinessOf(entry);
                  const nextRank = entry.next_rank_id
                    ? rankById.get(entry.next_rank_id)
                    : undefined;
                  const previousRank = entry.current_rank_id
                    ? previousRankByCurrentRankId.get(entry.current_rank_id)
                    : undefined;
                  return (
                    <tr
                      key={`${entry.student_program_membership_id ?? entry.program_id ?? "legacy"}-${entry.student_id}`}
                      data-readiness={readiness}
                      className={styles.studentRow}
                    >
                      <th scope="row" data-label="Student">
                        <Link href={`/students/${entry.student_id}`} className={styles.studentName}>
                          {entry.student_name}
                        </Link>
                        {sharedEntry ? (
                          <span className="sr-only">
                            {entry.current_rank_name ?? "Unranked"} to{" "}
                            {entry.next_rank_name ?? "no next rank"}
                          </span>
                        ) : (
                          <span className={styles.studentStep}>
                            <span className="sr-only">
                              {entry.current_rank_name ?? "Unranked"} to{" "}
                            </span>
                            <ArrowRight aria-hidden="true" className="h-3 w-3" />
                            <BeltSwatch
                              color={entry.next_rank_color}
                              isTip={nextRank?.is_tip}
                              tipColor={nextRank?.tip_color_hex}
                              size="xs"
                            />
                            {entry.next_rank_name ?? "No next rank"}
                          </span>
                        )}
                      </th>
                      <td data-label="Classes">
                        <ProgressBar
                          label="Class requirement progress"
                          current={entry.classes_since_promo}
                          required={entry.classes_required}
                          met={entry.classes_met}
                        />
                      </td>
                      <td data-label="Time at rank">
                        <ProgressBar
                          label="Time requirement progress"
                          current={entry.days_at_rank}
                          required={entry.days_required}
                          met={entry.time_met}
                          unit="days"
                        />
                      </td>
                      <td data-label="Status">
                        <ReadinessTag entry={entry} />
                      </td>
                      <td data-label="Actions">
                        {canPromoteStudents ? (
                          <div className={styles.rowActions}>
                            {previousRank ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Demote ${entry.student_name} to ${previousRank.name}`}
                                onClick={() => onStartDemotion(entry)}
                              >
                                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                                Demote
                              </Button>
                            ) : null}
                            {readiness !== "progress" ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!entry.next_rank_id}
                                aria-label={`Promote ${entry.student_name} to ${entry.next_rank_name ?? "the next rank"}`}
                                onClick={() => {
                                  if (!entry.next_rank_id) return;
                                  onStartPromotion(entry);
                                }}
                              >
                                <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                                Promote
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          );
        })}
      </table>
    </HorizonPanel>
  );
}

function EligibilityTableHead() {
  return (
    <thead>
      <tr>
        <th scope="col">Student</th>
        <th scope="col">Classes</th>
        <th scope="col">Time at rank</th>
        <th scope="col">Status</th>
        <th scope="col">
          <span className="sr-only">Actions</span>
        </th>
      </tr>
    </thead>
  );
}

const LOADING_COLUMNS = ["Student", "Classes", "Time at rank", "Status", "Actions"];
const LOADING_BARS = [0.55, 0.3, 0.3, 0.2, 0.15, 0.1, 0.2, 0.08, 0.15];

export function EligibilityLoading({
  selectedProgramName = null,
}: {
  selectedProgramName?: string | null;
}) {
  return (
    <div
      className={`koaryu-skeleton-reveal ${styles.loadingStack}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="sr-only">Loading eligibility for {selectedProgramName || "this program"}.</p>
      <HorizonPanel title="Ready for the next belt">
        <ul className={styles.readyGrid} aria-hidden="true">
          {[0, 1, 2].map((tile) => (
            <li key={tile} className={styles.readyTile}>
              <span className={styles.placeholderLine} data-width="name" />
              <span className={styles.placeholderBelts} />
              <span className={styles.placeholderLine} data-width="meta" />
              <span className={styles.placeholderButton} />
            </li>
          ))}
        </ul>
      </HorizonPanel>
      <HorizonPanel title="Rank ladder" flush>
        <ol
          className={styles.ladderChart}
          aria-hidden="true"
          style={{ "--ladder-steps": LOADING_BARS.length } as CSSProperties}
        >
          {LOADING_BARS.map((share, index) => (
            <li key={index}>
              <span className={styles.ladderStep}>
                <span className={styles.ladderCount}>&nbsp;</span>
                <span className={styles.ladderBarSlot}>
                  <span
                    className={styles.ladderBar}
                    data-placeholder="true"
                    style={{ "--share": share } as CSSProperties}
                  />
                </span>
                <span className={styles.placeholderLine} data-width="label" />
              </span>
            </li>
          ))}
        </ol>
        <table className={styles.eligibilityTable} aria-hidden="true">
          <EligibilityTableHead />
          <tbody className={styles.rankGroupBody}>
            <tr className={styles.rankGroupHeader}>
              <th colSpan={5} scope="colgroup">
                <span className={styles.rankGroupToggle}>
                  <span className={styles.placeholderBelt} />
                  <span className={styles.placeholderLine} data-width="name" />
                </span>
              </th>
            </tr>
            {Array.from({ length: 6 }).map((_, row) => (
              <tr key={row} data-readiness="progress" className={styles.studentRow}>
                {LOADING_COLUMNS.map((label, column) =>
                  column === 0 ? (
                    <th key={label} scope="row" data-label={label}>
                      <span className={styles.placeholderLine} data-width="name" />
                    </th>
                  ) : (
                    <td key={label} data-label={label}>
                      <span
                        className={styles.placeholderLine}
                        data-width={column === 4 ? "button" : "bar"}
                      />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </HorizonPanel>
    </div>
  );
}
