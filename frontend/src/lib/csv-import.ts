export const CSV_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

import type { BeltLadder, BeltRank, CsvImportResult, Program } from "../types";

export type CsvImportKeyInput = {
  rowCount: number;
  mapping: Record<string, string>;
  options: object;
  contentHash: string;
};

export type CsvImportRefreshWarningTarget = {
  execution_status?: "completed" | "completed_with_warnings" | "reused";
  non_critical_errors?: string[];
};

function canonicalizeJson(value: unknown): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeJson(entryValue)])
  );
}

function canonicalStringify(value: unknown) {
  return JSON.stringify(canonicalizeJson(value));
}

function buildImportKeyFingerprint(params: CsvImportKeyInput) {
  const { rowCount, mapping, options, contentHash } = params;
  return canonicalStringify({
    rowCount,
    contentHash,
    mapping,
    options,
  });
}

async function digestTextSha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure hashing is unavailable in this browser.");
  }

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return bytesToHex(new Uint8Array(digest));
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

export function resolvePreviewImportProgramId(value: string | undefined, programs: Program[]) {
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

export function resolvePreviewImportBeltRankId({
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

type PreviewImportRowIssue = CsvImportResult["rows"][number]["issues"][number];

export function resolvePreviewImportStudentIds({
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

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hashBytesFallback(bytes: Uint8Array) {
  let hash = 2166136261;

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }

  return `fnv:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function hashCsvImportFile(file: { arrayBuffer: () => Promise<ArrayBuffer> }) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return `sha256:${bytesToHex(new Uint8Array(digest))}`;
  }

  return hashBytesFallback(bytes);
}

export function formatCsvImportFileSizeLimit(maxBytes = CSV_IMPORT_MAX_BYTES) {
  return `${Math.floor(maxBytes / (1024 * 1024))} MB`;
}

export async function buildStableImportKey(params: CsvImportKeyInput) {
  return `student-import:sha256:${await digestTextSha256(buildImportKeyFingerprint(params))}`;
}

export function areCsvImportKeyInputsEqual(
  left: CsvImportKeyInput | null | undefined,
  right: CsvImportKeyInput | null | undefined
) {
  if (!left || !right) {
    return left === right;
  }

  return buildImportKeyFingerprint(left) === buildImportKeyFingerprint(right);
}

export function withCsvImportRefreshWarning<T extends CsvImportRefreshWarningTarget>(
  result: T,
  message: string
) {
  return {
    ...result,
    execution_status: "completed_with_warnings" as const,
    non_critical_errors: [
      ...(result.non_critical_errors || []),
      message,
    ],
  };
}
