"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildCsvImportIssueGroups,
  buildDuplicateDecision,
  buildPreflightSummary,
  describeDuplicateCandidate,
  describeGuardianOutcome,
  formatRowNumbers,
  getDuplicateReviewRows,
  getImportActionState,
  pluralize,
  type DuplicateDecisionMap,
  type DuplicateReviewRow,
} from "@/lib/student-import-page-model";
import type { CsvImportDuplicateDecision, CsvImportOptions, CsvImportResult } from "@/types";
import { AlertCircle, ExternalLink, Info, Users } from "lucide-react";
import { StudentImportSectionCard } from "./student-import-panels";
import styles from "./student-records.module.css";

type ImportOptionChangeHandler = <K extends keyof CsvImportOptions>(
  key: K,
  value: CsvImportOptions[K],
) => Promise<void> | void;

interface StudentImportPreviewStepProps {
  activeImportKey: string | null;
  duplicateDecisions: DuplicateDecisionMap;
  importKeyError: string | null;
  importOptions: CsvImportOptions;
  isLoading: boolean;
  validationResult: CsvImportResult;
  onBackToMapping: () => void;
  onDuplicateDecisionChange: (rowNumber: number, decision: CsvImportDuplicateDecision) => void;
  onImport: () => Promise<void> | void;
  onOpenBeltTracker: (href: string) => void;
  onOptionToggle: ImportOptionChangeHandler;
}

export function StudentImportPreviewStep({
  activeImportKey,
  duplicateDecisions,
  importKeyError,
  importOptions,
  isLoading,
  validationResult,
  onBackToMapping,
  onDuplicateDecisionChange,
  onImport,
  onOpenBeltTracker,
  onOptionToggle,
}: StudentImportPreviewStepProps) {
  const issueRows = validationResult.rows || [];
  const duplicateRows = getDuplicateReviewRows(validationResult);
  const importAction = getImportActionState(validationResult, duplicateDecisions);
  const skipCount = importAction.skipCount;
  const unresolvedDuplicates = importAction.reason === "unresolved";
  const blockingRows = issueRows.filter((row) =>
    row.issues.some((issue) => issue.severity === "error"),
  );
  const warningRows = issueRows.filter(
    (row) => row.is_valid && row.issues.some((issue) => issue.severity === "warning"),
  );
  const warningIssueGroups = buildCsvImportIssueGroups(warningRows, "warning");
  const blockingIssueGroups = buildCsvImportIssueGroups(blockingRows, "error");
  const preflightSummary = buildPreflightSummary(validationResult);

  return (
    <div className="space-y-6">
      <div className={styles.previewStats}>
        <StudentImportPreviewStat
          label="Total rows"
          value={validationResult.total_rows}
          valueClassName="text-text-primary"
        />
        <StudentImportPreviewStat
          label="Ready to import"
          value={validationResult.valid_rows}
          valueClassName="text-success"
          className="border-success/20"
        />
        <StudentImportPreviewStat
          label="Rows with blockers"
          value={validationResult.error_rows}
          valueClassName={validationResult.error_rows > 0 ? "text-danger" : "text-muted"}
          className={validationResult.error_rows > 0 ? "border-danger/20" : "border-border"}
        />
      </div>

      <StudentImportReviewCard
        importOptions={importOptions}
        isLoading={isLoading}
        preflightSummary={preflightSummary}
        validationResult={validationResult}
        onOpenBeltTracker={onOpenBeltTracker}
        onOptionToggle={onOptionToggle}
      />

      {duplicateRows.length > 0 ? (
        <StudentImportDuplicateReview
          decisions={duplicateDecisions}
          isLoading={isLoading}
          rows={duplicateRows}
          onDecisionChange={onDuplicateDecisionChange}
        />
      ) : null}

      {validationResult.setup_issues.length > 0 ? (
        <StudentImportSetupIssues validationResult={validationResult} />
      ) : null}

      {validationResult.warnings.length > 0 ? (
        <StudentImportWarnings validationResult={validationResult} />
      ) : null}

      {blockingRows.length > 0 ? (
        <StudentImportIssueGroupsCard
          title="Rows to fix before import"
          description="Repeated blockers are grouped together so you can see the real cleanup work at a glance."
          icon={<AlertCircle className="w-4 h-4 text-danger mt-0.5" />}
          tone="danger"
          groups={blockingIssueGroups}
          badgeVariant="danger"
          messageClassName="text-danger"
        />
      ) : null}

      {warningRows.length > 0 ? (
        <StudentImportIssueGroupsCard
          title="Importable rows with warnings"
          description="Repeated warnings are grouped together so the import impact stays easy to scan."
          icon={<Info className="w-4 h-4 text-warning mt-0.5" />}
          tone="warning"
          groups={warningIssueGroups}
          badgeVariant="warning"
          messageClassName="text-warning"
        />
      ) : null}

      <div className="flex gap-3 justify-end">
        <Button variant="ghost" size="sm" disabled={isLoading} onClick={onBackToMapping}>
          Back to mapping
        </Button>
        {validationResult.valid_rows > 0 ? (
          <Button
            variant="primary"
            size="md"
            isLoading={isLoading}
            disabled={isLoading || !activeImportKey || importAction.disabled}
            onClick={() => void onImport()}
          >
            {importAction.label}
          </Button>
        ) : null}
      </div>
      {validationResult.valid_rows > 0 ? (
        importKeyError ? (
          <p className="text-xs text-danger text-right">{importKeyError}</p>
        ) : unresolvedDuplicates ? (
          <p className="text-xs text-warning text-right">
            Choose Skip or Create for each student who may already be in Koaryu.
          </p>
        ) : (
          <p className="text-xs text-muted text-right">
            {skipCount > 0
              ? `${skipCount} ${pluralize(skipCount, "row")} will be skipped as already in Koaryu. `
              : ""}
            If the connection drops, retry with this exact file and the same choices. Koaryu will
            recognize the retry and avoid duplicate students.
          </p>
        )
      ) : null}
    </div>
  );
}

function StudentImportPreviewStat({
  label,
  value,
  className = "border-border",
  valueClassName,
}: {
  label: string;
  value: number;
  className?: string;
  valueClassName: string;
}) {
  return (
    <div className={`bg-surface border p-4 text-center ${className} ${styles.previewStat}`}>
      <p className={`text-2xl font-bold tabular-nums ${valueClassName}`}>{value}</p>
      <p className="text-xs text-muted mt-1">{label}</p>
    </div>
  );
}

function StudentImportReviewCard({
  importOptions,
  isLoading,
  preflightSummary,
  validationResult,
  onOpenBeltTracker,
  onOptionToggle,
}: {
  importOptions: CsvImportOptions;
  isLoading: boolean;
  preflightSummary: string;
  validationResult: CsvImportResult;
  onOpenBeltTracker: (href: string) => void;
  onOptionToggle: ImportOptionChangeHandler;
}) {
  const beltTrackerHref = validationResult.actions_available.belt_tracker_href;

  return (
    <StudentImportSectionCard
      title="Import review"
      description={preflightSummary}
      icon={<Info className="w-4 h-4 text-accent mt-0.5" />}
    >
      <div className="space-y-4">
        {validationResult.actions_available.can_create_missing_programs ? (
          <div className="space-y-1">
            <label className="flex items-start gap-3 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={importOptions.create_missing_programs}
                disabled={isLoading}
                onChange={(event) =>
                  void onOptionToggle("create_missing_programs", event.target.checked)
                }
                className="mt-0.5"
              />
              <span>Create any missing programs that appear in this CSV before import.</span>
            </label>
            {validationResult.setup_issues.some(
              (issue) => issue.code === "missing_belt" || issue.code === "missing_belt_ladder",
            ) ? (
              <p className="pl-6 text-xs text-muted">
                If those same rows also include current belts, turn this on first so Koaryu can
                place new ladders and belts into the correct program.
              </p>
            ) : null}
          </div>
        ) : null}

        {validationResult.actions_available.can_create_missing_belts ? (
          <label className="flex items-start gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={importOptions.create_missing_belts}
              disabled={isLoading}
              onChange={(event) =>
                void onOptionToggle("create_missing_belts", event.target.checked)
              }
              className="mt-0.5"
            />
            <span>
              Create missing program ladders and belt ranks from this CSV when Koaryu can match them
              to each student&apos;s program.
            </span>
          </label>
        ) : null}

        {validationResult.actions_available.can_import_without_unresolved_belt ? (
          <label className="flex items-start gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={importOptions.import_without_unresolved_belt}
              disabled={isLoading}
              onChange={(event) =>
                void onOptionToggle("import_without_unresolved_belt", event.target.checked)
              }
              className="mt-0.5"
            />
            <span>
              Import students even if their current belt cannot be matched yet. We will save the
              original belt text into notes so staff can reconcile it later.
            </span>
          </label>
        ) : null}

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-text-secondary">
            Student status aliases are on. Koaryu will clean up roster statuses like{" "}
            <span className="tabular-nums">current</span> to{" "}
            <span className="tabular-nums">active</span>,{" "}
            <span className="tabular-nums">on hold</span> to{" "}
            <span className="tabular-nums">paused</span>, and{" "}
            <span className="tabular-nums">trial</span> to{" "}
            <span className="tabular-nums">trialing</span>. Billing and payment statuses should stay
            skipped for this import.
          </div>
          {beltTrackerHref ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={isLoading}
              onClick={() => onOpenBeltTracker(beltTrackerHref)}
            >
              Open Belt Tracker
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </StudentImportSectionCard>
  );
}

function StudentImportDuplicateReview({
  decisions,
  isLoading,
  rows,
  onDecisionChange,
}: {
  decisions: DuplicateDecisionMap;
  isLoading: boolean;
  rows: DuplicateReviewRow[];
  onDecisionChange: (rowNumber: number, decision: CsvImportDuplicateDecision) => void;
}) {
  const choiceRows = rows.filter((row) => row.needsChoice);
  const contextRows = rows.filter((row) => !row.needsChoice);

  return (
    <StudentImportSectionCard
      title={
        choiceRows.length > 0
          ? "Looks like they may already be in Koaryu"
          : contextRows.some((row) => row.primary)
            ? "Student and family matches"
            : "Family contacts"
      }
      description={
        choiceRows.length > 0
          ? "Skipping keeps the student who is already in Koaryu exactly as they are. Nothing is merged or overwritten either way."
          : "Contact and name matches provide context for these students. No duplicate choice is needed."
      }
      icon={<Users className="w-4 h-4 text-accent mt-0.5" />}
    >
      <div className="space-y-3">
        {choiceRows.map((row) => {
          const decision = decisions[String(row.rowNumber)];
          const groupName = `duplicate-decision-${row.rowNumber}`;
          return (
            <div
              key={row.rowNumber}
              className="border border-border rounded-[14px] p-3"
              data-testid={`duplicate-row-${row.rowNumber}`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary">
                    Row {row.rowNumber}: {row.rowName}
                  </p>
                  {row.review.candidates
                    .filter((candidate) => candidate.confidence !== "different_person")
                    .map((candidate) => (
                      <p
                        key={`${row.rowNumber}-${candidate.student_id ?? candidate.of_row}`}
                        className="text-xs text-text-secondary mt-1"
                      >
                        Matches {describeDuplicateCandidate(candidate)}
                        {candidate.archived ? (
                          <Badge variant="warning" className="ml-2">
                            Archived
                          </Badge>
                        ) : null}
                      </p>
                    ))}
                  {describeGuardianOutcome(row.review, decisions) ? (
                    <p className="text-xs text-text-secondary mt-1">
                      {describeGuardianOutcome(row.review, decisions)}
                    </p>
                  ) : null}
                  {row.review.family_context.map((note) => (
                    <p key={note} className="text-xs text-muted mt-1">
                      {note}
                    </p>
                  ))}
                </div>
                {row.decisionRequired && !decision ? (
                  <Badge variant="warning">Choose one</Badge>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-4" role="radiogroup" aria-label={groupName}>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="radio"
                    name={groupName}
                    checked={decision?.action === "skip"}
                    disabled={isLoading}
                    onChange={() =>
                      onDecisionChange(row.rowNumber, buildDuplicateDecision(row.review, "skip"))
                    }
                  />
                  Skip, already in Koaryu
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="radio"
                    name={groupName}
                    checked={decision?.action === "create"}
                    disabled={isLoading}
                    onChange={() =>
                      onDecisionChange(row.rowNumber, buildDuplicateDecision(row.review, "create"))
                    }
                  />
                  Create as a new student
                </label>
              </div>
            </div>
          );
        })}
        {contextRows.map((row) => (
          <div
            key={row.rowNumber}
            className="border border-border rounded-[14px] p-3"
            data-testid={`family-context-row-${row.rowNumber}`}
          >
            <p className="text-sm font-medium text-text-primary">
              Row {row.rowNumber}: {row.rowName}
            </p>
            {row.primary ? (
              <p className="text-xs text-muted mt-1">
                Shares a name with {describeDuplicateCandidate(row.primary)}. Treated as a different
                student.
              </p>
            ) : null}
            {row.review.family_context.map((note) => (
              <p key={note} className="text-xs text-muted mt-1">
                {note}
              </p>
            ))}
            {describeGuardianOutcome(row.review, decisions) ? (
              <p className="text-xs text-text-secondary mt-1">
                {describeGuardianOutcome(row.review, decisions)}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </StudentImportSectionCard>
  );
}

function StudentImportSetupIssues({ validationResult }: { validationResult: CsvImportResult }) {
  return (
    <StudentImportSectionCard
      title="Missing setup"
      description="These are product setup gaps, not necessarily broken CSV data."
      icon={<AlertCircle className="w-4 h-4 text-warning mt-0.5" />}
      tone="warning"
    >
      <div className="space-y-4">
        {validationResult.setup_issues.map((issue) => (
          <div
            key={`${issue.code}-${issue.message}`}
            className="border border-border rounded-[14px] p-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-text-primary">{issue.message}</p>
              <Badge variant={issue.severity === "error" ? "danger" : "warning"}>
                {issue.severity === "error" ? "Needs attention" : "Can be handled during import"}
              </Badge>
            </div>
            {issue.values.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issue.values.map((value) => (
                  <span
                    key={`${issue.code}-${value}`}
                    className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[10px] text-text-secondary"
                  >
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {issue.suggested_action ? (
              <p className="text-xs text-muted mt-2">{issue.suggested_action}</p>
            ) : null}
          </div>
        ))}
      </div>
    </StudentImportSectionCard>
  );
}

function StudentImportWarnings({ validationResult }: { validationResult: CsvImportResult }) {
  return (
    <StudentImportSectionCard
      title="Heads-up before import"
      description="These rows can still import, but you should know what will be adjusted."
      icon={<Info className="w-4 h-4 text-warning mt-0.5" />}
      tone="warning"
    >
      <div className="space-y-3">
        {validationResult.warnings.map((warning) => (
          <div
            key={`${warning.code}-${warning.message}`}
            className="border border-border rounded-[14px] p-3"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-text-primary">{warning.message}</p>
              <Badge variant="warning">{warning.row_numbers.length} row(s)</Badge>
            </div>
            {warning.values.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {warning.values.map((value) => (
                  <span
                    key={`${warning.code}-${value}`}
                    className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[10px] text-text-secondary"
                  >
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {warning.suggested_action ? (
              <p className="text-xs text-muted mt-2">{warning.suggested_action}</p>
            ) : null}
          </div>
        ))}
      </div>
    </StudentImportSectionCard>
  );
}

function StudentImportIssueGroupsCard({
  title,
  description,
  icon,
  tone,
  groups,
  badgeVariant,
  messageClassName,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  tone: "danger" | "warning";
  groups: ReturnType<typeof buildCsvImportIssueGroups>;
  badgeVariant: "danger" | "warning";
  messageClassName: string;
}) {
  return (
    <StudentImportSectionCard title={title} description={description} icon={icon} tone={tone}>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.key} className="border border-border rounded-[14px] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`text-sm ${messageClassName}`}>{group.issue.message}</p>
                {group.issue.value ? (
                  <p className="text-xs text-muted mt-1">Value: {group.issue.value}</p>
                ) : null}
                {group.mappedValues.length === 1 && group.mappedValues[0] !== group.issue.value ? (
                  <p className="text-xs text-muted">Mapped field value: {group.mappedValues[0]}</p>
                ) : null}
                <p className="text-xs text-muted mt-1">
                  Affects {group.rowNumbers.length} {group.rowNumbers.length === 1 ? "row" : "rows"}
                  : {formatRowNumbers(group.rowNumbers)}
                </p>
                {group.issue.suggested_action ? (
                  <p className="text-xs text-muted mt-1">{group.issue.suggested_action}</p>
                ) : null}
              </div>
              <Badge variant={badgeVariant}>
                {group.rowNumbers.length} {group.rowNumbers.length === 1 ? "row" : "rows"}
              </Badge>
            </div>
          </div>
        ))}
      </div>
    </StudentImportSectionCard>
  );
}
