import type { Student } from "@/types";

function calendarParts(value: string): [number, number, number] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(0, 0, 0, 0);
  return year > 0 &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? [year, month, day]
    : null;
}

export function calendarAge(dateOfBirth: string | null | undefined, referenceDate: string) {
  if (!dateOfBirth) return null;
  const birth = calendarParts(dateOfBirth);
  const reference = calendarParts(referenceDate);
  if (!birth || !reference || dateOfBirth > referenceDate) return null;

  const [birthYear, birthMonth, birthDay] = birth;
  const [referenceYear, referenceMonth, referenceDay] = reference;
  const birthdayHasPassed =
    referenceMonth > birthMonth || (referenceMonth === birthMonth && referenceDay >= birthDay);
  return referenceYear - birthYear - (birthdayHasPassed ? 0 : 1);
}

export function isMinorOnDate(dateOfBirth: string | null | undefined, referenceDate: string) {
  const age = calendarAge(dateOfBirth, referenceDate);
  return age !== null && age < 18;
}

export function withCurrentMinorStatus(student: Student, referenceDate: string): Student {
  return {
    ...student,
    // A DOB determines current age. Without it, keep explicit saved knowledge.
    is_minor: student.date_of_birth
      ? isMinorOnDate(student.date_of_birth, referenceDate)
      : Boolean(student.is_minor),
  };
}
