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
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import {
  STUDENT_IMPORT_STAGE_STEPS,
  getStudentImportStageIndex,
  type StudentImportStage,
} from "@/lib/student-import-page-model";
import type { CsvImportOptions, CsvImportResult } from "@/types";
import { ArrowLeft, ChevronRight } from "lucide-react";

type ImportOptionChangeHandler = <K extends keyof CsvImportOptions>(
  key: K,
  value: CsvImportOptions[K]
) => Promise<void> | void;

type StudentImportPageContentProps = {
  activeImportKey: string | null;
  canManageRoster: boolean;
  dragOver: boolean;
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
      <>
        <Header title="Import Students" description="Bulk roster imports are limited by staff role.">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
        </Header>
        <div className="flex-1 p-8 text-sm text-text-secondary">
          Only admins and front-desk staff can import students.
        </div>
      </>
    );
  }

  return (
    <>
      <Header title="Import Students" description="Import students from a .csv exported from your spreadsheet.">
        <Button
          variant="ghost"
          size="sm"
          disabled={isLoading}
          onClick={onBack}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-8 flex-wrap">
            {STUDENT_IMPORT_STAGE_STEPS.map((step, index) => (
              <div key={step.id} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-2 text-sm ${
                    index < stageIndex
                      ? "text-success"
                      : index === stageIndex
                        ? "text-text-primary"
                        : "text-muted"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                      index < stageIndex
                        ? "bg-success/20 text-success"
                        : index === stageIndex
                          ? "bg-accent/20 text-accent"
                          : "bg-surface-raised text-muted"
                    }`}
                  >
                    {index < stageIndex ? "✓" : index + 1}
                  </div>
                  {step.label}
                </div>
                {index < STUDENT_IMPORT_STAGE_STEPS.length - 1 ? <ChevronRight className="w-3.5 h-3.5 text-border" /> : null}
              </div>
            ))}
          </div>

          {errorMessage ? (
            <DismissibleNotice
              tone="danger"
              onDismiss={onDismissError}
              className="mb-6"
            >
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
              importKeyError={importKeyError}
              importOptions={importOptions}
              isLoading={isLoading}
              validationResult={validationResult}
              onBackToMapping={onBackToMapping}
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
    </>
  );
}
