"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { GuardianCreate, StudentCreate, StudentStatus, StudentUpdate } from "@/types";

export type StudentFormTab = "info" | "contact" | "guardian";

export const studentFormTabs: { id: StudentFormTab; label: string }[] = [
  { id: "info", label: "Basic Info" },
  { id: "contact", label: "Contact" },
  { id: "guardian", label: "Guardian" },
];

export interface StudentFormFields {
  legalFirst: string;
  legalLast: string;
  preferredName: string;
  dob: string;
  holdStart: string;
  holdEnd: string;
  status: StudentStatus;
  membershipStart: string;
  programIds: string[];
  notes: string;
  tags: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  guardianFirst: string;
  guardianLast: string;
  guardianEmail: string;
  guardianPhone: string;
  guardianRelation: string;
}

export type StudentFormInitialData = Partial<StudentUpdate> & {
  current_belt_rank_id?: string | null;
  guardians?: GuardianCreate[];
  program_id?: string | null;
  program_ids?: string[] | null;
};

interface StudentFormValidation {
  message: string;
  tab: StudentFormTab;
}

function textOrUndefined(value: string): string | undefined {
  return value.trim() || undefined;
}

function textOrNull(value: string): string | null {
  return value.trim() || null;
}

function parseTags(value: string): string[] {
  return value
    ? value.split(",").map((tag) => tag.trim()).filter(Boolean)
    : [];
}

export function buildInitialStudentFormFields(initialData?: StudentFormInitialData): StudentFormFields {
  const guardian = initialData?.guardians?.[0];

  return {
    legalFirst: initialData?.legal_first_name || "",
    legalLast: initialData?.legal_last_name || "",
    preferredName: initialData?.preferred_name || "",
    dob: initialData?.date_of_birth || "",
    holdStart: initialData?.hold_start_date || "",
    holdEnd: initialData?.hold_end_date || "",
    status: initialData?.status || "active",
    membershipStart: initialData?.membership_start_date || "",
    programIds: initialData?.program_ids?.length
      ? initialData.program_ids
      : initialData?.program_id
        ? [initialData.program_id]
        : [],
    notes: initialData?.notes || "",
    tags: initialData?.tags?.join(", ") || "",
    email: initialData?.email || "",
    phone: initialData?.phone || "",
    addressLine1: initialData?.address_line1 || "",
    city: initialData?.address_city || "",
    state: initialData?.address_state || "",
    zip: initialData?.address_zip || "",
    emergencyName: initialData?.emergency_contact_name || "",
    emergencyPhone: initialData?.emergency_contact_phone || "",
    emergencyRelation: initialData?.emergency_contact_relation || "",
    guardianFirst: guardian?.first_name || "",
    guardianLast: guardian?.last_name || "",
    guardianEmail: guardian?.email || "",
    guardianPhone: guardian?.phone || "",
    guardianRelation: guardian?.relation || "",
  };
}

export function validateStudentFormFields(
  fields: StudentFormFields,
  options?: { includeLifecycleFields?: boolean }
): StudentFormValidation | null {
  if (!fields.legalFirst.trim() || !fields.legalLast.trim()) {
    return { message: "First name and last name are required.", tab: "info" };
  }

  if (options?.includeLifecycleFields !== false && fields.holdEnd && !fields.holdStart) {
    return { message: "Add a hold start date before setting a hold end date.", tab: "info" };
  }

  if (
    options?.includeLifecycleFields !== false
    && fields.holdStart
    && fields.holdEnd
    && fields.holdEnd < fields.holdStart
  ) {
    return { message: "Hold end date cannot be before the hold start date.", tab: "info" };
  }

  return null;
}

export function buildStudentCreatePayload(
  fields: StudentFormFields,
  initialData?: StudentFormInitialData
): StudentCreate {
  return {
    legal_first_name: fields.legalFirst.trim(),
    legal_last_name: fields.legalLast.trim(),
    preferred_name: textOrUndefined(fields.preferredName),
    date_of_birth: fields.dob || undefined,
    hold_start_date: fields.holdStart || undefined,
    hold_end_date: fields.holdEnd || undefined,
    status: fields.status,
    membership_start_date: fields.membershipStart || undefined,
    program_id: fields.programIds[0],
    program_ids: fields.programIds,
    current_belt_rank_id: initialData?.current_belt_rank_id,
    notes: textOrUndefined(fields.notes),
    tags: parseTags(fields.tags),
    email: textOrUndefined(fields.email),
    phone: textOrUndefined(fields.phone),
    address_line1: textOrUndefined(fields.addressLine1),
    address_city: textOrUndefined(fields.city),
    address_state: textOrUndefined(fields.state),
    address_zip: textOrUndefined(fields.zip),
    emergency_contact_name: textOrUndefined(fields.emergencyName),
    emergency_contact_phone: textOrUndefined(fields.emergencyPhone),
    emergency_contact_relation: textOrUndefined(fields.emergencyRelation),
    guardians:
      fields.guardianFirst.trim()
        ? [
            {
              first_name: fields.guardianFirst.trim(),
              last_name: fields.guardianLast.trim(),
              email: textOrUndefined(fields.guardianEmail),
              phone: textOrUndefined(fields.guardianPhone),
              relation: textOrUndefined(fields.guardianRelation),
              is_primary_contact: true,
            },
          ]
        : [],
  };
}

export function buildStudentUpdatePayload(
  fields: StudentFormFields,
  initialData?: StudentFormInitialData,
  options?: { includeLifecycleFields?: boolean }
): StudentUpdate {
  const payload: StudentUpdate = {
    legal_first_name: fields.legalFirst.trim(),
    legal_last_name: fields.legalLast.trim(),
    preferred_name: textOrNull(fields.preferredName),
    date_of_birth: fields.dob || null,
    email: textOrNull(fields.email),
    phone: textOrNull(fields.phone),
    address_line1: textOrNull(fields.addressLine1),
    address_city: textOrNull(fields.city),
    address_state: textOrNull(fields.state),
    address_zip: textOrNull(fields.zip),
    emergency_contact_name: textOrNull(fields.emergencyName),
    emergency_contact_phone: textOrNull(fields.emergencyPhone),
    emergency_contact_relation: textOrNull(fields.emergencyRelation),
    notes: textOrNull(fields.notes),
    tags: parseTags(fields.tags),
  };

  if (options?.includeLifecycleFields !== false) {
    payload.hold_start_date = fields.holdStart || null;
    payload.hold_end_date = fields.holdEnd || null;
    payload.status = fields.status;
    payload.membership_start_date = fields.membershipStart || null;
    payload.program_id = fields.programIds[0] || null;
    payload.program_ids = fields.programIds;
    payload.current_belt_rank_id = initialData?.current_belt_rank_id ?? null;
  }

  return payload;
}

export function buildStudentFormSubmitPayload(
  fields: StudentFormFields,
  initialData?: StudentFormInitialData,
  options?: { includeLifecycleFields?: boolean }
): StudentCreate | StudentUpdate {
  return initialData
    ? buildStudentUpdatePayload(fields, initialData, options)
    : buildStudentCreatePayload(fields);
}

type UseStudentFormStateOptions =
  {
    initialData?: StudentFormInitialData;
    includeLifecycleFields?: boolean;
    onSubmit: (data: StudentCreate | StudentUpdate) => Promise<void> | void;
  };

export function useStudentFormState(options: UseStudentFormStateOptions) {
  const [tab, setTab] = useState<StudentFormTab>("info");
  const [error, setError] = useState("");
  const initialData = options.initialData;
  const [fields, setFields] = useState(() => buildInitialStudentFormFields(initialData));

  const setField = useCallback(<Field extends keyof StudentFormFields>(
    field: Field,
    value: StudentFormFields[Field]
  ) => {
    setFields((current) => ({ ...current, [field]: value }));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const validation = validateStudentFormFields(fields, {
      includeLifecycleFields: options.includeLifecycleFields,
    });
    if (validation) {
      setError(validation.message);
      setTab(validation.tab);
      return;
    }

    try {
      await options.onSubmit(buildStudentFormSubmitPayload(fields, initialData, {
        includeLifecycleFields: options.includeLifecycleFields,
      }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add student");
    }
  }

  return {
    error,
    fields,
    handleSubmit,
    setField,
    setTab,
    tab,
  };
}
