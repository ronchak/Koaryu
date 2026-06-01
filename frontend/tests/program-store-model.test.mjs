import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyPreviewProgramArchiveState,
  applyPreviewProgramUpdate,
  applyProgramNameToLadders,
  buildPreviewProgram,
  buildPreviewProgramLadder,
  sortPrograms,
  upsertProgram,
} from "../src/lib/program-store-model.ts";

function program(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    color_hex: "#38BDF8",
    sort_order: 0,
    is_system: false,
    archived_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    usage: {
      student_count: 0,
      active_student_count: 0,
      class_count: 0,
      active_class_count: 0,
      lead_count: 0,
      belt_ladder_count: 0,
    },
    ...overrides,
  };
}

function ladder(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    sub_rank_term: "Stripe",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ranks: [],
    ...overrides,
  };
}

function idFactory(ids) {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

describe("program store model", () => {
  it("sorts and upserts programs with existing store ordering rules", () => {
    const sorted = sortPrograms([
      program("b", { name: "Beta", sort_order: 20 }),
      program("a", { name: "Alpha", sort_order: 10 }),
      program("c", { name: "Aardvark", sort_order: 20 }),
    ]);
    assert.deepEqual(sorted.map((item) => item.id), ["a", "c", "b"]);

    assert.deepEqual(
      upsertProgram([program("a"), program("b")], program("a", { name: "Updated" }))
        .map((item) => [item.id, item.name]),
      [
        ["b", "b"],
        ["a", "Updated"],
      ]
    );
  });

  it("builds preview programs and their default ladder", () => {
    const now = new Date("2026-05-24T12:00:00.000Z");
    const created = buildPreviewProgram(
      { name: "Kids BJJ", description: "Youth classes" },
      [program("existing-1"), program("existing-2")],
      { idFactory: idFactory(["program-1"]), now }
    );
    const createdWithOverrides = buildPreviewProgram(
      { name: "Adults", color_hex: "#111111", sort_order: 5 },
      [],
      { idFactory: idFactory(["program-2"]), now }
    );
    const ladderForProgram = buildPreviewProgramLadder(created, {
      idFactory: idFactory(["ladder-1"]),
      now,
    });

    assert.deepEqual(
      {
        id: created.id,
        studio_id: created.studio_id,
        name: created.name,
        description: created.description,
        color_hex: created.color_hex,
        sort_order: created.sort_order,
        is_system: created.is_system,
        archived_at: created.archived_at,
        created_at: created.created_at,
        usage: created.usage,
      },
      {
        id: "program-1",
        studio_id: "mock-studio",
        name: "Kids BJJ",
        description: "Youth classes",
        color_hex: "#64748B",
        sort_order: 20,
        is_system: false,
        archived_at: null,
        created_at: "2026-05-24T12:00:00.000Z",
        usage: {
          student_count: 0,
          active_student_count: 0,
          class_count: 0,
          active_class_count: 0,
          lead_count: 0,
          belt_ladder_count: 1,
        },
      }
    );
    assert.deepEqual([createdWithOverrides.color_hex, createdWithOverrides.sort_order], ["#111111", 5]);
    assert.deepEqual(
      [ladderForProgram.id, ladderForProgram.program_id, ladderForProgram.name, ladderForProgram.sub_rank_term],
      ["ladder-1", "program-1", "Kids BJJ", "Stripe"]
    );
  });

  it("applies preview updates and keeps ladder names coupled to renamed programs", () => {
    const programs = [program("program-1", { name: "Old" }), program("program-2", { name: "Other" })];
    const update = applyPreviewProgramUpdate(
      programs,
      "program-1",
      { name: "New", description: null },
      "2026-05-24T12:00:00.000Z"
    );

    assert.deepEqual(update.programs.map((item) => [item.id, item.name, item.description, item.updated_at]), [
      ["program-1", "New", null, "2026-05-24T12:00:00.000Z"],
      ["program-2", "Other", undefined, "2026-05-01T00:00:00.000Z"],
    ]);
    assert.equal(update.updated?.name, "New");

    const ladders = applyProgramNameToLadders(
      [
        ladder("ladder-1", { program_id: "program-1", name: "Old" }),
        ladder("ladder-2", { program_id: "program-2", name: "Other" }),
      ],
      "program-1",
      "New",
      "2026-05-24T12:00:00.000Z"
    );
    assert.deepEqual(ladders.map((item) => [item.id, item.name, item.updated_at]), [
      ["ladder-1", "New", "2026-05-24T12:00:00.000Z"],
      ["ladder-2", "Other", "2026-05-01T00:00:00.000Z"],
    ]);
  });

  it("applies preview archive and restore state", () => {
    const archived = applyPreviewProgramArchiveState(
      [program("program-1")],
      "program-1",
      true,
      "2026-05-24T12:00:00.000Z"
    );
    assert.deepEqual(
      [archived.updated?.archived_at, archived.updated?.updated_at],
      ["2026-05-24T12:00:00.000Z", "2026-05-24T12:00:00.000Z"]
    );

    const restored = applyPreviewProgramArchiveState(
      archived.programs,
      "program-1",
      false,
      "2026-05-25T12:00:00.000Z"
    );
    assert.deepEqual(
      [restored.updated?.archived_at, restored.updated?.updated_at],
      [null, "2026-05-25T12:00:00.000Z"]
    );
  });
});
