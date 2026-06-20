import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyLeadUpdate,
  buildPreviewLead,
  buildPreviewLeadConversion,
} from "../src/lib/lead-store-model.ts";

function idFactory(ids) {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function lead(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    first_name: "Kai",
    last_name: "Nguyen",
    source: "walk_in",
    stage: "inquiry",
    is_minor: false,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function program(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    color_hex: "#38BDF8",
    sort_order: 0,
    is_system: false,
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

describe("lead store model", () => {
  it("builds preview leads with the same defaults as the store preview mode", () => {
    const built = buildPreviewLead(
      {
        first_name: "Ari",
        last_name: "Stone",
        email: "ari@example.test",
        is_minor: true,
        guardian_name: "Dana Stone",
        stage: "offer_sent",
      },
      {
        idFactory: idFactory(["lead-1"]),
        now: new Date("2026-05-24T12:00:00.000Z"),
      }
    );

    assert.deepEqual(
      {
        id: built.id,
        studio_id: built.studio_id,
        first_name: built.first_name,
        last_name: built.last_name,
        source: built.source,
        stage: built.stage,
        is_minor: built.is_minor,
        guardian_name: built.guardian_name,
        created_at: built.created_at,
        updated_at: built.updated_at,
      },
      {
        id: "lead-1",
        studio_id: "mock-studio",
        first_name: "Ari",
        last_name: "Stone",
        source: "walk_in",
        stage: "inquiry",
        is_minor: true,
        guardian_name: "Dana Stone",
        created_at: "2026-05-24T12:00:00.000Z",
        updated_at: "2026-05-24T12:00:00.000Z",
      }
    );
  });

  it("applies preview lead updates without touching unrelated leads", () => {
    const leads = [
      lead("lead-1", { stage: "inquiry" }),
      lead("lead-2", { stage: "trial_scheduled" }),
    ];

    const updated = applyLeadUpdate(
      leads,
      "lead-2",
      { stage: "closed_lost", notes: "Not ready" },
      "2026-05-24T12:00:00.000Z"
    );

    assert.deepEqual(updated.map((item) => [item.id, item.stage, item.notes, item.updated_at]), [
      ["lead-1", "inquiry", undefined, "2026-05-01T00:00:00.000Z"],
      ["lead-2", "closed_lost", "Not ready", "2026-05-24T12:00:00.000Z"],
    ]);
  });

  it("converts preview leads into active students with membership and guardian ownership", () => {
    const conversion = buildPreviewLeadConversion(
      lead("lead-1", {
        first_name: "Milo",
        last_name: "Rivera",
        email: "milo@example.test",
        phone: "555-0100",
        program_id: "kids",
        is_minor: true,
        guardian_name: "Sofia Rivera Cruz",
        guardian_email: "sofia@example.test",
        notes: "Trial completed",
      }),
      [program("kids", { name: "Kids BJJ", color_hex: "#F59E0B" })],
      {
        idFactory: idFactory(["student-1", "membership-1", "guardian-1"]),
        now: new Date("2026-05-24T12:00:00.000Z"),
      }
    );

    assert.equal(conversion.studentId, "student-1");
    assert.deepEqual(
      [
        conversion.lead.stage,
        conversion.lead.converted_student_id,
        conversion.lead.updated_at,
      ],
      ["enrolled", "student-1", "2026-05-24T12:00:00.000Z"]
    );
    assert.deepEqual(
      {
        id: conversion.student.id,
        legal_first_name: conversion.student.legal_first_name,
        legal_last_name: conversion.student.legal_last_name,
        email: conversion.student.email,
        phone: conversion.student.phone,
        status: conversion.student.status,
        membership_start_date: conversion.student.membership_start_date,
        program_id: conversion.student.program_id,
        notes: conversion.student.notes,
        tags: conversion.student.tags,
      },
      {
        id: "student-1",
        legal_first_name: "Milo",
        legal_last_name: "Rivera",
        email: "milo@example.test",
        phone: "555-0100",
        status: "active",
        membership_start_date: "2026-05-24",
        program_id: "kids",
        notes: "Trial completed",
        tags: ["converted-lead"],
      }
    );
    assert.deepEqual(
      conversion.student.program_memberships?.map((membership) => [
        membership.id,
        membership.student_id,
        membership.program_id,
        membership.program_name,
        membership.program_color_hex,
        membership.current_belt_rank_id,
      ]),
      [["membership-1", "student-1", "kids", "Kids BJJ", "#F59E0B", null]]
    );
    assert.deepEqual(
      conversion.student.guardians.map((guardian) => [
        guardian.id,
        guardian.first_name,
        guardian.last_name,
        guardian.email,
        guardian.is_primary_contact,
      ]),
      [["guardian-1", "Sofia", "Rivera Cruz", "sofia@example.test", true]]
    );
  });
});
