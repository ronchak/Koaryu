"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import type { CsvImportResult } from "@/types";
import {
  Upload,
  ArrowLeft,
  CheckCircle,
  AlertCircle,
  ChevronRight,
  FileText,
  X,
} from "lucide-react";

// Koaryu fields that CSV columns can be mapped to
const KOARYU_FIELDS: { value: string; label: string; required?: boolean }[] = [
  { value: "", label: "— Skip this column —" },
  { value: "legal_first_name", label: "First Name", required: true },
  { value: "legal_last_name", label: "Last Name", required: true },
  { value: "preferred_name", label: "Preferred Name" },
  { value: "date_of_birth", label: "Date of Birth" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "status", label: "Status" },
  { value: "membership_start_date", label: "Membership Start Date" },
  { value: "notes", label: "Notes" },
  { value: "tags", label: "Tags (comma-separated)" },
  { value: "address_line1", label: "Address" },
  { value: "address_city", label: "City" },
  { value: "address_state", label: "State" },
  { value: "address_zip", label: "ZIP" },
  { value: "emergency_contact_name", label: "Emergency Contact Name" },
  { value: "emergency_contact_phone", label: "Emergency Contact Phone" },
  { value: "emergency_contact_relation", label: "Emergency Contact Relation" },
  { value: "guardian_name", label: "Guardian Name" },
  { value: "guardian_email", label: "Guardian Email" },
  { value: "guardian_phone", label: "Guardian Phone" },
  { value: "guardian_relation", label: "Guardian Relation" },
];

type Stage = "upload" | "map" | "preview" | "done";

// ---- Mock CSV parse for preview mode ----
function mockParseCSV(file: File): Promise<{
  headers: string[];
  rows: Record<string, string>[];
}> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.trim().split("\n");
      if (lines.length === 0) {
        resolve({ headers: [], rows: [] });
        return;
      }
      const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
      const rows = lines.slice(1).map((line) => {
        const vals = line.split(",").map((v) => v.replace(/"/g, "").trim());
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          row[h] = vals[i] || "";
        });
        return row;
      });
      resolve({ headers, rows });
    };
    reader.readAsText(file);
  });
}

function autoMap(headers: string[]): Record<string, string> {
  const aliases: Record<string, string> = {
    "first name": "legal_first_name",
    firstname: "legal_first_name",
    first_name: "legal_first_name",
    "last name": "legal_last_name",
    lastname: "legal_last_name",
    last_name: "legal_last_name",
    "preferred name": "preferred_name",
    nickname: "preferred_name",
    dob: "date_of_birth",
    birthday: "date_of_birth",
    email: "email",
    phone: "phone",
    mobile: "phone",
    status: "status",
    notes: "notes",
    tags: "tags",
    "guardian name": "guardian_name",
    "parent name": "guardian_name",
    "guardian email": "guardian_email",
    "parent email": "guardian_email",
    "guardian phone": "guardian_phone",
    "parent phone": "guardian_phone",
  };
  const mapping: Record<string, string> = {};
  headers.forEach((h) => {
    const key = h.toLowerCase().trim();
    mapping[h] = aliases[key] || "";
  });
  return mapping;
}

export default function ImportPage() {
  const router = useRouter();
  const store = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validationResult, setValidationResult] =
    useState<CsvImportResult | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(f: File) {
    if (!f.name.endsWith(".csv")) {
      alert("Please upload a .csv file.");
      return;
    }
    setFile(f);
    setIsLoading(true);
    const parsed = await mockParseCSV(f);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setMapping(autoMap(parsed.headers));
    setIsLoading(false);
    setStage("map");
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  function handleValidate() {
    setIsLoading(true);
    // Client-side validation (mirrors backend logic)
    const errors: CsvImportResult["errors"] = [];
    let valid = 0;
    rows.forEach((row, i) => {
      const rowErrors: string[] = [];
      const mapped: Record<string, string> = {};
      Object.entries(mapping).forEach(([col, field]) => {
        if (field) mapped[field] = row[col] || "";
      });

      if (!mapped["legal_first_name"])
        rowErrors.push("Missing required field: first name");
      if (!mapped["legal_last_name"])
        rowErrors.push("Missing required field: last name");

      const validStatuses = ["active", "trialing", "inactive", "paused", "canceled"];
      if (mapped["status"] && !validStatuses.includes(mapped["status"].toLowerCase())) {
        rowErrors.push(
          `Invalid status "${mapped["status"]}". Must be: ${validStatuses.join(", ")}`
        );
      }

      if (rowErrors.length > 0) {
        errors.push({
          row_number: i + 2,
          data: mapped,
          errors: rowErrors,
          is_valid: false,
        });
      } else {
        valid++;
      }
    });

    setValidationResult({
      total_rows: rows.length,
      valid_rows: valid,
      error_rows: errors.length,
      errors,
      imported_count: 0,
    });
    setIsLoading(false);
    setStage("preview");
  }

  function handleImport() {
    setIsLoading(true);
    // Actually import the valid rows via the store
    const importedCount = store.importStudents(rows, mapping);
    setImportResult({
      total_rows: rows.length,
      valid_rows: validationResult?.valid_rows || 0,
      error_rows: validationResult?.error_rows || 0,
      errors: validationResult?.errors || [],
      imported_count: importedCount,
    });
    setIsLoading(false);
    setStage("done");
  }

  const STAGE_STEPS: { id: Stage; label: string }[] = [
    { id: "upload", label: "Upload" },
    { id: "map", label: "Map Columns" },
    { id: "preview", label: "Preview & Validate" },
    { id: "done", label: "Done" },
  ];

  const stageIndex = STAGE_STEPS.findIndex((s) => s.id === stage);

  return (
    <>
      <Header title="Import Students" description="Import students from a CSV or spreadsheet.">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/students")}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-2xl mx-auto">
          {/* Progress stepper */}
          <div className="flex items-center gap-2 mb-8">
            {STAGE_STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center gap-2">
                <div
                  className={`flex items-center gap-2 text-sm ${
                    i < stageIndex
                      ? "text-success"
                      : i === stageIndex
                      ? "text-text-primary"
                      : "text-muted"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                      i < stageIndex
                        ? "bg-success/20 text-success"
                        : i === stageIndex
                        ? "bg-accent/20 text-accent"
                        : "bg-surface-raised text-muted"
                    }`}
                  >
                    {i < stageIndex ? "✓" : i + 1}
                  </div>
                  {step.label}
                </div>
                {i < STAGE_STEPS.length - 1 && (
                  <ChevronRight className="w-3.5 h-3.5 text-border" />
                )}
              </div>
            ))}
          </div>

          {/* ---- Stage: Upload ---- */}
          {stage === "upload" && (
            <div>
              <div
                className={`border-2 border-dashed rounded-[6px] p-12 text-center cursor-pointer transition-all duration-150 ${
                  dragOver
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-accent/50"
                }`}
                onDrop={handleDrop}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-muted mx-auto mb-3" />
                <p className="text-sm text-text-primary mb-1">
                  Drop your CSV file here, or click to select
                </p>
                <p className="text-xs text-muted">
                  Supports .csv files exported from Google Sheets, Excel, or any spreadsheet
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </div>

              <div className="mt-6 bg-surface border border-border rounded-[6px] p-4">
                <p className="text-xs font-medium text-text-secondary mb-2">
                  Expected columns (minimum required)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {["First Name", "Last Name"].map((c) => (
                    <span
                      key={c}
                      className="px-2 py-0.5 text-xs bg-accent/10 text-accent border border-accent/20 rounded-[4px]"
                    >
                      {c} *
                    </span>
                  ))}
                  {[
                    "Email",
                    "Phone",
                    "Date of Birth",
                    "Status",
                    "Guardian Name",
                    "Guardian Email",
                  ].map((c) => (
                    <span
                      key={c}
                      className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ---- Stage: Map ---- */}
          {stage === "map" && (
            <div>
              <div className="flex items-center gap-3 mb-5">
                <FileText className="w-4 h-4 text-text-secondary" />
                <p className="text-sm text-text-primary font-medium">{file?.name}</p>
                <span className="text-xs text-muted font-mono">{rows.length} rows</span>
                <button
                  onClick={() => {
                    setFile(null);
                    setStage("upload");
                  }}
                  className="ml-auto text-muted hover:text-text-secondary cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-surface border border-border rounded-[6px] overflow-hidden mb-5">
                <div className="grid grid-cols-2 border-b border-border">
                  <div className="px-4 py-2.5 text-xs font-medium text-text-secondary bg-surface-raised">
                    Your CSV column
                  </div>
                  <div className="px-4 py-2.5 text-xs font-medium text-text-secondary bg-surface-raised">
                    Koaryu field
                  </div>
                </div>
                {headers.map((header) => (
                  <div
                    key={header}
                    className="grid grid-cols-2 border-b border-border last:border-0"
                  >
                    <div className="px-4 py-3 text-sm text-text-primary font-mono truncate border-r border-border">
                      {header}
                    </div>
                    <div className="px-4 py-2">
                      <select
                        value={mapping[header] || ""}
                        onChange={(e) =>
                          setMapping((prev) => ({ ...prev, [header]: e.target.value }))
                        }
                        className="w-full px-2 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
                      >
                        {KOARYU_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              {/* Preview */}
              {rows.length > 0 && (
                <div className="mb-5 bg-surface border border-border rounded-[6px] p-4">
                  <p className="text-xs text-muted mb-2">
                    First row preview
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {headers.map((h) => (
                      <div key={h} className="text-xs">
                        <span className="text-muted">{h}: </span>
                        <span className="text-text-primary font-mono">{rows[0][h] || "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="md"
                  isLoading={isLoading}
                  onClick={handleValidate}
                >
                  Validate {rows.length} rows
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* ---- Stage: Preview / Validate ---- */}
          {stage === "preview" && validationResult && (
            <div>
              {/* Summary bar */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-surface border border-border rounded-[6px] p-4 text-center">
                  <p className="text-2xl font-bold text-text-primary font-mono">
                    {validationResult.total_rows}
                  </p>
                  <p className="text-xs text-muted mt-1">Total rows</p>
                </div>
                <div className="bg-surface border border-success/20 rounded-[6px] p-4 text-center">
                  <p className="text-2xl font-bold text-success font-mono">
                    {validationResult.valid_rows}
                  </p>
                  <p className="text-xs text-muted mt-1">Ready to import</p>
                </div>
                <div
                  className={`bg-surface border rounded-[6px] p-4 text-center ${
                    validationResult.error_rows > 0
                      ? "border-danger/20"
                      : "border-border"
                  }`}
                >
                  <p
                    className={`text-2xl font-bold font-mono ${
                      validationResult.error_rows > 0 ? "text-danger" : "text-muted"
                    }`}
                  >
                    {validationResult.error_rows}
                  </p>
                  <p className="text-xs text-muted mt-1">Rows with errors</p>
                </div>
              </div>

              {/* Errors list */}
              {validationResult.errors.length > 0 && (
                <div className="bg-surface border border-danger/20 rounded-[6px] overflow-hidden mb-6">
                  <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 text-danger" />
                    <p className="text-sm font-medium text-danger">
                      Rows with errors (will be skipped)
                    </p>
                  </div>
                  <div className="divide-y divide-border/50">
                    {validationResult.errors.map((e) => (
                      <div key={e.row_number} className="px-4 py-3">
                        <p className="text-xs font-mono text-text-secondary mb-1">
                          Row {e.row_number}
                        </p>
                        {e.errors.map((err, i) => (
                          <p key={i} className="text-xs text-danger">
                            • {err}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {validationResult.valid_rows === 0 ? (
                <p className="text-sm text-center text-text-secondary mb-5">
                  No valid rows to import. Fix the errors above and try again.
                </p>
              ) : null}

              <div className="flex gap-3 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStage("map")}
                >
                  Back
                </Button>
                {validationResult.valid_rows > 0 && (
                  <Button
                    variant="primary"
                    size="md"
                    isLoading={isLoading}
                    onClick={handleImport}
                  >
                    Import {validationResult.valid_rows} students
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ---- Stage: Done ---- */}
          {stage === "done" && importResult && (
            <div className="text-center py-10">
              <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-6 h-6 text-success" />
              </div>
              <h2 className="text-xl font-semibold text-text-primary mb-2">
                Import complete
              </h2>
              <p className="text-sm text-text-secondary mb-1">
                <span className="text-success font-mono font-bold">
                  {importResult.imported_count}
                </span>{" "}
                students imported successfully.
              </p>
              {importResult.error_rows > 0 && (
                <p className="text-sm text-text-secondary">
                  <span className="text-danger font-mono">{importResult.error_rows}</span>{" "}
                  rows were skipped due to errors.
                </p>
              )}
              <div className="flex gap-3 justify-center mt-8">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setStage("upload");
                    setFile(null);
                    setHeaders([]);
                    setRows([]);
                    setValidationResult(null);
                    setImportResult(null);
                  }}
                >
                  Import another file
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => router.push("/students")}
                >
                  View students
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
