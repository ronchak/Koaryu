"use client";

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/lib/student-import-page-model";
import type { CsvImportOptions, CsvImportResult } from "@/types";
import { AlertCircle, CheckCircle, Upload } from "lucide-react";
import styles from "./student-records.module.css";

export function StudentImportSectionCard({
  title,
  description,
  icon,
  tone = "default",
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  tone?: "default" | "danger" | "warning" | "success";
  children: ReactNode;
}) {
  const toneClasses = {
    default: "border-border",
    danger: "border-danger/20",
    warning: "border-warning/20",
    success: "border-success/20",
  } as const;

  return (
    <section
      className={`bg-surface border overflow-hidden ${toneClasses[tone]} ${styles.worksheetSection}`}
    >
      <div className="px-4 py-3 border-b border-border flex items-start gap-2">
        {icon}
        <div>
          <p className="text-sm font-medium text-text-primary">{title}</p>
          {description ? <p className="text-xs text-muted mt-0.5">{description}</p> : null}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StudentImportUploadStep({
  dragOver,
  fileInputRef,
  onDragOverChange,
  onFileSelect,
}: {
  dragOver: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDragOverChange: (isDragOver: boolean) => void;
  onFileSelect: (file: File) => Promise<void> | void;
}) {
  const openFilePicker = () => fileInputRef.current?.click();
  const handleUploadKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openFilePicker();
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Select CSV file to import"
        className={`rounded-[16px] border-2 border-dashed bg-surface px-6 py-12 text-center shadow-[var(--product-shadow-card)] cursor-pointer transition-[background-color,border-color,color] duration-150 ${
          dragOver
            ? "border-accent bg-[var(--hz-warn-wash)]"
            : "border-[var(--product-rule,var(--border))] hover:border-accent/60"
        }`}
        onDrop={(event) => {
          event.preventDefault();
          onDragOverChange(false);
          const droppedFile = event.dataTransfer.files[0];
          if (droppedFile) void onFileSelect(droppedFile);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          onDragOverChange(true);
        }}
        onDragLeave={() => onDragOverChange(false)}
        onClick={openFilePicker}
        onKeyDown={handleUploadKeyDown}
      >
        <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-[12px] bg-[var(--hz-tile)] text-accent">
          <Upload aria-hidden="true" className="h-5 w-5" />
        </span>
        <p className="mb-1 text-base font-bold tracking-[-0.01em] text-text-primary">
          Drop your CSV file here, or click to select
        </p>
        <p className="text-[0.8125rem] text-text-secondary">
          Supports .csv files exported from Google Sheets, Excel, or another spreadsheet tool
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(event) => {
            const selectedFile = event.target.files?.[0];
            if (selectedFile) void onFileSelect(selectedFile);
          }}
        />
      </div>

      <div className="mt-5 rounded-[16px] border border-[var(--product-rule-soft,var(--border))] bg-surface p-4 shadow-[var(--product-shadow-card)]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-text-primary">Minimum name info</p>
          <a
            href="/demo-students.csv"
            download
            className="text-xs text-accent hover:text-accent-hover"
          >
            Download demo CSV
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="px-2 py-0.5 text-xs bg-accent/10 text-accent border border-accent/20 rounded-[10px]">
            Full Name *
          </span>
          <span className="text-xs text-muted">or</span>
          {["First Name", "Last Name"].map((column) => (
            <span
              key={column}
              className="px-2 py-0.5 text-xs bg-accent/10 text-accent border border-accent/20 rounded-[10px]"
            >
              {column} *
            </span>
          ))}
          {["Email", "Phone", "Date of Birth", "Status", "Program", "Current Belt"].map(
            (column) => (
              <span
                key={column}
                className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[10px] text-text-secondary"
              >
                {column}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

export function StudentImportDonePanel({
  importOptions,
  importResult,
  onImportAnother,
  onViewStudents,
}: {
  importOptions: CsvImportOptions;
  importResult: CsvImportResult;
  onImportAnother: () => void;
  onViewStudents: () => void;
}) {
  const importedCount = importResult.imported_count ?? 0;
  const skippedCount = importResult.skipped_rows ?? 0;
  const importedAllValidatedRows =
    importedCount > 0 && importResult.valid_rows === importedCount + skippedCount;
  const doneTitle =
    importedCount === 0
      ? "No students were imported"
      : importedAllValidatedRows
        ? "Import complete"
        : "Import finished with follow-up items";

  return (
    <div className="text-center py-10">
      <div
        className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${
          importedAllValidatedRows ? "bg-success/10" : "bg-warning/10"
        }`}
      >
        {importedAllValidatedRows ? (
          <CheckCircle className="w-6 h-6 text-success" />
        ) : (
          <AlertCircle className="w-6 h-6 text-warning" />
        )}
      </div>
      <h2 className="text-xl font-semibold text-text-primary mb-2">{doneTitle}</h2>
      <p className="text-sm text-text-secondary mb-1">
        <span
          className={`tabular-nums font-bold ${importedCount > 0 ? "text-success" : "text-danger"}`}
        >
          {importedCount}
        </span>{" "}
        of{" "}
        <span className="tabular-nums font-bold text-text-primary">{importResult.valid_rows}</span>{" "}
        validated rows were imported.
      </p>
      {skippedCount > 0 ? (
        <p className="text-sm text-text-secondary">
          <span className="tabular-nums font-bold text-text-primary">{skippedCount}</span>{" "}
          {pluralize(skippedCount, "row")} {skippedCount === 1 ? "was" : "were"} skipped because the
          student is already in Koaryu. Nothing was merged or overwritten.
        </p>
      ) : null}
      {importResult.error_rows > 0 ? (
        <p className="text-sm text-text-secondary">
          <span className="text-danger tabular-nums">{importResult.error_rows}</span> rows still
          have blockers and were not imported.
        </p>
      ) : null}
      {importResult.created_programs.length > 0 ? (
        <p className="text-sm text-text-secondary mt-2">
          Created programs:{" "}
          <span className="font-medium text-text-primary">
            {importResult.created_programs.join(", ")}
          </span>
        </p>
      ) : null}
      {importResult.created_ladders.length > 0 ? (
        <p className="text-sm text-text-secondary mt-1">
          Created belt ladders:{" "}
          <span className="font-medium text-text-primary">
            {importResult.created_ladders.join(", ")}
          </span>
        </p>
      ) : null}
      {importResult.created_belts.length > 0 ? (
        <p className="text-sm text-text-secondary mt-1">
          Created belts:{" "}
          <span className="font-medium text-text-primary">
            {importResult.created_belts.join(", ")}
          </span>
        </p>
      ) : null}
      {importResult.imported_without_belt_count > 0 ? (
        <p className="text-sm text-text-secondary mt-1">
          {importResult.imported_without_belt_count}{" "}
          {pluralize(importResult.imported_without_belt_count, "student")}{" "}
          {importResult.imported_without_belt_count === 1 ? "had an" : "had"} unmatched belt{" "}
          {pluralize(importResult.imported_without_belt_count, "name")} saved to notes. Students in
          configured programs start at that program&apos;s first full belt; others remain unranked.
        </p>
      ) : null}
      {importResult.normalized_status_count > 0 ? (
        <p className="text-sm text-text-secondary mt-1">
          {importResult.normalized_status_count} status{" "}
          {pluralize(importResult.normalized_status_count, "value")}{" "}
          {importResult.normalized_status_count === 1 ? "was" : "were"} normalized during import.
        </p>
      ) : null}
      {importResult.non_critical_errors?.length ? (
        <div className="mt-4 mx-auto max-w-2xl rounded-[14px] border border-warning/30 bg-warning/10 px-4 py-3 text-left">
          <p className="text-sm font-medium text-warning">
            Saved with{" "}
            {importResult.non_critical_errors.length === 1
              ? "one follow-up"
              : `${importResult.non_critical_errors.length} follow-ups`}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-text-secondary">
            {importResult.non_critical_errors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-sm text-text-secondary mt-1">
        Import choices used:{" "}
        {[
          importOptions.create_missing_programs ? "Create programs" : null,
          importOptions.create_missing_belts ? "Create ladders and belts" : null,
          importOptions.import_without_unresolved_belt ? "Import without unresolved belts" : null,
        ]
          .filter(Boolean)
          .join(" · ") || "None"}
      </p>
      <div className="flex gap-3 justify-center mt-8">
        <Button variant="secondary" size="md" onClick={onImportAnother}>
          Import another file
        </Button>
        <Button variant="primary" size="md" onClick={onViewStudents}>
          View students
        </Button>
      </div>
    </div>
  );
}
