import type {
  BeltLadder,
  BeltRank,
  CsvImportOptions,
  CsvImportResult,
  Program,
  Student,
  StudentStatus,
} from "@/types";

export const CSV_IMPORT_STATUS_ALIASES: Record<string, StudentStatus> = {
  current: "active",
  frozen: "paused",
  hold: "paused",
  "on hold": "paused",
  overdue: "paused",
  trial: "trialing",
};

const VALID_CSV_IMPORT_STATUSES: StudentStatus[] = [
  "active",
  "trialing",
  "inactive",
  "paused",
  "canceled",
];
const MINOR_AGE_MS = 18 * 365.25 * 24 * 60 * 60 * 1000;
const NAME_PARTICLES = new Set([
  "da",
  "das",
  "de",
  "del",
  "di",
  "dos",
  "du",
  "la",
  "le",
  "saint",
  "st",
  "van",
  "von",
]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

type PreviewImportRowIssue = CsvImportResult["rows"][number]["issues"][number];

interface BuildPreviewStudentImportResultInput {
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  options: CsvImportOptions;
  programs: Program[];
  beltLadders: BeltLadder[];
  fallbackRanks: BeltRank[];
  existingStudents: Student[];
  idFactory: () => string;
  now?: () => Date;
  nowMs?: () => number;
}

export interface PreviewStudentImportExecution {
  result: CsvImportResult;
  students: Student[];
  importedStudents: Student[];
}

function normalizeNameToken(token: string) {
  return token.toLowerCase().replace(/[^a-z]+/g, "");
}

function splitCsvImportFullName(rawValue: unknown): { firstName: string; lastName: string } {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    return { firstName: "", lastName: "" };
  }

  if (value.includes(",")) {
    const [lastName, firstName] = value.split(",", 2).map((part) => part.trim());
    if (firstName && lastName) {
      return { firstName, lastName };
    }
  }

  const parts = value.split(/\s+/);
  if (parts.length < 2) {
    return { firstName: value, lastName: "" };
  }

  let lastStart = parts.length - 1;
  while (lastStart > 0 && NAME_PARTICLES.has(normalizeNameToken(parts[lastStart - 1]))) {
    lastStart -= 1;
  }

  if (NAME_SUFFIXES.has(normalizeNameToken(parts[parts.length - 1])) && parts.length > 2) {
    lastStart = Math.max(lastStart - 1, 1);
  }

  return {
    firstName: parts.slice(0, lastStart).join(" "),
    lastName: parts.slice(lastStart).join(" "),
  };
}

function normalizePreviewLookupValue(value?: string | null) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBjjProgram(programs: Program[]) {
  return programs.find((program) =>
    normalizePreviewLookupValue(program.name).includes("brazilian jiu jitsu")
  );
}

function sortRanksByDisplayOrder(ranks: BeltRank[]) {
  return [...ranks].sort((left, right) => left.display_order - right.display_order);
}

function resolvePreviewImportProgramId(value: string | undefined, programs: Program[]) {
  const rawValue = value?.trim();
  if (!rawValue) return undefined;

  const idMatch = programs.find((program) => program.id === rawValue);
  if (idMatch) return idMatch.id;

  const normalizedValue = normalizePreviewLookupValue(rawValue);
  const nameMatch = programs.find((program) =>
    normalizePreviewLookupValue(program.name) === normalizedValue
  );
  if (nameMatch) return nameMatch.id;

  if (normalizedValue.includes("brazilian jiu jitsu")) {
    return findBjjProgram(programs)?.id;
  }

  return undefined;
}

function resolvePreviewImportBeltRankId({
  value,
  programId,
  beltLadders,
  fallbackRanks,
}: {
  value: string | undefined;
  programId?: string;
  beltLadders: BeltLadder[];
  fallbackRanks: BeltRank[];
}) {
  const rawValue = value?.trim();
  if (!rawValue) return undefined;

  const candidateLadders = programId
    ? beltLadders.filter((ladder) => ladder.program_id === programId)
    : beltLadders;
  const candidateRanks = candidateLadders.length > 0
    ? candidateLadders.flatMap((ladder) => ladder.ranks || [])
    : fallbackRanks;
  const allRanks = beltLadders.flatMap((ladder) => ladder.ranks || []);

  const idMatch = [...candidateRanks, ...allRanks].find((rank) => rank.id === rawValue);
  if (idMatch) return idMatch.id;

  const normalizedValue = normalizePreviewLookupValue(rawValue);
  const nameMatch = candidateRanks.find((rank) =>
    normalizePreviewLookupValue(rank.name) === normalizedValue
  );
  if (nameMatch) return nameMatch.id;

  const stripeNumber = normalizedValue.match(/\b(?:stripe|tip)\s+(\d+)\b/);
  if (stripeNumber) {
    const tipIndex = Number(stripeNumber[1]) - 1;
    const tipRanks = sortRanksByDisplayOrder(candidateRanks).filter((rank) => rank.is_tip);
    return tipRanks[tipIndex]?.id;
  }

  return undefined;
}

function resolvePreviewImportStudentIds({
  programValue,
  beltRankValue,
  programs,
  beltLadders,
  fallbackRanks,
}: {
  programValue?: string;
  beltRankValue?: string;
  programs: Program[];
  beltLadders: BeltLadder[];
  fallbackRanks: BeltRank[];
}) {
  const programId = resolvePreviewImportProgramId(programValue, programs);
  const hasProgramValue = Boolean(programValue?.trim());
  const shouldResolveBeltRank = !hasProgramValue || Boolean(programId);
  const beltRankId = shouldResolveBeltRank
    ? resolvePreviewImportBeltRankId({
      value: beltRankValue,
      programId,
      beltLadders,
      fallbackRanks,
    })
    : undefined;
  const issues: PreviewImportRowIssue[] = [];

  if (hasProgramValue && !programId) {
    issues.push({
      code: "unresolved_program",
      severity: "warning",
      field: "program_id",
      value: programValue,
      message: `Koaryu preview could not match "${programValue}" to an existing program, so the imported student will not be assigned to a program.`,
    });
  }
  if (beltRankValue?.trim() && !beltRankId) {
    issues.push({
      code: "unresolved_belt",
      severity: "warning",
      field: "current_belt_rank_id",
      value: beltRankValue,
      message: `Koaryu preview could not match "${beltRankValue}" to an existing belt rank, so the imported student will not be assigned to a belt rank.`,
    });
  }

  return { programId, beltRankId, issues };
}

function buildMappedImportRow(
  row: Record<string, string>,
  mapping: Record<string, string>,
  targetCounts: Record<string, number>
) {
  const mapped: Record<string, string> = {};

  for (const [csvCol, koaryuField] of Object.entries(mapping)) {
    if (!koaryuField || !row[csvCol]) continue;
    if (koaryuField === "full_name") {
      const { firstName, lastName } = splitCsvImportFullName(row[csvCol]);
      if (firstName && !mapped.legal_first_name) mapped.legal_first_name = firstName;
      if (lastName && !mapped.legal_last_name) mapped.legal_last_name = lastName;
      continue;
    }
    if (koaryuField === "notes" && targetCounts.notes > 1) {
      mapped.notes = [mapped.notes, `${csvCol}: ${row[csvCol]}`].filter(Boolean).join("\n");
      continue;
    }
    mapped[koaryuField] = row[csvCol];
  }

  return mapped;
}

function buildStatusImportIssues(
  mapped: Record<string, string>,
  options: CsvImportOptions,
) {
  const rawStatus = (mapped.status || "").trim().toLowerCase();
  const statusValue = mapped.status || "";
  const rowIssues: PreviewImportRowIssue[] = [];
  let normalizedStatus = rawStatus;
  let normalized = false;

  if (mapped.status && options.status_alias_mode === "normalize" && CSV_IMPORT_STATUS_ALIASES[rawStatus]) {
    normalizedStatus = CSV_IMPORT_STATUS_ALIASES[rawStatus];
    mapped.status = normalizedStatus;
    normalized = true;
    rowIssues.push({
      code: "normalized_status",
      severity: "warning",
      field: "status",
      value: statusValue,
      message: `Status "${statusValue}" will be imported as "${normalizedStatus}".`,
    });
  } else if (mapped.status && !VALID_CSV_IMPORT_STATUSES.includes(rawStatus as StudentStatus)) {
    rowIssues.push({
      code: "invalid_status",
      severity: "error",
      field: "status",
      value: statusValue,
      message: `Koaryu does not recognize "${mapped.status}" as a student status. Use Active, Trialing, Paused, Inactive, or Canceled, or skip the Status column.`,
    });
  }

  return { normalizedStatus, normalizedStatusValue: normalized ? statusValue : null, rowIssues };
}

function buildImportedPreviewStudent({
  mapped,
  status,
  programId,
  beltRankId,
  idFactory,
  now,
  nowMs,
}: {
  mapped: Record<string, string>;
  status: StudentStatus;
  programId?: string;
  beltRankId?: string;
  idFactory: () => string;
  now: () => Date;
  nowMs: () => number;
}): Student {
  const tags = mapped.tags ? mapped.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  const dob = mapped.date_of_birth || undefined;
  const isMinor = dob ? (nowMs() - new Date(dob).getTime()) < MINOR_AGE_MS : false;
  const createdAt = now().toISOString();
  const updatedAt = now().toISOString();
  const studentId = idFactory();
  const membershipStart = mapped.membership_start_date || now().toISOString().split("T")[0];

  return {
    id: studentId,
    studio_id: "mock-studio",
    legal_first_name: mapped.legal_first_name,
    legal_last_name: mapped.legal_last_name,
    preferred_name: mapped.preferred_name || undefined,
    date_of_birth: dob,
    is_minor: isMinor,
    email: mapped.email || undefined,
    phone: mapped.phone || undefined,
    address_line1: mapped.address_line1 || undefined,
    address_city: mapped.address_city || undefined,
    address_state: mapped.address_state || undefined,
    address_zip: mapped.address_zip || undefined,
    emergency_contact_name: mapped.emergency_contact_name || undefined,
    emergency_contact_phone: mapped.emergency_contact_phone || undefined,
    emergency_contact_relation: mapped.emergency_contact_relation || undefined,
    status,
    membership_start_date: membershipStart,
    program_id: programId,
    current_belt_rank_id: beltRankId,
    notes: mapped.notes || undefined,
    tags,
    guardians: [],
    program_memberships: programId
      ? [
          {
            id: `${studentId}-program-primary`,
            studio_id: "mock-studio",
            student_id: studentId,
            program_id: programId,
            status: "active",
            started_at: membershipStart,
            ended_at: null,
            current_belt_rank_id: beltRankId ?? null,
            created_at: createdAt,
            updated_at: updatedAt,
          },
        ]
      : [],
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function buildPreviewStudentImportResult({
  rows,
  mapping,
  options,
  programs,
  beltLadders,
  fallbackRanks,
  existingStudents,
  idFactory,
  now = () => new Date(),
  nowMs = () => Date.now(),
}: BuildPreviewStudentImportResultInput): PreviewStudentImportExecution {
  const importedStudents: Student[] = [];
  const issueRows: CsvImportResult["rows"] = [];
  const warnings: CsvImportResult["warnings"] = [];
  let validRows = 0;
  let normalizedStatusCount = 0;
  const targetCounts = Object.values(mapping).reduce<Record<string, number>>((acc, field) => {
    if (!field) return acc;
    acc[field] = (acc[field] || 0) + 1;
    return acc;
  }, {});
  const normalizedStatusValues = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const mapped = buildMappedImportRow(row, mapping, targetCounts);
    const rowIssues: PreviewImportRowIssue[] = [];

    if (!mapped.legal_first_name) {
      rowIssues.push({
        code: "missing_first_name",
        severity: "error",
        field: "legal_first_name",
        message: "Missing required field: first name",
      });
    }
    if (!mapped.legal_last_name) {
      rowIssues.push({
        code: "missing_last_name",
        severity: "error",
        field: "legal_last_name",
        message: "Missing required field: last name",
      });
    }

    const statusIssues = buildStatusImportIssues(mapped, options);
    rowIssues.push(...statusIssues.rowIssues);
    if (statusIssues.normalizedStatusValue) {
      normalizedStatusCount += 1;
      normalizedStatusValues.add(statusIssues.normalizedStatusValue);
    }

    const previewResolution = resolvePreviewImportStudentIds({
      programValue: mapped.program_id,
      beltRankValue: mapped.current_belt_rank_id,
      programs,
      beltLadders,
      fallbackRanks,
    });
    rowIssues.push(...previewResolution.issues);

    const isValid = !rowIssues.some((issue) => issue.severity === "error");

    if (rowIssues.length > 0) {
      issueRows.push({
        row_number: index + 2,
        data: mapped,
        issues: rowIssues,
        errors: rowIssues.filter((issue) => issue.severity === "error").map((issue) => issue.message),
        warnings: rowIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
        is_valid: isValid,
      });
    }

    if (!isValid) continue;

    validRows += 1;
    const status: StudentStatus = VALID_CSV_IMPORT_STATUSES.includes(statusIssues.normalizedStatus as StudentStatus)
      ? (statusIssues.normalizedStatus as StudentStatus)
      : "active";

    importedStudents.push(buildImportedPreviewStudent({
      mapped,
      status,
      programId: previewResolution.programId,
      beltRankId: previewResolution.beltRankId,
      idFactory,
      now,
      nowMs,
    }));
  }

  if (normalizedStatusCount > 0) {
    warnings.push({
      code: "normalized_status",
      message: "Some student statuses will be normalized during import.",
      severity: "warning",
      row_numbers: issueRows
        .filter((item) => item.issues.some((issue) => issue.code === "normalized_status"))
        .map((item) => item.row_number),
      field: "status",
      values: Array.from(normalizedStatusValues),
    });
  }

  return {
    students: importedStudents.length > 0
      ? [...importedStudents, ...existingStudents]
      : existingStudents,
    importedStudents,
    result: {
      total_rows: rows.length,
      valid_rows: validRows,
      error_rows: issueRows.filter((item) => !item.is_valid).length,
      rows: issueRows,
      errors: issueRows.filter((item) => !item.is_valid),
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
      imported_count: importedStudents.length,
      reused_result: false,
      execution_status: "completed",
      non_critical_errors: [],
    },
  };
}
