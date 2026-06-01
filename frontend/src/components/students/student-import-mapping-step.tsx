"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getMissingCsvImportRequiredFields, getSkippedBillingImportHeaders } from "@/lib/csv-import-mapping";
import {
  KOARYU_FIELDS,
  REQUIRED_FIELDS,
  getKoaryuFieldLabel,
  isPaymentStatusHeader,
} from "@/lib/student-import-page-model";
import { AlertCircle, ChevronRight, FileText, Info, X } from "lucide-react";
import { StudentImportSectionCard } from "./student-import-panels";

interface StudentImportMappingStepProps {
  fileName?: string;
  headers: string[];
  isLoading: boolean;
  mapping: Record<string, string>;
  rowCount: number;
  rows: Record<string, string>[];
  onMappingChange: (header: string, field: string) => void;
  onReset: () => void;
  onValidate: () => Promise<void> | void;
}

export function StudentImportMappingStep({
  fileName,
  headers,
  isLoading,
  mapping,
  rowCount,
  rows,
  onMappingChange,
  onReset,
  onValidate,
}: StudentImportMappingStepProps) {
  const duplicateMappingEntries = useMemo(() => {
    const counts = Object.values(mapping).reduce<Record<string, number>>((acc, field) => {
      if (!field) return acc;
      acc[field] = (acc[field] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).filter(([, count]) => count > 1);
  }, [mapping]);
  const duplicateNotesMappingEntries = useMemo(
    () => Object.entries(mapping).filter(([, field]) => field === "notes").map(([header]) => header),
    [mapping]
  );
  const duplicateBlockingMappingEntries = useMemo(
    () => duplicateMappingEntries.filter(([field]) => field !== "notes"),
    [duplicateMappingEntries]
  );
  const missingRequiredMappings = useMemo(() => {
    return getMissingCsvImportRequiredFields(mapping);
  }, [mapping]);
  const skippedBillingImportHeaders = useMemo(
    () => getSkippedBillingImportHeaders(headers, mapping),
    [headers, mapping]
  );
  const paymentStatusMappingEntries = useMemo(
    () => Object.entries(mapping).filter(([header, field]) => field === "status" && isPaymentStatusHeader(header)),
    [mapping]
  );
  const mappingBlockers = useMemo(() => [
    ...missingRequiredMappings.map((field) => ({
      code: "missing_required_mapping",
      message: `${getKoaryuFieldLabel(field)} is still unmapped.`,
    })),
    ...duplicateBlockingMappingEntries.map(([field]) => {
      const duplicateColumns = Object.entries(mapping)
        .filter(([, mappedField]) => mappedField === field)
        .map(([header]) => header);
      const [firstColumn, secondColumn] = duplicateColumns;

      return {
        code: "duplicate_mapping",
        message: firstColumn && secondColumn
          ? `${getKoaryuFieldLabel(field)} is mapped from both "${firstColumn}" and "${secondColumn}". Choose one and set the other to "Skip this column."`
          : `${getKoaryuFieldLabel(field)} is mapped more than once. Choose one CSV column and set the others to "Skip this column."`,
      };
    }),
    ...paymentStatusMappingEntries.map(([header]) => ({
      code: "payment_status_mapping",
      message: `${header} is billing/payment data and cannot be mapped to Student Status. Set it to "Skip this column" or map a roster status column instead.`,
    })),
  ], [duplicateBlockingMappingEntries, mapping, missingRequiredMappings, paymentStatusMappingEntries]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <FileText className="w-4 h-4 text-text-secondary" />
        <p className="text-sm text-text-primary font-medium">{fileName}</p>
        <span className="text-xs text-muted font-mono">{rowCount} rows</span>
        <button
          type="button"
          disabled={isLoading}
          onClick={onReset}
          className="ml-auto text-muted hover:text-text-secondary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {mappingBlockers.length > 0 ? (
        <StudentImportSectionCard
          title="Fix column mapping first"
          description="These checks help prevent avoidable row errors before validation."
          icon={<AlertCircle className="w-4 h-4 text-warning mt-0.5" />}
          tone="warning"
        >
          <div className="space-y-2">
            {mappingBlockers.map((item) => (
              <p key={`${item.code}-${item.message}`} className="text-sm text-text-secondary">
                {item.message}
              </p>
            ))}
          </div>
        </StudentImportSectionCard>
      ) : null}
      {duplicateNotesMappingEntries.length > 1 ? (
        <StudentImportSectionCard
          title="Notes columns will be combined"
          description="Koaryu has one student Notes field, so these CSV columns will be saved together with their column labels."
          icon={<Info className="w-4 h-4 text-accent mt-0.5" />}
          tone="default"
        >
          <p className="text-sm text-text-secondary">
            {duplicateNotesMappingEntries.join(", ")}
          </p>
        </StudentImportSectionCard>
      ) : null}
      {skippedBillingImportHeaders.length > 0 ? (
        <StudentImportSectionCard
          title="Billing columns will be skipped for now"
          description="This import only brings in student roster details. Billing, subscription, tuition-plan, and payment-history columns are intentionally skipped in v0.1.1."
          icon={<Info className="w-4 h-4 text-accent mt-0.5" />}
          tone="default"
        >
          <p className="text-sm text-text-secondary">
            {skippedBillingImportHeaders.join(", ")}
          </p>
        </StudentImportSectionCard>
      ) : null}

      <div className="bg-surface border border-border rounded-[6px] overflow-hidden">
        <div className="grid grid-cols-[1.2fr_1fr] border-b border-border">
          <div className="px-4 py-2.5 text-xs font-medium text-text-secondary bg-surface-raised">
            Your CSV column
          </div>
          <div className="px-4 py-2.5 text-xs font-medium text-text-secondary bg-surface-raised">
            Koaryu field
          </div>
        </div>

        {headers.map((header) => {
          const selectedField = mapping[header] || "";
          const selectId = `csv-map-${header.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
          const sampleValues = rows.slice(0, 3).map((row) => row[header]).filter(Boolean);
          const isDuplicate = !!selectedField && selectedField !== "notes" && duplicateMappingEntries.some(([field]) => field === selectedField);
          const isRequired = REQUIRED_FIELDS.includes(selectedField);

          return (
            <div key={header} className="grid grid-cols-[1.2fr_1fr] border-b border-border last:border-0">
              <div className="px-4 py-3 border-r border-border">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm text-text-primary font-mono truncate">{header}</p>
                  {selectedField ? (
                    <Badge variant={isDuplicate ? "danger" : isRequired ? "accent" : "default"}>
                      {KOARYU_FIELDS.find((item) => item.value === selectedField)?.label || selectedField}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sampleValues.length > 0 ? sampleValues.map((value, index) => (
                    <span
                      key={`${header}-${index}`}
                      className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                    >
                      {value}
                    </span>
                  )) : (
                    <span className="text-xs text-muted">No sample values</span>
                  )}
                </div>
              </div>
              <div className="px-4 py-2 flex items-center">
                <label htmlFor={selectId} className="sr-only">
                  Koaryu field for {header}
                </label>
                <select
                  id={selectId}
                  value={selectedField}
                  disabled={isLoading}
                  onChange={(event) => onMappingChange(header, event.target.value)}
                  className="w-full px-2 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {KOARYU_FIELDS.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="md"
          isLoading={isLoading}
          onClick={() => void onValidate()}
          disabled={isLoading || mappingBlockers.length > 0}
        >
          Review {rowCount} rows
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
