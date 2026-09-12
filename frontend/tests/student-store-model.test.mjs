import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStudentEditInitialData,
  getActiveStudentProgramIds,
} from "../src/lib/student-detail-page-model.ts";
import {
  buildInitialStudentFormFields,
  buildStudentFormSubmitPayload,
} from "../src/components/students/student-form-state.ts";

import {
  applyAddedTagsToStudents,
  applyPreviewStudentUpdate,
  applyStatusToStudents,
  buildPreviewStudent,
  normalizeStudentIds,
  normalizeTags,
} from "../src/lib/student-store-model.ts";

function program(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    color_hex: "#38BDF8",
    sort_order: 0,
    is_system: false,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    usage: { active_student_count: 0, active_schedule_template_count: 0 },
    ...overrides,
  };
}

function student(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    tags: [],
    guardians: [],
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function idFactory() {
  const ids = ["student-1", "guardian-1", "membership-1", "membership-2"];
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

function rank(id, ladderId, displayOrder, overrides = {}) {
  return {
    id,
    ladder_id: ladderId,
    studio_id: "mock-studio",
    name: id,
    color_hex: "#FFFFFF",
    display_order: displayOrder,
    min_classes: 0,
    min_months: 0,
    requires_approval: false,
    is_tip: false,
    created_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function ladder(id, programId, ranks) {
  return {
    id,
    studio_id: "mock-studio",
    name: id,
    program_id: programId,
    sub_rank_term: "Stripe",
    ranks,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

function retainedStudent() {
  return student("student-1", {
    membership_start_date: "2026-01-10",
    tags: ["keep"],
    program_id: "kids",
    current_belt_rank_id: "kids-blue",
    program_memberships: [
      {
        id: "member-a",
        studio_id: "mock-studio",
        student_id: "student-1",
        program_id: "kids",
        status: "paused",
        started_at: "2026-03-05",
        ended_at: null,
        current_belt_rank_id: "kids-blue",
        created_at: "2026-06-15T00:00:00Z",
      },
      {
        id: "member-b",
        studio_id: "mock-studio",
        student_id: "student-1",
        program_id: "nogi",
        status: "active",
        started_at: "2026-06-12",
        ended_at: null,
        current_belt_rank_id: "nogi-white",
        created_at: "2026-06-15T00:00:00Z",
      },
      {
        id: "member-c",
        studio_id: "mock-studio",
        student_id: "student-1",
        program_id: "unranked",
        status: "paused",
        started_at: null,
        ended_at: null,
        current_belt_rank_id: null,
        created_at: "2026-06-15T00:00:00Z",
      },
    ],
  });
}
const retainedPrograms = [
  program("kids"),
  program("nogi"),
  program("unranked"),
  program("new-program"),
];
const retainedOptions = {
  idFactory: () => {
    throw new Error("A retained membership must not be recreated.");
  },
  now: new Date("2026-09-08T12:00:00Z"),
  beltLadders: [
    ladder("unranked-ladder", "unranked", [rank("available-starting-rank", "unranked-ladder", 0)]),
    ladder("new-ladder", "new-program", [rank("new-white", "new-ladder", 0)]),
  ],
};
const retainedFacts = [
  ["member-a", "kids", "paused", "2026-03-05", null, "kids-blue", "2026-06-15T00:00:00Z"],
  ["member-b", "nogi", "active", "2026-06-12", null, "nogi-white", "2026-06-15T00:00:00Z"],
  ["member-c", "unranked", "paused", null, null, null, "2026-06-15T00:00:00Z"],
];
function membershipFacts(value) {
  return value.program_memberships.map((row) => [
    row.id,
    row.program_id,
    row.status,
    row.started_at,
    row.ended_at,
    row.current_belt_rank_id,
    row.created_at,
  ]);
}

describe("student store model", () => {
  it("normalizes bulk student ids and tags before API/store updates", () => {
    assert.deepEqual(normalizeStudentIds([" s-1 ", "", "s-2", "s-1"]), ["s-1", "s-2"]);
    assert.deepEqual(normalizeTags([" vip ", "trial", "vip", ""]), ["vip", "trial"]);
  });

  it("applies bulk tags and status without mutating unrelated students", () => {
    const students = [
      student("s-1", { tags: ["vip"] }),
      student("s-2", { status: "trialing", tags: ["new"] }),
    ];

    const tagged = applyAddedTagsToStudents(
      students,
      ["s-1"],
      ["vip", "paid"],
      "2026-05-24T00:00:00.000Z",
    );
    assert.deepEqual(
      tagged.map((item) => [item.id, item.tags, item.updated_at]),
      [
        ["s-1", ["vip", "paid"], "2026-05-24T00:00:00.000Z"],
        ["s-2", ["new"], "2026-05-01T00:00:00.000Z"],
      ],
    );

    const updated = applyStatusToStudents(students, ["s-2"], "paused", "2026-05-24T00:00:00.000Z");
    assert.deepEqual(
      updated.map((item) => [item.id, item.status, item.updated_at]),
      [
        ["s-1", "active", "2026-05-01T00:00:00.000Z"],
        ["s-2", "paused", "2026-05-24T00:00:00.000Z"],
      ],
    );
  });

  it("builds preview students with program memberships and guardian ownership", () => {
    const built = buildPreviewStudent(
      {
        legal_first_name: "Kai",
        legal_last_name: "Nguyen",
        preferred_name: "K",
        date_of_birth: "2014-05-24",
        status: "trialing",
        program_ids: ["kids", "nogi"],
        current_belt_rank_id: "white",
        tags: ["lead"],
        guardians: [
          {
            first_name: "Gina",
            last_name: "Nguyen",
            email: "gina@example.test",
          },
        ],
      },
      [
        program("kids", { name: "Kids BJJ" }),
        program("nogi", { name: "No-Gi", color_hex: "#F59E0B" }),
      ],
      {
        beltLadders: [
          ladder("kids-ladder", "kids", [
            rank("kids-tip", "kids-ladder", -1, { is_tip: true }),
            rank("kids-white", "kids-ladder", 0),
          ]),
          ladder("nogi-ladder", "nogi", [rank("nogi-white", "nogi-ladder", 0)]),
        ],
        idFactory: idFactory(),
        now: new Date("2026-05-24T12:00:00.000Z"),
        nowMs: new Date("2026-05-24T12:00:00.000Z").getTime(),
      },
    );

    assert.equal(built.id, "student-1");
    assert.equal(built.is_minor, true);
    assert.equal(built.membership_start_date, "2026-05-24");
    assert.equal(built.program_id, "kids");
    assert.deepEqual(
      built.guardians.map((guardian) => [guardian.id, guardian.is_primary_contact]),
      [["guardian-1", true]],
    );
    assert.deepEqual(
      built.program_memberships?.map((membership) => [
        membership.id,
        membership.student_id,
        membership.program_id,
        membership.program_name,
        membership.current_belt_rank_id,
      ]),
      [
        ["membership-1", "student-1", "kids", "Kids BJJ", "white"],
        ["membership-2", "student-1", "nogi", "No-Gi", "nogi-white"],
      ],
    );
  });

  it("defaults each preview program membership to its first full belt", () => {
    const built = buildPreviewStudent(
      {
        legal_first_name: "Noa",
        legal_last_name: "Kim",
        program_ids: ["kids", "nogi"],
      },
      [program("kids"), program("nogi")],
      {
        beltLadders: [
          ladder("kids-ladder", "kids", [
            rank("kids-tip", "kids-ladder", -1, { is_tip: true }),
            rank("kids-white", "kids-ladder", 2),
          ]),
          ladder("nogi-ladder", "nogi", [rank("nogi-white", "nogi-ladder", 0)]),
        ],
        idFactory: idFactory(),
        now: new Date("2026-05-24T12:00:00.000Z"),
      },
    );

    assert.equal(built.current_belt_rank_id, "kids-white");
    assert.deepEqual(
      built.program_memberships?.map((membership) => membership.current_belt_rank_id),
      ["kids-white", "nogi-white"],
    );
  });

  it("keeps preview program memberships and legacy rank fields in sync on edit", () => {
    const updated = applyPreviewStudentUpdate(
      student("student-1", {
        membership_start_date: "2026-05-01",
        program_id: "kids",
        current_belt_rank_id: "kids-blue",
        program_memberships: [
          {
            id: "kids-membership",
            studio_id: "mock-studio",
            student_id: "student-1",
            program_id: "kids",
            program_name: "Kids BJJ",
            status: "paused",
            started_at: "2026-05-01",
            current_belt_rank_id: "kids-blue",
            created_at: "2026-05-01T00:00:00.000Z",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
        ],
      }),
      { program_ids: ["nogi"] },
      [program("kids", { name: "Kids BJJ" }), program("nogi", { name: "No-Gi" })],
      {
        beltLadders: [
          ladder("kids-ladder", "kids", [rank("kids-white", "kids-ladder", 0)]),
          ladder("nogi-ladder", "nogi", [
            rank("nogi-tip", "nogi-ladder", -1, { is_tip: true }),
            rank("nogi-white", "nogi-ladder", 0),
          ]),
        ],
        idFactory: () => "nogi-membership",
        now: new Date("2026-05-24T12:00:00.000Z"),
      },
    );

    assert.equal(updated.program_id, "nogi");
    assert.equal(updated.current_belt_rank_id, "nogi-white");
    assert.deepEqual(
      updated.program_memberships?.map((membership) => [
        membership.id,
        membership.program_id,
        membership.current_belt_rank_id,
        membership.started_at,
      ]),
      [["nogi-membership", "nogi", "nogi-white", "2026-05-01"]],
    );
  });

  it("preserves retained membership facts through the actual ordinary edit form payload", () => {
    const original = retainedStudent();
    const before = structuredClone(original);
    const initial = buildStudentEditInitialData(original, getActiveStudentProgramIds(original));
    const fields = { ...buildInitialStudentFormFields(initial), legalFirst: "Avery" };
    const payload = buildStudentFormSubmitPayload(fields, initial);
    assert.equal(payload.membership_start_date, "2026-01-10");
    assert.deepEqual(payload.program_ids, ["kids", "nogi", "unranked"]);
    assert.equal(Object.hasOwn(payload, "current_belt_rank_id"), false);
    assert.equal(Object.hasOwn(payload, "guardians"), false);
    const updated = applyPreviewStudentUpdate(original, payload, retainedPrograms, retainedOptions);
    assert.equal(updated.legal_first_name, "Avery");
    assert.deepEqual(membershipFacts(updated), retainedFacts);
    assert.deepEqual(updated.tags, ["keep"]);
    assert.deepEqual(original, before, "editing must not mutate the source student");
  });

  it("preserves omitted and unchanged null dates, ranks and paused status while program selection changes", () => {
    for (const [overallDate, update] of [
      ["2026-01-10", { phone: "555-0100", program_ids: ["kids", "nogi", "unranked"] }],
      [null, { program_ids: ["kids", "nogi", "unranked"] }],
      [null, { membership_start_date: null, program_ids: ["kids", "nogi", "unranked"] }],
    ]) {
      const updated = applyPreviewStudentUpdate(
        { ...retainedStudent(), membership_start_date: overallDate },
        update,
        retainedPrograms,
        retainedOptions,
      );
      assert.equal(updated.membership_start_date, overallDate);
      assert.deepEqual(membershipFacts(updated), retainedFacts);
    }
    const reordered = applyPreviewStudentUpdate(
      retainedStudent(),
      { program_ids: ["nogi", "kids", "unranked"] },
      retainedPrograms,
      retainedOptions,
    );
    assert.deepEqual(membershipFacts(reordered), [
      retainedFacts[1],
      retainedFacts[0],
      retainedFacts[2],
    ]);
    assert.equal(reordered.program_id, "nogi");
    assert.equal(reordered.current_belt_rank_id, "nogi-white");
    const changed = applyPreviewStudentUpdate(
      retainedStudent(),
      { program_ids: ["kids", "unranked", "new-program"] },
      retainedPrograms,
      { ...retainedOptions, idFactory: () => "new-membership" },
    );
    assert.deepEqual(membershipFacts(changed), [
      retainedFacts[0],
      retainedFacts[2],
      [
        "new-membership",
        "new-program",
        "active",
        "2026-01-10",
        null,
        "new-white",
        "2026-09-08T12:00:00.000Z",
      ],
    ]);
  });

  it("keeps program dates independent when the overall joining date changes", () => {
    for (const membership_start_date of ["2026-07-01", null]) {
      for (const program_ids of [undefined, ["kids", "nogi", "unranked"]]) {
        const update = { membership_start_date, ...(program_ids ? { program_ids } : {}) };
        const updated = applyPreviewStudentUpdate(
          retainedStudent(),
          update,
          retainedPrograms,
          retainedOptions,
        );
        assert.equal(updated.membership_start_date, membership_start_date);
        assert.deepEqual(membershipFacts(updated), retainedFacts);
      }
      const updated = applyPreviewStudentUpdate(
        retainedStudent(),
        {
          membership_start_date,
          program_ids: ["kids", "new-program"],
        },
        retainedPrograms,
        { ...retainedOptions, idFactory: () => "new-membership" },
      );
      assert.deepEqual(membershipFacts(updated)[0], retainedFacts[0]);
      assert.equal(updated.program_memberships[1].started_at, membership_start_date);
    }
  });
});
