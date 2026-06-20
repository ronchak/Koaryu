const REQUIRED_IMPORT_FIELDS = ["legal_first_name", "legal_last_name"];

const BILLING_IMPORT_TOKENS = new Set([
  "account",
  "autopay",
  "auto",
  "balance",
  "billing",
  "card",
  "charge",
  "dues",
  "fee",
  "fees",
  "invoice",
  "paid",
  "payment",
  "price",
  "subscription",
  "tuition",
]);

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

function normalizeCsvHeader(header: string) {
  return header.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactCsvHeader(header: string) {
  return normalizeCsvHeader(header).replace(/\s+/g, "");
}

function normalizeNameToken(token: string) {
  return token.toLowerCase().replace(/[^a-z]+/g, "");
}

export function getMissingCsvImportRequiredFields(mapping: Record<string, string>) {
  const selectedFields = new Set(Object.values(mapping).filter(Boolean));
  return REQUIRED_IMPORT_FIELDS.filter((field) => {
    if (
      (field === "legal_first_name" || field === "legal_last_name") &&
      selectedFields.has("full_name")
    ) {
      return false;
    }

    return !selectedFields.has(field);
  });
}

export function splitCsvImportFullName(rawValue: unknown): { firstName: string; lastName: string } {
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

export function isSkippedBillingImportHeader(header: string) {
  const tokens = new Set(normalizeCsvHeader(header).split(/\s+/).filter(Boolean));
  const compact = compactCsvHeader(header);

  return Array.from(BILLING_IMPORT_TOKENS).some((token) => tokens.has(token) || compact.includes(token));
}

export function getSkippedBillingImportHeaders(headers: string[], mapping: Record<string, string>) {
  return headers.filter((header) => !mapping[header] && isSkippedBillingImportHeader(header));
}
