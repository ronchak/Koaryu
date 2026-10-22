"use client";

import type { RefObject } from "react";
import { Header } from "@/components/header";
import { StudentImportMappingStep } from "@/components/students/student-import-mapping-step";
import {
  StudentImportDonePanel,
  StudentImportUploadStep,
} from "@/components/students/student-import-panels";
import { StudentImportPreviewStep } from "@/components/students/student-import-preview-step";
import { Button } from "@/components/ui/button";
import { CalmState, HorizonPage } from "@/components/ui/horizon";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  STUDENT_IMPORT_STAGE_STEPS,
  getStudentImportStageIndex,
  type StudentImportStage,
} from "@/lib/student-import-page-model";
import type { CsvImportDuplicateDecision, CsvImportOptions, CsvImportResult } from "@/types";
import { ArrowLeft, Lock } from "lucide-react";
import styles from "./student-records.module.css";

type ImportOptionChangeHandler = <K extends keyof CsvImportOptions>(
  key: K,
  value: CsvImportOptions[K],
) => Promise<void> | void;

type StudentImportPageContentProps = {
  activeImportKey: string | null;
  canManageRoster: boolean;
  dragOver: boolean;
  duplicateDecisions: Record<string, CsvImportDuplicateDecision>;
  errorMessage: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  fileName?: string;
  headers: string[];
  importKeyError: string | null;
  importOptions: CsvImportOptions;
  importResult: CsvImportResult | null;
  isLoading: boolean;
  mapping: Record<string, string>;
  rowCount: number;
  rows: Record<string, string>[];
  stage: StudentImportStage;
  submittedImportOptions: CsvImportOptions;
  validationResult: CsvImportResult | null;
  onBack: () => void;
  onBackToMapping: () => void;
  onDismissError: () => void;
  onDragOverChange: (isDragOver: boolean) => void;
  onDuplicateDecisionChange: (rowNumber: number, decision: CsvImportDuplicateDecision) => void;
  onFileSelect: (file: File) => Promise<void> | void;
  onImport: () => Promise<void> | void;
  onImportAnother: () => void;
  onMappingChange: (header: string, field: string) => void;
  onOpenBeltTracker: (href: string) => void;
  onOptionToggle: ImportOptionChangeHandler;
  onReset: () => void;
  onValidate: () => Promise<void> | void;
  onViewStudents: () => void;
};

export function StudentImportPageContent({
  activeImportKey,
  canManageRoster,
  dragOver,
  duplicateDecisions,
  errorMessage,
  fileInputRef,
  fileName,
  headers,
  importKeyError,
  importOptions,
  importResult,
  isLoading,
  mapping,
  rowCount,
  rows,
  stage,
  submittedImportOptions,
  validationResult,
  onBack,
  onBackToMapping,
  onDismissError,
  onDragOverChange,
  onDuplicateDecisionChange,
  onFileSelect,
  onImport,
  onImportAnother,
  onMappingChange,
  onOpenBeltTracker,
  onOptionToggle,
  onReset,
  onValidate,
  onViewStudents,
}: StudentImportPageContentProps) {
  const stageIndex = getStudentImportStageIndex(stage);

  if (!canManageRoster) {
    return (
      <div className={`flex min-h-full flex-col ${styles.importPage}`}>
        <Header eyebrow="Students" title="Import students">
          <Button variant="secondary" onClick={onBack}>
            <ArrowLeft aria-hidden="true" className="w-4 h-4" />
            Back
          </Button>
        </Header>
        <HorizonPage width="medium" className="flex-1">
          <CalmState
            tone="neutral"
            icon={<Lock />}
            title="Only admins and front-desk staff can import students."
          />
        </HorizonPage>
      </div>
    );
  }

  return (
    <div className={`flex min-h-full flex-col ${styles.importPage}`}>
      <Header
        eyebrow="Students"
        title="Import students"
        description="Bring your roster across from a spreadsheet: upload, match columns, check, import."
      >
        <Button variant="secondary" disabled={isLoading} onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="w-4 h-4" />
          Back
        </Button>
      </Header>

      <HorizonPage className={`flex-1 ${styles.importWorkspace}`}>
        <div className={styles.importSheet}>
          <aside className={styles.importIndex} aria-label="Import worksheet progress">
            <dl className="text-[0.8125rem]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Source</dt>
                <dd className="truncate font-semibold text-text-primary">
                  {fileName || "Awaiting CSV"}
                </dd>
              </div>
              <div className="mt-2 flex justify-between gap-3">
                <dt className="text-muted">Rows</dt>
                <dd className="tabular-nums text-text-primary">{rowCount || "—"}</dd>
              </div>
            </dl>
            <div className={styles.importStages}>
              {STUDENT_IMPORT_STAGE_STEPS.map((step, index) => (
                <div
                  key={step.id}
                  className={styles.importStage}
                  data-state={
                    index < stageIndex ? "complete" : index === stageIndex ? "active" : "upcoming"
                  }
                  aria-current={index === stageIndex ? "step" : undefined}
                >
                  <strong>{String(index + 1).padStart(2, "0")}</strong>
                  <span>{step.label}</span>
                </div>
              ))}
            </div>
          </aside>

          <div className={styles.importBody}>
            {errorMessage ? (
              <DismissibleNotice tone="danger" onDismiss={onDismissError} className="mb-6">
                {errorMessage}
              </DismissibleNotice>
            ) : null}

            {stage === "upload" ? (
              <StudentImportUploadStep
                dragOver={dragOver}
                fileInputRef={fileInputRef}
                onDragOverChange={onDragOverChange}
                onFileSelect={onFileSelect}
              />
            ) : null}

            {stage === "map" ? (
              <StudentImportMappingStep
                fileName={fileName}
                headers={headers}
                isLoading={isLoading}
                mapping={mapping}
                rowCount={rowCount}
                rows={rows}
                onMappingChange={onMappingChange}
                onReset={onReset}
                onValidate={onValidate}
              />
            ) : null}

            {stage === "preview" && validationResult ? (
              <StudentImportPreviewStep
                activeImportKey={activeImportKey}
                duplicateDecisions={duplicateDecisions}
                importKeyError={importKeyError}
                importOptions={importOptions}
                isLoading={isLoading}
                validationResult={validationResult}
                onBackToMapping={onBackToMapping}
                onDuplicateDecisionChange={onDuplicateDecisionChange}
                onImport={onImport}
                onOpenBeltTracker={onOpenBeltTracker}
                onOptionToggle={onOptionToggle}
              />
            ) : null}

            {stage === "done" && importResult ? (
              <StudentImportDonePanel
                importOptions={submittedImportOptions}
                importResult={importResult}
                onImportAnother={onImportAnother}
                onViewStudents={onViewStudents}
              />
            ) : null}
          </div>
        </div>
      </HorizonPage>
    </div>
  );
}
