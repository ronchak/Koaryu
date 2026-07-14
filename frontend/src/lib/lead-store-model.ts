import type { Lead, LeadSource, Program, Student } from "@/types";

export function buildPreviewLead(
  data: Partial<Lead>,
  {
    idFactory,
    now = new Date(),
  }: {
    idFactory: () => string;
    now?: Date;
  }
): Lead {
  const nowIso = now.toISOString();

  return {
    id: idFactory(),
    studio_id: "mock-studio",
    first_name: data.first_name || "",
    last_name: data.last_name || "",
    email: data.email,
    phone: data.phone,
    source: (data.source as LeadSource) || "walk_in",
    stage: "inquiry",
    program_interest: data.program_interest,
    program_id: data.program_id,
    is_minor: data.is_minor || false,
    guardian_name: data.guardian_name,
    guardian_email: data.guardian_email,
    guardian_phone: data.guardian_phone,
    follow_up_date: data.follow_up_date,
    notes: data.notes,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export function applyLeadUpdate(
  leads: Lead[],
  id: string,
  data: Partial<Lead>,
  nowIso = new Date().toISOString()
): Lead[] {
  return leads.map((lead) =>
    lead.id === id
      ? {
          ...lead,
          ...data,
          updated_at: nowIso,
        }
      : lead
  );
}

function splitGuardianName(name: string): { firstName: string; lastName: string } {
  const parts = name.split(" ");
  return {
    firstName: parts[0] || name,
    lastName: parts.slice(1).join(" "),
  };
}

export function buildPreviewLeadConversion(
  lead: Lead,
  programs: Program[],
  {
    idFactory,
    now = new Date(),
  }: {
    idFactory: () => string;
    now?: Date;
  }
): { lead: Lead; student: Student; studentId: string } {
  const studentId = idFactory();
  const nowIso = now.toISOString();
  const membershipStartDate = nowIso.split("T")[0];
  const selectedProgramId = lead.program_id || "program-unassigned";
  const selectedProgram = programs.find((program) => program.id === selectedProgramId);
  const guardianName = lead.guardian_name ? splitGuardianName(lead.guardian_name) : null;

  const student: Student = {
    id: studentId,
    studio_id: "mock-studio",
    legal_first_name: lead.first_name,
    legal_last_name: lead.last_name,
    preferred_name: undefined,
    date_of_birth: undefined,
    is_minor: lead.is_minor,
    hold_start_date: undefined,
    hold_end_date: undefined,
    email: lead.email,
    phone: lead.phone,
    address_line1: undefined,
    address_city: undefined,
    address_state: undefined,
    address_zip: undefined,
    emergency_contact_name: undefined,
    emergency_contact_phone: undefined,
    emergency_contact_relation: undefined,
    status: "active",
    membership_start_date: membershipStartDate,
    program_id: selectedProgramId,
    current_belt_rank_id: undefined,
    program_memberships: [
      {
        id: idFactory(),
        studio_id: "mock-studio",
        student_id: studentId,
        program_id: selectedProgramId,
        program_name: selectedProgram?.name,
        program_color_hex: selectedProgram?.color_hex,
        status: "active",
        started_at: membershipStartDate,
        ended_at: null,
        current_belt_rank_id: null,
        current_belt_rank_name: null,
        current_belt_rank_color: null,
        created_at: nowIso,
        updated_at: nowIso,
      },
    ],
    notes: lead.notes,
    tags: ["converted-lead"],
    guardians: lead.is_minor && guardianName
      ? [
          {
            id: idFactory(),
            first_name: guardianName.firstName,
            last_name: guardianName.lastName,
            email: lead.guardian_email,
            phone: lead.guardian_phone,
            relation: undefined,
            is_primary_contact: true,
          },
        ]
      : [],
    created_at: nowIso,
    updated_at: nowIso,
  };

  return {
    student,
    lead: {
      ...lead,
      stage: "enrolled",
      converted_student_id: studentId,
      updated_at: nowIso,
    },
    studentId,
  };
}
