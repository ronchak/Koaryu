"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildCsvImportIssueGroups,
  buildPreflightSummary,
  formatRowNumbers,
} from "@/lib/student-import-page-model";
import type { CsvImportOptions, CsvImportResult } from "@/types";
import { AlertCircle, ExternalLink, Info } from "lucide-react";
import { StudentImportSectionCard } from "./student-import-panels";

type ImportOptionChangeHandler = <K extends keyof CsvImportOptions>(
  key: K,
  value: CsvImportOptions[K]
) => Promise<void> | void;

interface StudentImportPreviewStepProps {
  activeImportKey: string | null;
  importKeyError: string | null;
  importOptions: CsvImportOptions;
  isLoading: boolean;
  validationResult: CsvImportResult;
  onBackToMapping: () => void;
  onImport: () => Promise<void> | void;
  onOpenBeltTracker: (href: string) => void;
  onOptionToggle: ImportOptionChangeHandler;
}

export function StudentImportPreviewStep({
  activeImportKey,
  importKeyError,
  importOptions,
  isLoading,
  validationResult,
  onBackToMapping,
  onImport,
  onOpenBeltTracker,
  onOptionToggle,
}: StudentImportPreviewStepProps) {
  const issueRows = validationResult.rows || [];
  const blockingRows = issueRows.filter((row) => row.issues.some((issue) => issue.severity === "error"));
  const warningRows = issueRows.filter(
    (row) => row.is_valid && row.issues.some((issue) => issue.severity === "warning")
  );
  const warningIssueGroups = buildCsvImportIssueGroups(warningRows, "warning");
  const blockingIssueGroups = buildCsvImportIssueGroups(blockingRows, "error");
  const preflightSummary = buildPreflightSummary(validationResult);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            disabled={isLoading || !activeImportKey}
            onClick={() => void onImport()}
          >
            Import {validationResult.valid_rows} students
          </Button>
        ) : null}
      </div>
      {validationResult.valid_rows > 0 ? (
        importKeyError ? (
          <p className="text-xs text-danger text-right">
            {importKeyError}
          </p>
        ) : (
          <p className="text-xs text-muted text-right">
            If the connection drops, retry with this exact file and the same options. Koaryu will recognize the retry and avoid duplicate students.
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
    <div className={`bg-surface border rounded-[6px] p-4 text-center ${className}`}>
      <p className={`text-2xl font-bold font-mono ${valueClassName}`}>{value}</p>
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
                onChange={(event) => void onOptionToggle("create_missing_programs", event.target.checked)}
                className="mt-0.5"
              />
              <span>Create any missing programs that appear in this CSV before import.</span>
            </label>
            {validationResult.setup_issues.some((issue) => issue.code === "missing_belt" || issue.code === "missing_belt_ladder") ? (
              <p className="pl-6 text-xs text-muted">
                If those same rows also include current belts, turn this on first so Koaryu can place new ladders and belts into the correct program.
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
              onChange={(event) => void onOptionToggle("create_missing_belts", event.target.checked)}
              className="mt-0.5"
            />
            <span>Create missing program ladders and belt ranks from this CSV when Koaryu can match them to each student&apos;s program.</span>
          </label>
        ) : null}

        {validationResult.actions_available.can_import_without_unresolved_belt ? (
          <label className="flex items-start gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={importOptions.import_without_unresolved_belt}
              disabled={isLoading}
              onChange={(event) => void onOptionToggle("import_without_unresolved_belt", event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Import students even if their current belt cannot be matched yet. We will save the original belt text into notes so staff can reconcile it later.
            </span>
          </label>
        ) : null}

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm text-text-secondary">
            Student status aliases are on. Koaryu will clean up roster statuses like <span className="font-mono">current</span> to <span className="font-mono">active</span>, <span className="font-mono">on hold</span> to <span className="font-mono">paused</span>, and <span className="font-mono">trial</span> to <span className="font-mono">trialing</span>. Billing and payment statuses should stay skipped for this import.
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
          <div key={`${issue.code}-${issue.message}`} className="border border-border rounded-[6px] p-3">
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
                    className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                  >
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {issue.suggested_action ? <p className="text-xs text-muted mt-2">{issue.suggested_action}</p> : null}
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
          <div key={`${warning.code}-${warning.message}`} className="border border-border rounded-[6px] p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-text-primary">{warning.message}</p>
              <Badge variant="warning">{warning.row_numbers.length} row(s)</Badge>
            </div>
            {warning.values.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {warning.values.map((value) => (
                  <span
                    key={`${warning.code}-${value}`}
                    className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                  >
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {warning.suggested_action ? <p className="text-xs text-muted mt-2">{warning.suggested_action}</p> : null}
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
    <StudentImportSectionCard
      title={title}
      description={description}
      icon={icon}
      tone={tone}
    >
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.key} className="border border-border rounded-[6px] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`text-sm ${messageClassName}`}>{group.issue.message}</p>
                {group.issue.value ? (
                  <p className="text-xs text-muted mt-1">
                    Value: {group.issue.value}
                  </p>
                ) : null}
                {group.mappedValues.length === 1 && group.mappedValues[0] !== group.issue.value ? (
                  <p className="text-xs text-muted">
                    Mapped field value: {group.mappedValues[0]}
                  </p>
                ) : null}
                <p className="text-xs text-muted mt-1">
                  Affects {group.rowNumbers.length} {group.rowNumbers.length === 1 ? "row" : "rows"}: {formatRowNumbers(group.rowNumbers)}
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
