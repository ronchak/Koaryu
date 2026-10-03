export function studentBirthDateError(
  dateOfBirth: string | null | undefined,
  businessDate?: string,
): string | undefined {
  if (!dateOfBirth) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return "Enter a valid date of birth.";
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "Enter a valid date of birth.";
  }
  if (businessDate && dateOfBirth > businessDate) {
    return "Date of birth cannot be in the future.";
  }
  return undefined;
}

export function assertStudentBirthDate(
  dateOfBirth: string | null | undefined,
  businessDate: string,
) {
  const error = studentBirthDateError(dateOfBirth, businessDate);
  if (error) throw new Error(error);
}

// Match the supported CSV date formats without parsing them in the browser timezone.
export function parseStudentImportBirthDate(value: string): string | null {
  const trimmed = value.trim();
  const key = (year: number, month: number, day: number) =>
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  for (const candidate of [trimmed, trimmed.split(/[T ]/, 1)[0]]) {
    let parsed: string | undefined;
    let match: RegExpExecArray | null;
    if (/^\d{5}(?:\.0+)?$/.test(candidate)) {
      const serial = Number(candidate);
      if (serial >= 10000 && serial <= 60000) {
        parsed = new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
      }
    } else if ((match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(candidate))) {
      parsed = key(Number(match[1]), Number(match[2]), Number(match[3]));
    } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(candidate))) {
      let year = Number(match[3]);
      if (match[3].length === 2) year += year <= 68 ? 2000 : 1900;
      parsed = key(year, Number(match[1]), Number(match[2]));
    } else if ((match = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(candidate))) {
      const month = months.findIndex(
        (name) => name === match![1].toLowerCase() || name.slice(0, 3) === match![1].toLowerCase(),
      );
      if (month >= 0) parsed = key(Number(match[3]), month + 1, Number(match[2]));
    }
    if (parsed && !studentBirthDateError(parsed)) return parsed;
  }
  return null;
}
