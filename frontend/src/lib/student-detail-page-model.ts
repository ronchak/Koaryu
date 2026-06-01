import type { StudentRankWithContext } from "@/components/students/student-rank-badge";
import type { StudentFormInitialData } from "@/components/students/student-form-state";
import type { BeltLadder, BeltRank, Promotion, Student } from "@/types";

export const STUDENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const STUDENT_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateStudentPhotoFile(
  file: Pick<File, "size" | "type">,
  options = {
    allowedTypes: STUDENT_PHOTO_TYPES,
    maxBytes: STUDENT_PHOTO_MAX_BYTES,
  }
) {
  if (!options.allowedTypes.has(file.type)) {
    return "Choose a JPG, PNG, or WebP image.";
  }

  if (file.size > options.maxBytes) {
    return "Choose an image under 5 MB.";
  }

  return null;
}

export function isStudentCurrentHold(
  student: Pick<Student, "status" | "hold_start_date" | "hold_end_date">,
  today: string
) {
  if (student.status === "paused") {
    return true;
  }

  if (!student.hold_start_date || student.hold_start_date > today) {
    return false;
  }

  if (!student.hold_end_date) {
    return true;
  }

  return student.hold_end_date >= today;
}

export function buildStudentRankById(beltLadders: BeltLadder[]) {
  const entries = beltLadders.flatMap((ladder) =>
    ladder.ranks.map((rank) => [
      rank.id,
      { ...rank, ladderName: ladder.name } satisfies StudentRankWithContext,
    ] as const)
  );
  return new Map<string, StudentRankWithContext>(entries);
}

export function getActiveStudentProgramIds(student: Student) {
  const activeMemberships = (student.program_memberships || []).filter(
    (membership) => membership.status !== "ended" && !membership.ended_at
  );

  if (activeMemberships.length > 0) {
    return activeMemberships.map((membership) => membership.program_id);
  }

  return student.program_id ? [student.program_id] : [];
}

export function buildStudentEditInitialData(
  student: Student,
  activeProgramIds: string[]
): StudentFormInitialData {
  return {
    legal_first_name: student.legal_first_name,
    legal_last_name: student.legal_last_name,
    preferred_name: student.preferred_name,
    date_of_birth: student.date_of_birth,
    email: student.email,
    phone: student.phone,
    address_line1: student.address_line1,
    address_city: student.address_city,
    address_state: student.address_state,
    address_zip: student.address_zip,
    emergency_contact_name: student.emergency_contact_name,
    emergency_contact_phone: student.emergency_contact_phone,
    emergency_contact_relation: student.emergency_contact_relation,
    status: student.status,
    membership_start_date: student.membership_start_date,
    hold_start_date: student.hold_start_date,
    hold_end_date: student.hold_end_date,
    notes: student.notes,
    tags: student.tags,
    program_id: student.program_id,
    program_ids: activeProgramIds,
    current_belt_rank_id: student.current_belt_rank_id,
    guardians: student.guardians.map((guardian) => ({
      first_name: guardian.first_name,
      last_name: guardian.last_name,
      email: guardian.email,
      phone: guardian.phone,
      relation: guardian.relation,
      is_primary_contact: guardian.is_primary_contact,
    })),
  };
}

type StudentDetailModelInput = {
  beltLadders: BeltLadder[];
  promotionHistory: Promotion[];
  student: Student;
  today: string;
};

export function buildStudentDetailModel({
  beltLadders,
  promotionHistory,
  student,
  today,
}: StudentDetailModelInput) {
  const fullName = `${student.preferred_name || student.legal_first_name} ${student.legal_last_name}`;
  const primaryGuardian = student.guardians.find((guardian) => guardian.is_primary_contact) ?? student.guardians[0];
  const rankById = buildStudentRankById(beltLadders);
  const currentRank = student.current_belt_rank_id
    ? rankById.get(student.current_belt_rank_id)
    : undefined;
  const currentLadder = currentRank
    ? beltLadders.find((ladder) => ladder.id === currentRank.ladder_id)
    : beltLadders.find((ladder) => ladder.program_id && ladder.program_id === student.program_id);
  const currentLadderRanks: BeltRank[] = currentLadder?.ranks || [];
  const activeProgramIds = getActiveStudentProgramIds(student);
  const currentRankIndex = currentRank
    ? currentLadderRanks.findIndex((rank) => rank.id === currentRank.id)
    : -1;
  const nextRank =
    currentRankIndex >= 0 && currentRankIndex < currentLadderRanks.length - 1
      ? currentLadderRanks[currentRankIndex + 1]
      : undefined;

  return {
    activeProgramIds,
    currentRank,
    editInitialData: buildStudentEditInitialData(student, activeProgramIds),
    fullName,
    isCurrentHold: isStudentCurrentHold(student, today),
    latestPromotion: promotionHistory[0],
    nextRank,
    primaryGuardian,
    rankById,
  };
}
