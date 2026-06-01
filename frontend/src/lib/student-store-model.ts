import type { Program, Student, StudentCreate, StudentStatus } from "@/types";

const MINOR_AGE_MS = 18 * 365.25 * 24 * 60 * 60 * 1000;

export function normalizeStudentIds(studentIds: string[]): string[] {
  return Array.from(
    new Set(studentIds.map((studentId) => studentId.trim()).filter(Boolean))
  );
}

export function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

export function applyAddedTagsToStudents(
  studentList: Student[],
  studentIds: string[],
  tagsToAdd: string[],
  nowIso = new Date().toISOString()
): Student[] {
  const studentIdSet = new Set(studentIds);

  return studentList.map((student) => {
    if (!studentIdSet.has(student.id)) {
      return student;
    }

    return {
      ...student,
      tags: Array.from(new Set([...(student.tags || []), ...tagsToAdd])),
      updated_at: nowIso,
    };
  });
}

export function applyStatusToStudents(
  studentList: Student[],
  studentIds: string[],
  status: StudentStatus,
  nowIso = new Date().toISOString()
): Student[] {
  const studentIdSet = new Set(studentIds);

  return studentList.map((student) => {
    if (!studentIdSet.has(student.id)) {
      return student;
    }

    return {
      ...student,
      status,
      updated_at: nowIso,
    };
  });
}

export function buildPreviewStudent(
  data: StudentCreate,
  programs: Program[],
  {
    idFactory,
    now = new Date(),
    nowMs = Date.now(),
  }: {
    idFactory: () => string;
    now?: Date;
    nowMs?: number;
  }
): Student {
  const selectedProgramIds = data.program_ids?.length
    ? data.program_ids
    : data.program_id
      ? [data.program_id]
      : ["program-unassigned"];
  const nowIso = now.toISOString();
  const membershipStart = data.membership_start_date || nowIso.split("T")[0];
  const newStudent: Student = {
    id: idFactory(),
    studio_id: "mock-studio",
    legal_first_name: data.legal_first_name,
    legal_last_name: data.legal_last_name,
    preferred_name: data.preferred_name,
    date_of_birth: data.date_of_birth,
    is_minor: data.date_of_birth
      ? nowMs - new Date(data.date_of_birth).getTime() < MINOR_AGE_MS
      : false,
    hold_start_date: data.hold_start_date,
    hold_end_date: data.hold_end_date,
    email: data.email,
    phone: data.phone,
    address_line1: data.address_line1,
    address_city: data.address_city,
    address_state: data.address_state,
    address_zip: data.address_zip,
    emergency_contact_name: data.emergency_contact_name,
    emergency_contact_phone: data.emergency_contact_phone,
    emergency_contact_relation: data.emergency_contact_relation,
    status: (data.status as StudentStatus) || "active",
    membership_start_date: membershipStart,
    program_id: selectedProgramIds[0],
    current_belt_rank_id: data.current_belt_rank_id,
    notes: data.notes,
    tags: data.tags || [],
    guardians: (data.guardians || []).map((guardian, index) => ({
      id: idFactory(),
      first_name: guardian.first_name,
      last_name: guardian.last_name,
      email: guardian.email,
      phone: guardian.phone,
      relation: guardian.relation,
      is_primary_contact: guardian.is_primary_contact ?? index === 0,
    })),
    program_memberships: selectedProgramIds.map((programId) => {
      const program = programs.find((item) => item.id === programId);
      return {
        id: idFactory(),
        studio_id: "mock-studio",
        student_id: "preview-pending",
        program_id: programId,
        program_name: program?.name,
        program_color_hex: program?.color_hex,
        status: "active" as const,
        started_at: membershipStart,
        ended_at: null,
        current_belt_rank_id: programId === selectedProgramIds[0] ? data.current_belt_rank_id : undefined,
        created_at: nowIso,
        updated_at: nowIso,
      };
    }),
    created_at: nowIso,
    updated_at: nowIso,
  };

  newStudent.program_memberships = (newStudent.program_memberships ?? []).map((membership) => ({
    ...membership,
    student_id: newStudent.id,
  }));

  return newStudent;
}
