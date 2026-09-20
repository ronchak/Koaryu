import type { Student } from "@/types";

function calendarParts(value: string): [number, number, number] | null {
  const [year, month, day] = value.split("-").map(Number);
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    ? [year, month, day]
    : null;
}

export function calendarAge(dateOfBirth: string | null | undefined, referenceDate: string) {
  if (!dateOfBirth) return null;
  const birth = calendarParts(dateOfBirth);
  const reference = calendarParts(referenceDate);
  if (!birth || !reference) return null;

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
    is_minor: isMinorOnDate(student.date_of_birth, referenceDate),
  };
}
