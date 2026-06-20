import type { BeltLadder, Program, ProgramCreate, ProgramUpdate } from "@/types";

export function sortPrograms(programs: Program[]): Program[] {
  return [...programs].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export function upsertProgram(programs: Program[], nextProgram: Program): Program[] {
  return [...programs.filter((program) => program.id !== nextProgram.id), nextProgram];
}

export function buildPreviewProgram(
  data: ProgramCreate,
  existingPrograms: Program[],
  {
    idFactory,
    now = new Date(),
  }: {
    idFactory: () => string;
    now?: Date;
  }
): Program {
  const nowIso = now.toISOString();

  return {
    id: idFactory(),
    studio_id: "mock-studio",
    name: data.name,
    description: data.description,
    color_hex: data.color_hex || "#64748B",
    sort_order: data.sort_order ?? existingPrograms.length * 10,
    is_system: false,
    archived_at: null,
    created_at: nowIso,
    updated_at: nowIso,
    usage: {
      student_count: 0,
      active_student_count: 0,
      class_count: 0,
      active_class_count: 0,
      lead_count: 0,
      belt_ladder_count: 1,
    },
  };
}

export function buildPreviewProgramLadder(
  program: Program,
  {
    idFactory,
    now = new Date(),
  }: {
    idFactory: () => string;
    now?: Date;
  }
): BeltLadder {
  const nowIso = now.toISOString();

  return {
    id: idFactory(),
    studio_id: "mock-studio",
    name: program.name,
    program_id: program.id,
    sub_rank_term: "Stripe",
    created_at: nowIso,
    updated_at: nowIso,
    ranks: [],
  };
}

export function applyPreviewProgramUpdate(
  programs: Program[],
  id: string,
  data: ProgramUpdate,
  nowIso = new Date().toISOString()
): { programs: Program[]; updated: Program | null } {
  let updated: Program | null = null;
  const nextPrograms = programs.map((program) => {
    if (program.id !== id) {
      return program;
    }

    updated = {
      ...program,
      ...data,
      name: data.name ?? program.name,
      color_hex: data.color_hex ?? program.color_hex,
      sort_order: data.sort_order ?? program.sort_order,
      updated_at: nowIso,
    };
    return updated;
  });

  return { programs: nextPrograms, updated };
}

export function applyProgramNameToLadders(
  ladders: BeltLadder[],
  programId: string,
  name?: string,
  nowIso = new Date().toISOString()
): BeltLadder[] {
  if (!name) {
    return ladders;
  }

  return ladders.map((ladder) =>
    ladder.program_id === programId
      ? { ...ladder, name, updated_at: nowIso }
      : ladder
  );
}

export function applyPreviewProgramArchiveState(
  programs: Program[],
  id: string,
  archived: boolean,
  nowIso = new Date().toISOString()
): { programs: Program[]; updated: Program | null } {
  let updated: Program | null = null;
  const nextPrograms = programs.map((program) => {
    if (program.id !== id) {
      return program;
    }

    updated = {
      ...program,
      archived_at: archived ? nowIso : null,
      updated_at: nowIso,
    };
    return updated;
  });

  return { programs: nextPrograms, updated };
}
