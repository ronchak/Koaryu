"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { api } from "@/lib/api";
import { useConfigStore, useStudentStore } from "@/lib/store";
import type { CsvImportOptions, CsvImportResult, CsvParseResponse } from "@/types";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  ExternalLink,
  FileText,
  Info,
  Upload,
  X,
} from "lucide-react";

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
  { value: "program_id", label: "Program" },
  { value: "current_belt_rank_id", label: "Current Belt" },
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

const REQUIRED_FIELDS = KOARYU_FIELDS.filter((field) => field.required).map((field) => field.value);
const DEFAULT_IMPORT_OPTIONS: CsvImportOptions = {
  create_missing_programs: false,
  create_missing_belts: false,
  import_without_unresolved_belt: true,
  status_alias_mode: "normalize",
};

const RAW_CSV_ALIASES: Record<string, string> = {
  "first name": "legal_first_name",
  "first_names": "legal_first_name",
  "student first name": "legal_first_name",
  "given name": "legal_first_name",
  forename: "legal_first_name",
  "last name": "legal_last_name",
  "last_names": "legal_last_name",
  "student last name": "legal_last_name",
  surname: "legal_last_name",
  "family name": "legal_last_name",
  "preferred name": "preferred_name",
  "preferred first name": "preferred_name",
  nickname: "preferred_name",
  "nick name": "preferred_name",
  dob: "date_of_birth",
  "date of birth": "date_of_birth",
  "birth date": "date_of_birth",
  birthdate: "date_of_birth",
  birthday: "date_of_birth",
  "student birthday": "date_of_birth",
  email: "email",
  "email address": "email",
  "student email": "email",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "mobile number": "phone",
  cell: "phone",
  "cell phone": "phone",
  cellphone: "phone",
  telephone: "phone",
  status: "status",
  "student status": "status",
  notes: "notes",
  note: "notes",
  tags: "tags",
  tag: "tags",
  labels: "tags",
  program: "program_id",
  "program name": "program_id",
  "student program": "program_id",
  "membership program": "program_id",
  "current belt": "current_belt_rank_id",
  "current belt rank": "current_belt_rank_id",
  "current rank": "current_belt_rank_id",
  "belt rank": "current_belt_rank_id",
  "guardian name": "guardian_name",
  "guardian full name": "guardian_name",
  "parent name": "guardian_name",
  "parent full name": "guardian_name",
  "parent guardian name": "guardian_name",
  "guardian email": "guardian_email",
  "parent email": "guardian_email",
  "guardian phone": "guardian_phone",
  "guardian phone number": "guardian_phone",
  "guardian mobile": "guardian_phone",
  "parent phone": "guardian_phone",
  "parent phone number": "guardian_phone",
  "parent mobile": "guardian_phone",
  relation: "guardian_relation",
  "guardian relation": "guardian_relation",
  "guardian relationship": "guardian_relation",
  "parent relation": "guardian_relation",
  "parent relationship": "guardian_relation",
  "membership start date": "membership_start_date",
  "membership date": "membership_start_date",
  "enrollment date": "membership_start_date",
  "enrolment date": "membership_start_date",
  "start date": "membership_start_date",
  "join date": "membership_start_date",
  "joined on": "membership_start_date",
  "member since": "membership_start_date",
  address: "address_line1",
  "address line 1": "address_line1",
  "street address": "address_line1",
  city: "address_city",
  state: "address_state",
  province: "address_state",
  zip: "address_zip",
  "zip code": "address_zip",
  "postal code": "address_zip",
  "emergency contact name": "emergency_contact_name",
  "emergency name": "emergency_contact_name",
  "emergency contact phone": "emergency_contact_phone",
  "emergency phone": "emergency_contact_phone",
  "emergency contact relation": "emergency_contact_relation",
  "emergency relation": "emergency_contact_relation",
};

type Stage = "upload" | "map" | "preview" | "done";

function normalizeHeader(header: string): string {
  return header.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactHeader(header: string): string {
  return normalizeHeader(header).replace(/\s+/g, "");
}

const CSV_ALIASES = Object.fromEntries(
  Object.entries(RAW_CSV_ALIASES).map(([header, field]) => [normalizeHeader(header), field])
);

const COMPACT_CSV_ALIASES = Object.fromEntries(
  Object.entries(RAW_CSV_ALIASES).map(([header, field]) => [compactHeader(header), field])
);

function inferFieldFromTokens(tokens: Set<string>): string {
  if (tokens.size === 0 || tokens.has("hold")) return "";

  if (tokens.has("guardian") || tokens.has("parent")) {
    if (tokens.has("email") || tokens.has("mail")) return "guardian_email";
    if (tokens.has("phone") || tokens.has("mobile") || tokens.has("cell") || tokens.has("telephone") || tokens.has("tel")) {
      return "guardian_phone";
    }
    if (tokens.has("relation") || tokens.has("relationship")) return "guardian_relation";
    if (tokens.has("name") || tokens.has("contact")) return "guardian_name";
  }

  if (tokens.has("emergency")) {
    if (tokens.has("phone") || tokens.has("mobile") || tokens.has("cell") || tokens.has("telephone") || tokens.has("tel")) {
      return "emergency_contact_phone";
    }
    if (tokens.has("relation") || tokens.has("relationship")) return "emergency_contact_relation";
    if (tokens.has("name") || tokens.has("contact")) return "emergency_contact_name";
  }

  if (tokens.has("dob") || tokens.has("birthday") || (tokens.has("birth") && tokens.has("date"))) return "date_of_birth";
  if ((tokens.has("first") && tokens.has("name")) || (tokens.has("given") && tokens.has("name")) || tokens.has("forename")) {
    return "legal_first_name";
  }
  if ((tokens.has("last") && tokens.has("name")) || (tokens.has("family") && tokens.has("name")) || tokens.has("surname")) {
    return "legal_last_name";
  }
  if ((tokens.has("preferred") && tokens.has("name")) || tokens.has("nickname") || (tokens.has("nick") && tokens.has("name"))) {
    return "preferred_name";
  }
  if (
    (tokens.has("membership") && tokens.has("start") && tokens.has("date")) ||
    (tokens.has("membership") && tokens.has("date")) ||
    (tokens.has("enrollment") && tokens.has("date")) ||
    (tokens.has("enrolment") && tokens.has("date")) ||
    (tokens.has("join") && tokens.has("date")) ||
    (tokens.has("member") && tokens.has("since")) ||
    (tokens.has("start") && tokens.has("date") && !tokens.has("class") && !tokens.has("belt"))
  ) {
    return "membership_start_date";
  }
  if (tokens.has("program") || tokens.has("track")) return "program_id";
  if (tokens.has("order") && (tokens.has("belt") || tokens.has("rank"))) return "";
  if (tokens.has("belt") && (tokens.has("current") || tokens.has("rank"))) return "current_belt_rank_id";
  if (tokens.has("email") || tokens.has("mail")) return "email";
  if (tokens.has("phone") || tokens.has("mobile") || tokens.has("cell") || tokens.has("telephone") || tokens.has("tel")) {
    return "phone";
  }
  if (tokens.has("status")) return "status";
  if (tokens.has("notes") || tokens.has("note")) return "notes";
  if (tokens.has("tags") || tokens.has("tag") || tokens.has("labels")) return "tags";
  if (tokens.has("address")) return "address_line1";
  if (tokens.has("city")) return "address_city";
  if (tokens.has("state") || tokens.has("province")) return "address_state";
  if (tokens.has("zip") || (tokens.has("postal") && tokens.has("code"))) return "address_zip";
  return "";
}

function autoMap(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  headers.forEach((header) => {
    const normalized = normalizeHeader(header);
    mapping[header] =
      CSV_ALIASES[normalized] ||
      COMPACT_CSV_ALIASES[compactHeader(header)] ||
      inferFieldFromTokens(new Set(normalized.split(/\s+/).filter(Boolean))) ||
      "";
  });
  return mapping;
}

function mockParseCSV(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = (event.target?.result as string) || "";
      const parsedRows = parseCsvText(text);
      if (parsedRows.length === 0) {
        resolve({ headers: [], rows: [] });
        return;
      }

      const headers = parsedRows[0].map((value) => value.trim());
      const rows = parsedRows.slice(1).map((values) => {
        const row: Record<string, string> = {};
        headers.forEach((header, index) => {
          row[header] = values[index]?.trim() || "";
        });
        return row;
      });

      resolve({ headers, rows });
    };
    reader.readAsText(file);
  });
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        value += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim())) {
        rows.push(row);
      }
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  row.push(value);
  if (row.some((cell) => cell.trim())) {
    rows.push(row);
  }

  return rows;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message && error.message !== "[object Object]") {
      return error.message;
    }

    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const record = cause as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
      if (typeof record.msg === "string" && record.msg.trim()) {
        return record.msg;
      }
    }
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    if (typeof record.msg === "string" && record.msg.trim()) {
      return record.msg;
    }
    if (typeof record.detail === "string" && record.detail.trim()) {
      return record.detail;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {}
  }

  return "Something went wrong. Please try again.";
}

function buildPreviewValidationResult(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  options: CsvImportOptions
): CsvImportResult {
  const issueRows: CsvImportResult["rows"] = [];
  const warnings: CsvImportResult["warnings"] = [];
  const validStatuses = ["active", "trialing", "inactive", "paused", "canceled"];
  let validRows = 0;
  let normalizedStatusCount = 0;

  rows.forEach((row, index) => {
    const mapped: Record<string, string | string[]> = {};
    Object.entries(mapping).forEach(([csvCol, koaryuField]) => {
      if (koaryuField && row[csvCol]) mapped[koaryuField] = row[csvCol];
    });

    const issues: CsvImportResult["rows"][number]["issues"] = [];
    const rawStatus = typeof mapped.status === "string" ? mapped.status.trim().toLowerCase() : "";
    const statusValue = typeof mapped.status === "string" ? mapped.status : "";

    if (!mapped.legal_first_name) {
      issues.push({
        code: "missing_first_name",
        severity: "error",
        field: "legal_first_name",
        message: "Missing required field: first name",
      });
    }
    if (!mapped.legal_last_name) {
      issues.push({
        code: "missing_last_name",
        severity: "error",
        field: "legal_last_name",
        message: "Missing required field: last name",
      });
    }

    if (rawStatus && options.status_alias_mode === "normalize" && rawStatus === "overdue") {
      normalizedStatusCount += 1;
      mapped.status = "paused";
      issues.push({
        code: "normalized_status",
        severity: "warning",
        field: "status",
        value: statusValue,
        message: `Status "${statusValue}" will be imported as "paused".`,
      });
    } else if (rawStatus && !validStatuses.includes(rawStatus)) {
      issues.push({
        code: "invalid_status",
        severity: "error",
        field: "status",
        value: statusValue,
        message: `Invalid status "${statusValue}". Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const isValid = !issues.some((issue) => issue.severity === "error");
    if (isValid) validRows += 1;

    if (issues.length > 0) {
      issueRows.push({
        row_number: index + 2,
        data: mapped,
        issues,
        is_valid: isValid,
      });
    }
  });

  if (normalizedStatusCount > 0) {
    warnings.push({
      code: "normalized_status",
      message: "Some student statuses will be normalized during import.",
      severity: "warning",
      row_numbers: issueRows
        .filter((row) => row.issues.some((issue) => issue.code === "normalized_status"))
        .map((row) => row.row_number),
      field: "status",
      values: ["overdue"],
    });
  }

  return {
    total_rows: rows.length,
    valid_rows: validRows,
    error_rows: issueRows.filter((row) => !row.is_valid).length,
    rows: issueRows,
    warnings,
    setup_issues: [],
    actions_available: {
      can_create_missing_programs: false,
      can_create_missing_belts: false,
      can_import_without_unresolved_belt: false,
    },
    created_programs: [],
    created_ladders: [],
    created_belts: [],
    imported_without_belt_count: 0,
    normalized_status_count: normalizedStatusCount,
    imported_count: 0,
  };
}

function buildPreflightSummary(result: CsvImportResult): string {
  const setupCodes = new Set(result.setup_issues.map((issue) => issue.code));
  if (setupCodes.has("missing_belt_ladder")) {
    if (result.actions_available.can_create_missing_belts) {
      return "Your CSV is mostly ready. Koaryu can create the missing program ladders and belt ranks during import, then you can fine-tune their order afterward.";
    }
    return "Your CSV is mostly ready, but some program belt ladders are not set up yet. Students can still import without current belts, and Koaryu will preserve the original belt text in notes.";
  }
  if (setupCodes.has("missing_belt")) {
    if (result.actions_available.can_create_missing_belts) {
      return "Your CSV includes current belt values that can be created inside the matching program ladders during import.";
    }
    return "Your CSV includes current belt values that do not match this studio's ladders yet. You can still import those students without belt assignments, and Koaryu will preserve the original belt text in notes.";
  }
  if (setupCodes.has("ambiguous_belt_ladder")) {
    return "Some programs have more than one belt ladder, so Koaryu needs you to clean that up before it can auto-create current belts safely.";
  }
  if (setupCodes.has("missing_program")) {
    return "Your CSV references programs that are not set up in this studio yet. You can create them during import.";
  }
  if (result.error_rows > 0) {
    return "Some rows still have blocking issues. Review the grouped errors below before importing.";
  }
  if (result.warnings.length > 0) {
    return "The CSV is importable, but we found a few non-blocking warnings to review first.";
  }
  return "Your CSV looks ready to import.";
}

function getRowDisplayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  if (value == null) return "—";
  return String(value);
}

function formatRowNumbers(rowNumbers: number[]): string {
  const sorted = [...rowNumbers].sort((a, b) => a - b);
  if (sorted.length <= 8) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, 8).join(", ")} + ${sorted.length - 8} more`;
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortRecord(input: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right))
  );
}

function buildStableImportKey(params: {
  file: File;
  rowCount: number;
  mapping: Record<string, string>;
  options: CsvImportOptions;
}) {
  const { file, rowCount, mapping, options } = params;
  const fingerprint = JSON.stringify({
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    rowCount,
    mapping: sortRecord(mapping),
    options,
  });

  return `student-import:${hashString(fingerprint)}`;
}

function SectionCard({
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
    <div className={`bg-surface border rounded-[6px] overflow-hidden ${toneClasses[tone]}`}>
      <div className="px-4 py-3 border-b border-border flex items-start gap-2">
        {icon}
        <div>
          <p className="text-sm font-medium text-text-primary">{title}</p>
          {description ? <p className="text-xs text-muted mt-0.5">{description}</p> : null}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export default function ImportPage() {
  const router = useRouter();
  const { isPreviewMode, token } = useConfigStore();
  const { importStudents } = useStudentStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validationResult, setValidationResult] = useState<CsvImportResult | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [importOptions, setImportOptions] = useState<CsvImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [submittedImportOptions, setSubmittedImportOptions] = useState<CsvImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [isLoading, setIsLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function resetImportState() {
    setStage("upload");
    setFile(null);
    setHeaders([]);
    setRows([]);
    setRowCount(0);
    setMapping({});
    setValidationResult(null);
    setImportResult(null);
    setImportOptions(DEFAULT_IMPORT_OPTIONS);
    setSubmittedImportOptions(DEFAULT_IMPORT_OPTIONS);
    setErrorMessage(null);
  }

  const duplicateMappingEntries = useMemo(() => {
    const counts = Object.values(mapping).reduce<Record<string, number>>((acc, field) => {
      if (!field) return acc;
      acc[field] = (acc[field] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).filter(([, count]) => count > 1);
  }, [mapping]);

  const missingRequiredMappings = useMemo(() => {
    const selectedFields = new Set(Object.values(mapping).filter(Boolean));
    return REQUIRED_FIELDS.filter((field) => !selectedFields.has(field));
  }, [mapping]);

  const mappingBlockers = [
    ...missingRequiredMappings.map((field) => ({
      code: "missing_required_mapping",
      message: `${KOARYU_FIELDS.find((item) => item.value === field)?.label || field} is still unmapped.`,
    })),
    ...duplicateMappingEntries.map(([field]) => ({
      code: "duplicate_mapping",
      message: `${KOARYU_FIELDS.find((item) => item.value === field)?.label || field} is mapped more than once.`,
    })),
  ];

  const issueRows = validationResult?.rows || [];
  const blockingRows = issueRows.filter((row) => row.issues.some((issue) => issue.severity === "error"));
  const warningRows = issueRows.filter(
    (row) => row.is_valid && row.issues.some((issue) => issue.severity === "warning")
  );
  const warningIssueGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      issue: CsvImportResult["rows"][number]["issues"][number];
      rowNumbers: number[];
      mappedValues: string[];
    }>();

    warningRows.forEach((row) => {
      row.issues
        .filter((issue) => issue.severity === "warning")
        .forEach((issue) => {
          const mappedValue = issue.field && row.data[issue.field] !== undefined
            ? getRowDisplayValue(row.data[issue.field])
            : null;
          const key = [
            issue.code,
            issue.field || "",
            issue.value || "",
            issue.message,
            issue.suggested_action || "",
          ].join("::");

          const existing = groups.get(key);
          if (existing) {
            existing.rowNumbers.push(row.row_number);
            if (mappedValue && !existing.mappedValues.includes(mappedValue)) {
              existing.mappedValues.push(mappedValue);
            }
            return;
          }

          groups.set(key, {
            key,
            issue,
            rowNumbers: [row.row_number],
            mappedValues: mappedValue ? [mappedValue] : [],
          });
        });
    });

    return Array.from(groups.values()).sort((left, right) => {
      if (right.rowNumbers.length !== left.rowNumbers.length) {
        return right.rowNumbers.length - left.rowNumbers.length;
      }
      return left.rowNumbers[0] - right.rowNumbers[0];
    });
  }, [warningRows]);
  const blockingIssueGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      issue: CsvImportResult["rows"][number]["issues"][number];
      rowNumbers: number[];
      mappedValues: string[];
    }>();

    blockingRows.forEach((row) => {
      row.issues
        .filter((issue) => issue.severity === "error")
        .forEach((issue) => {
          const mappedValue = issue.field && row.data[issue.field] !== undefined
            ? getRowDisplayValue(row.data[issue.field])
            : null;
          const key = [
            issue.code,
            issue.field || "",
            issue.value || "",
            issue.message,
            issue.suggested_action || "",
          ].join("::");

          const existing = groups.get(key);
          if (existing) {
            existing.rowNumbers.push(row.row_number);
            if (mappedValue && !existing.mappedValues.includes(mappedValue)) {
              existing.mappedValues.push(mappedValue);
            }
            return;
          }

          groups.set(key, {
            key,
            issue,
            rowNumbers: [row.row_number],
            mappedValues: mappedValue ? [mappedValue] : [],
          });
        });
    });

    return Array.from(groups.values()).sort((left, right) => {
      if (right.rowNumbers.length !== left.rowNumbers.length) {
        return right.rowNumbers.length - left.rowNumbers.length;
      }
      return left.rowNumbers[0] - right.rowNumbers[0];
    });
  }, [blockingRows]);
  const preflightSummary = validationResult ? buildPreflightSummary(validationResult) : "";
  const importOptionsForDoneScreen = submittedImportOptions;
  const activeImportKey = useMemo(() => {
    if (!file) {
      return null;
    }

    return buildStableImportKey({
      file,
      rowCount,
      mapping,
      options: importOptions,
    });
  }, [file, importOptions, mapping, rowCount]);

  async function handleFile(nextFile: File) {
    if (!nextFile.name.toLowerCase().endsWith(".csv")) {
      setErrorMessage("Please upload a .csv file.");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setValidationResult(null);
    setImportResult(null);

    try {
      if (isPreviewMode) {
        const parsed = await mockParseCSV(nextFile);
        setFile(nextFile);
        setHeaders(parsed.headers);
        setRows(parsed.rows);
        setRowCount(parsed.rows.length);
        setMapping(autoMap(parsed.headers));
      } else {
        if (!token) {
          throw new Error("You need to be signed in before importing students.");
        }

        const formData = new FormData();
        formData.append("file", nextFile);

        const parsed = await api.postForm<CsvParseResponse>(
          "/students/import/parse",
          formData,
          token,
          {
            timeoutMs: 30000,
            timeoutMessage: "Parsing this CSV is taking longer than expected. Please try again in a moment.",
          }
        );

        setFile(nextFile);
        setHeaders(parsed.headers);
        setRows(parsed.preview_rows);
        setRowCount(parsed.total_rows);
        setMapping(parsed.auto_mapping);
      }
      setStage("map");
    } catch (error) {
      resetImportState();
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleValidate(nextOptions: CsvImportOptions = importOptions) {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      if (!file) {
        throw new Error("Choose a CSV file before validating.");
      }

      if (isPreviewMode) {
        setValidationResult(buildPreviewValidationResult(rows, mapping, nextOptions));
      } else {
        if (!token) {
          throw new Error("You need to be signed in before importing students.");
        }

        const formData = new FormData();
        formData.append("file", file);
        formData.append("payload", JSON.stringify({
          mapping,
          options: nextOptions,
        }));

        const result = await api.postForm<CsvImportResult>(
          "/students/import/validate",
          formData,
          token,
          {
            timeoutMs: 30000,
            timeoutMessage: "Validation is taking longer than expected. Please wait a moment and try again.",
          }
        );

        setValidationResult(result);
      }

      setStage("preview");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleImport() {
    if (!file) {
      setErrorMessage("Choose a CSV file before importing.");
      return;
    }

    if (!activeImportKey) {
      setErrorMessage("We could not prepare a stable import key for this file. Re-upload the CSV and try again.");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const result = await importStudents(file, rows, mapping, importOptions, {
        importKey: activeImportKey,
      });
      setSubmittedImportOptions(importOptions);
      setImportResult(result);
      setStage("done");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOptionToggle<K extends keyof CsvImportOptions>(key: K, value: CsvImportOptions[K]) {
    const nextOptions = { ...importOptions, [key]: value };
    setImportOptions(nextOptions);
    if (stage === "preview" && file) {
      await handleValidate(nextOptions);
    }
  }

  const STAGE_STEPS: { id: Stage; label: string }[] = [
    { id: "upload", label: "Upload" },
    { id: "map", label: "Map Columns" },
    { id: "preview", label: "Preview & Validate" },
    { id: "done", label: "Done" },
  ];

  const stageIndex = STAGE_STEPS.findIndex((item) => item.id === stage);
  const importedCount = importResult?.imported_count ?? 0;
  const importedAllValidatedRows = importedCount > 0 && importResult?.valid_rows === importedCount;
  const doneTitle = importResult
    ? importedCount === 0
      ? "No students were imported"
      : importedAllValidatedRows
      ? "Import complete"
      : "Import finished with follow-up items"
    : "Import complete";

  return (
    <>
      <Header title="Import Students" description="Import students from a CSV or spreadsheet.">
        <Button variant="ghost" size="sm" onClick={() => router.push("/students")}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
      </Header>

      <div className="flex-1 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2 mb-8 flex-wrap">
            {STAGE_STEPS.map((step, index) => (
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
                {index < STAGE_STEPS.length - 1 ? <ChevronRight className="w-3.5 h-3.5 text-border" /> : null}
              </div>
            ))}
          </div>

          {errorMessage ? (
            <DismissibleNotice
              tone="danger"
              onDismiss={() => setErrorMessage(null)}
              className="mb-6"
            >
              {errorMessage}
            </DismissibleNotice>
          ) : null}

          {stage === "upload" ? (
            <div>
              <div
                className={`border-2 border-dashed rounded-[6px] p-12 text-center cursor-pointer transition-all duration-150 ${
                  dragOver ? "border-accent bg-accent/5" : "border-border hover:border-accent/50"
                }`}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  const droppedFile = event.dataTransfer.files[0];
                  if (droppedFile) void handleFile(droppedFile);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-8 h-8 text-muted mx-auto mb-3" />
                <p className="text-sm text-text-primary mb-1">Drop your CSV file here, or click to select</p>
                <p className="text-xs text-muted">Supports .csv files exported from Google Sheets, Excel, or any spreadsheet</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0];
                    if (selectedFile) void handleFile(selectedFile);
                  }}
                />
              </div>

              <div className="mt-6 bg-surface border border-border rounded-[6px] p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-text-secondary">Expected columns (minimum required)</p>
                  <a
                    href="/demo-students.csv"
                    download
                    className="text-xs text-accent hover:text-accent-hover"
                  >
                    Download demo CSV
                  </a>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {["First Name", "Last Name"].map((column) => (
                    <span
                      key={column}
                      className="px-2 py-0.5 text-xs bg-accent/10 text-accent border border-accent/20 rounded-[4px]"
                    >
                      {column} *
                    </span>
                  ))}
                  {["Email", "Phone", "Date of Birth", "Status", "Program", "Current Belt"].map((column) => (
                    <span
                      key={column}
                      className="px-2 py-0.5 text-xs bg-surface-raised border border-border rounded-[4px] text-text-secondary"
                    >
                      {column}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {stage === "map" ? (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <FileText className="w-4 h-4 text-text-secondary" />
                <p className="text-sm text-text-primary font-medium">{file?.name}</p>
                <span className="text-xs text-muted font-mono">{rowCount} rows</span>
                <button
                  onClick={resetImportState}
                  className="ml-auto text-muted hover:text-text-secondary cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {mappingBlockers.length > 0 ? (
                <SectionCard
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
                </SectionCard>
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
                  const sampleValues = rows.slice(0, 3).map((row) => row[header]).filter(Boolean);
                  const isDuplicate = !!selectedField && duplicateMappingEntries.some(([field]) => field === selectedField);
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
                        <select
                          value={selectedField}
                          onChange={(event) => setMapping((current) => ({ ...current, [header]: event.target.value }))}
                          className="w-full px-2 py-1.5 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
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
                  onClick={() => handleValidate()}
                  disabled={mappingBlockers.length > 0}
                >
                  Validate {rowCount} rows
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ) : null}

          {stage === "preview" && validationResult ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-surface border border-border rounded-[6px] p-4 text-center">
                  <p className="text-2xl font-bold text-text-primary font-mono">{validationResult.total_rows}</p>
                  <p className="text-xs text-muted mt-1">Total rows</p>
                </div>
                <div className="bg-surface border border-success/20 rounded-[6px] p-4 text-center">
                  <p className="text-2xl font-bold text-success font-mono">{validationResult.valid_rows}</p>
                  <p className="text-xs text-muted mt-1">Ready to import</p>
                </div>
                <div
                  className={`bg-surface border rounded-[6px] p-4 text-center ${
                    validationResult.error_rows > 0 ? "border-danger/20" : "border-border"
                  }`}
                >
                  <p
                    className={`text-2xl font-bold font-mono ${
                      validationResult.error_rows > 0 ? "text-danger" : "text-muted"
                    }`}
                  >
                    {validationResult.error_rows}
                  </p>
                  <p className="text-xs text-muted mt-1">Rows with blockers</p>
                </div>
              </div>

              <SectionCard
                title="Preflight review"
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
                          onChange={(event) => void handleOptionToggle("create_missing_programs", event.target.checked)}
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
                        onChange={(event) => void handleOptionToggle("create_missing_belts", event.target.checked)}
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
                        onChange={(event) => void handleOptionToggle("import_without_unresolved_belt", event.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        Import students even if their current belt cannot be matched yet. We will save the original belt text into notes so staff can reconcile it later.
                      </span>
                    </label>
                  ) : null}

                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="text-sm text-text-secondary">
                      Status aliases are currently set to <span className="font-medium text-text-primary">normalize</span> so values like <span className="font-mono">overdue</span> become <span className="font-mono">paused</span>.
                    </div>
                    {validationResult.actions_available.belt_tracker_href ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => router.push(validationResult.actions_available.belt_tracker_href!)}
                      >
                        Open Belt Tracker
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </SectionCard>

              {validationResult.setup_issues.length > 0 ? (
                <SectionCard
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
                </SectionCard>
              ) : null}

              {validationResult.warnings.length > 0 ? (
                <SectionCard
                  title="Warnings"
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
                </SectionCard>
              ) : null}

              {blockingRows.length > 0 ? (
                <SectionCard
                  title="Blocking row issues"
                  description="Repeated blockers are grouped together so you can see the real cleanup work at a glance."
                  icon={<AlertCircle className="w-4 h-4 text-danger mt-0.5" />}
                  tone="danger"
                >
                  <div className="space-y-3">
                    {blockingIssueGroups.map((group) => (
                      <div key={group.key} className="border border-border rounded-[6px] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-danger">{group.issue.message}</p>
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
                          <Badge variant="danger">
                            {group.rowNumbers.length} {group.rowNumbers.length === 1 ? "row" : "rows"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ) : null}

              {warningRows.length > 0 ? (
                <SectionCard
                  title="Importable rows with warnings"
                  description="Repeated warnings are grouped together so the import impact stays easy to scan."
                  icon={<Info className="w-4 h-4 text-warning mt-0.5" />}
                  tone="warning"
                >
                  <div className="space-y-3">
                    {warningIssueGroups.map((group) => (
                      <div key={group.key} className="border border-border rounded-[6px] p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-warning">{group.issue.message}</p>
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
                          <Badge variant="warning">
                            {group.rowNumbers.length} {group.rowNumbers.length === 1 ? "row" : "rows"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ) : null}

              <div className="flex gap-3 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setStage("map")}>
                  Back to mapping
                </Button>
                {validationResult.valid_rows > 0 ? (
                  <Button variant="primary" size="md" isLoading={isLoading} onClick={handleImport}>
                    Import {validationResult.valid_rows} students
                  </Button>
                ) : null}
              </div>
              {validationResult.valid_rows > 0 ? (
                <p className="text-xs text-muted text-right">
                  If the connection drops during import, retry with this exact file and option set. Koaryu will reuse the same import key instead of creating duplicate students.
                </p>
              ) : null}
            </div>
          ) : null}

          {stage === "done" && importResult ? (
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
                <span className={`font-mono font-bold ${importedCount > 0 ? "text-success" : "text-danger"}`}>
                  {importedCount}
                </span>{" "}
                of{" "}
                <span className="font-mono font-bold text-text-primary">{importResult.valid_rows}</span> validated rows were imported.
              </p>
              {importResult.error_rows > 0 ? (
                <p className="text-sm text-text-secondary">
                  <span className="text-danger font-mono">{importResult.error_rows}</span> rows still have blockers and were skipped.
                </p>
              ) : null}
              {importResult.created_programs.length > 0 ? (
                <p className="text-sm text-text-secondary mt-2">
                  Created programs: <span className="font-medium text-text-primary">{importResult.created_programs.join(", ")}</span>
                </p>
              ) : null}
              {importResult.created_ladders.length > 0 ? (
                <p className="text-sm text-text-secondary mt-1">
                  Created ladders: <span className="font-medium text-text-primary">{importResult.created_ladders.join(", ")}</span>
                </p>
              ) : null}
              {importResult.created_belts.length > 0 ? (
                <p className="text-sm text-text-secondary mt-1">
                  Created belts: <span className="font-medium text-text-primary">{importResult.created_belts.join(", ")}</span>
                </p>
              ) : null}
              {importResult.imported_without_belt_count > 0 ? (
                <p className="text-sm text-text-secondary mt-1">
                  {importResult.imported_without_belt_count} student(s) were imported without a current belt, and their original belt text was saved to notes.
                </p>
              ) : null}
              {importResult.normalized_status_count > 0 ? (
                <p className="text-sm text-text-secondary mt-1">
                  {importResult.normalized_status_count} status value(s) were normalized during import.
                </p>
              ) : null}
              <p className="text-sm text-text-secondary mt-1">
                Selected remediation:{" "}
                {[
                  importOptionsForDoneScreen.create_missing_programs ? "Create programs" : null,
                  importOptionsForDoneScreen.create_missing_belts ? "Create ladders and belts" : null,
                  importOptionsForDoneScreen.import_without_unresolved_belt ? "Import without unresolved belts" : null,
                ].filter(Boolean).join(" · ") || "None"}
              </p>
              <div className="flex gap-3 justify-center mt-8">
                <Button variant="secondary" size="md" onClick={resetImportState}>
                  Import another file
                </Button>
                <Button variant="primary" size="md" onClick={() => router.push("/students")}>
                  View students
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
