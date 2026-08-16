export interface LegalNameDraft {
  firstName: string;
  lastName: string;
}

export interface LegalNameGateInput extends LegalNameDraft {
  staffProfilesAvailable: boolean;
}

export function normalizeLegalName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeLegalNameDraft(draft: LegalNameDraft): LegalNameDraft {
  return {
    firstName: normalizeLegalName(draft.firstName),
    lastName: normalizeLegalName(draft.lastName),
  };
}

export function shouldBlockForLegalName({
  staffProfilesAvailable,
  firstName,
  lastName,
}: LegalNameGateInput): boolean {
  if (staffProfilesAvailable !== true) {
    return false;
  }

  const normalized = normalizeLegalNameDraft({ firstName, lastName });
  return !normalized.firstName || !normalized.lastName;
}
