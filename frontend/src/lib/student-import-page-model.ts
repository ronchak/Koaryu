import type { CsvImportOptions, CsvImportResult, StudentStatus } from "@/types";

export type StudentImportStage = "upload" | "map" | "preview" | "done";
export type ActiveStudentImportOperation = "file" | "validation" | "import" | null;

export const STUDENT_IMPORT_STAGE_STEPS: { id: StudentImportStage; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "map", label: "Map Columns" },
  { id: "preview", label: "Preview & Validate" },
  { id: "done", label: "Done" },
];

export const KOARYU_FIELDS: { value: string; label: string; required?: boolean }[] = [
  { value: "", label: "— Skip this column —" },
  { value: "full_name", label: "Full Name" },
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

export const REQUIRED_FIELDS = KOARYU_FIELDS
  .filter((field) => field.required)
  .map((field) => field.value);

export const DEFAULT_IMPORT_OPTIONS: CsvImportOptions = {
  create_missing_programs: false,
  create_missing_belts: false,
  import_without_unresolved_belt: true,
  status_alias_mode: "normalize",
};

export const STATUS_ALIASES: Record<string, StudentStatus> = {
  current: "active",
  frozen: "paused",
  hold: "paused",
  "on hold": "paused",
  overdue: "paused",
  trial: "trialing",
};

export function getStudentImportStageIndex(stage: StudentImportStage) {
  return STUDENT_IMPORT_STAGE_STEPS.findIndex((item) => item.id === stage);
}

export function getCsvImportFileRejection(
  file: Pick<File, "name" | "size">,
  limits: { maxBytes: number; formattedLimit: string }
) {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return "Please upload a .csv file.";
  }

  if (file.size > limits.maxBytes) {
    return `This CSV is too large. Upload a file under ${limits.formattedLimit}.`;
  }

  return null;
}

export function getStudentImportErrorMessage(error: unknown): string {
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

export type SplitCsvImportFullName = (rawValue: unknown) => { firstName: string; lastName: string };

export function buildPreviewValidationResult(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  options: CsvImportOptions,
  splitFullName: SplitCsvImportFullName
): CsvImportResult {
  const issueRows: CsvImportResult["rows"] = [];
  const warnings: CsvImportResult["warnings"] = [];
  const validStatuses = new Set<StudentStatus>(["active", "trialing", "inactive", "paused", "canceled"]);
  let validRows = 0;
  let normalizedStatusCount = 0;
  const targetCounts = Object.values(mapping).reduce<Record<string, number>>((acc, field) => {
    if (!field) return acc;
    acc[field] = (acc[field] || 0) + 1;
    return acc;
  }, {});

  rows.forEach((row, index) => {
    const mapped: Record<string, string | string[]> = {};
    Object.entries(mapping).forEach(([csvCol, koaryuField]) => {
      if (!koaryuField || !row[csvCol]) return;
      if (koaryuField === "full_name") {
        const { firstName, lastName } = splitFullName(row[csvCol]);
        if (firstName && !mapped.legal_first_name) mapped.legal_first_name = firstName;
        if (lastName && !mapped.legal_last_name) mapped.legal_last_name = lastName;
        return;
      }
      if (koaryuField === "notes" && targetCounts.notes > 1) {
        const existingNotes = typeof mapped.notes === "string" ? mapped.notes : "";
        mapped.notes = [existingNotes, `${csvCol}: ${row[csvCol]}`].filter(Boolean).join("\n");
        return;
      }
      mapped[koaryuField] = row[csvCol];
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

    if (rawStatus && options.status_alias_mode === "normalize" && STATUS_ALIASES[rawStatus]) {
      const normalizedStatus = STATUS_ALIASES[rawStatus];
      normalizedStatusCount += 1;
      mapped.status = normalizedStatus;
      issues.push({
        code: "normalized_status",
        severity: "warning",
        field: "status",
        value: statusValue,
        message: `Status "${statusValue}" will be imported as "${normalizedStatus}".`,
      });
    } else if (rawStatus && !validStatuses.has(rawStatus as StudentStatus)) {
      issues.push({
        code: "invalid_status",
        severity: "error",
        field: "status",
        value: statusValue,
        message: `Koaryu does not recognize "${statusValue}" as a student status. Use Active, Trialing, Paused, Inactive, or Canceled, or skip the Status column.`,
      });
    }

    const isValid = !issues.some((issue) => issue.severity === "error");
    if (isValid) validRows += 1;

    if (issues.length > 0) {
      issueRows.push({
        row_number: index + 2,
        data: mapped,
        issues,
        errors: issues.filter((issue) => issue.severity === "error").map((issue) => issue.message),
        warnings: issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
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
      values: Array.from(new Set(issueRows.flatMap((row) =>
        row.issues
          .filter((issue) => issue.code === "normalized_status" && issue.value)
          .map((issue) => String(issue.value))
      ))),
    });
  }

  return {
    total_rows: rows.length,
    valid_rows: validRows,
    error_rows: issueRows.filter((row) => !row.is_valid).length,
    rows: issueRows,
    errors: issueRows.filter((row) => !row.is_valid),
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
    reused_result: false,
    execution_status: "completed",
    non_critical_errors: [],
  };
}

export function buildPreflightSummary(result: CsvImportResult): string {
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

export function getRowDisplayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  if (value == null) return "\u2014";
  return String(value);
}

export function formatRowNumbers(rowNumbers: number[]): string {
  const sorted = [...rowNumbers].sort((a, b) => a - b);
  if (sorted.length <= 8) {
    return sorted.join(", ");
  }
  return `${sorted.slice(0, 8).join(", ")} + ${sorted.length - 8} more`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export interface CsvImportIssueGroup {
  key: string;
  issue: CsvImportResult["rows"][number]["issues"][number];
  rowNumbers: number[];
  mappedValues: string[];
}

export function buildCsvImportIssueGroups(
  rows: CsvImportResult["rows"],
  severity: "error" | "warning"
): CsvImportIssueGroup[] {
  const groups = new Map<string, CsvImportIssueGroup>();

  rows.forEach((row) => {
    row.issues
      .filter((issue) => issue.severity === severity)
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
}

const CSV_PAYMENT_STATUS_TOKENS = new Set([
  "account",
  "balance",
  "billing",
  "dues",
  "fee",
  "fees",
  "invoice",
  "paid",
  "payment",
  "subscription",
  "autopay",
  "auto",
  "tuition",
]);

const RAW_CSV_ALIASES: Record<string, string> = {
  "first name": "legal_first_name",
  "first_names": "legal_first_name",
  "student first name": "legal_first_name",
  "given name": "legal_first_name",
  given: "legal_first_name",
  child: "legal_first_name",
  forename: "legal_first_name",
  "full student name": "full_name",
  "student full name": "full_name",
  "student name": "full_name",
  "full name": "full_name",
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
  "account status": "",
  "billing status": "",
  "invoice status": "",
  "paid status": "",
  "payment status": "",
  "subscription status": "",
  "autopay status": "",
  "auto pay status": "",
  "tuition status": "",
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
  rank: "current_belt_rank_id",
  "rank belt": "current_belt_rank_id",
  "rank/belt": "current_belt_rank_id",
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

function lookupAlias(table: Record<string, string>, key: string) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function isPaymentStatusHeader(header: string) {
  const tokens = new Set(normalizeHeader(header).split(/\s+/).filter(Boolean));
  const compact = compactHeader(header);
  return (
    tokens.has("status") &&
    Array.from(CSV_PAYMENT_STATUS_TOKENS).some((token) => tokens.has(token))
  ) || Array.from(CSV_PAYMENT_STATUS_TOKENS).some((token) => compact.includes(`${token}status`));
}

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
  if (
    (tokens.has("full") && tokens.has("name")) ||
    (tokens.has("student") && tokens.has("name")) ||
    (tokens.has("student") && tokens.has("full") && tokens.has("name"))
  ) {
    return "full_name";
  }
  if ((tokens.has("first") && tokens.has("name")) || (tokens.has("given") && tokens.has("name")) || tokens.has("forename")) {
    return "legal_first_name";
  }
  if (tokens.has("given") || tokens.has("child")) return "legal_first_name";
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
  if (tokens.has("rank") && !["class", "attendance", "order", "sort"].some((token) => tokens.has(token))) {
    return "current_belt_rank_id";
  }
  if (tokens.has("email") || tokens.has("mail")) return "email";
  if (tokens.has("phone") || tokens.has("mobile") || tokens.has("cell") || tokens.has("telephone") || tokens.has("tel")) {
    return "phone";
  }
  if (tokens.has("status") && !Array.from(CSV_PAYMENT_STATUS_TOKENS).some((token) => tokens.has(token))) return "status";
  if (tokens.has("notes") || tokens.has("note")) return "notes";
  if (tokens.has("tags") || tokens.has("tag") || tokens.has("labels")) return "tags";
  if (tokens.has("address")) return "address_line1";
  if (tokens.has("city")) return "address_city";
  if (tokens.has("state") || tokens.has("province")) return "address_state";
  if (tokens.has("zip") || (tokens.has("postal") && tokens.has("code"))) return "address_zip";
  return "";
}

export function autoMap(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  headers.forEach((header) => {
    const normalized = normalizeHeader(header);
    const aliasMatch = lookupAlias(CSV_ALIASES, normalized);
    const compactMatch = lookupAlias(COMPACT_CSV_ALIASES, compactHeader(header));
    const inferredMatch = inferFieldFromTokens(new Set(normalized.split(/\s+/).filter(Boolean)));
    mapping[header] = aliasMatch ?? compactMatch ?? inferredMatch ?? "";
  });
  return mapping;
}

export function parseCsvText(text: string): string[][] {
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

export function mockParseCSV(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
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

export function getKoaryuFieldLabel(field: string) {
  return KOARYU_FIELDS.find((item) => item.value === field)?.label || field;
}
