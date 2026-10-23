import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areCsvImportKeyInputsEqual,
  areCsvImportValidationInputsEqual,
  buildStableImportKey,
  formatCsvImportFileSizeLimit,
  resolvePreviewImportBeltRankId,
  resolvePreviewImportProgramId,
  resolvePreviewImportStudentIds,
  withCsvImportRefreshWarning,
} from "../src/lib/csv-import.ts";

const previewPrograms = [
  { id: "program-bjj-core", name: "Brazilian Jiu-Jitsu Core" },
  { id: "program-tae-kwon-do", name: "Tae Kwon Do Fundamentals" },
];

const previewLadders = [
  {
    program_id: "program-bjj-core",
    ranks: [
      { id: "rank-1", name: "White Belt", display_order: 0, is_tip: false },
      { id: "rank-1a", name: "Red Tip 1", display_order: 1, is_tip: true },
    ],
  },
  {
    program_id: "program-tae-kwon-do",
    ranks: [
      { id: "tkd-rank-1", name: "White Belt", display_order: 0, is_tip: false },
      { id: "tkd-rank-1a", name: "Yellow Stripe", display_order: 1, is_tip: true },
    ],
  },
];

describe("buildStableImportKey", () => {
  it("is stable when mapping key order changes", async () => {
    const left = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name", "Last Name": "legal_last_name" },
      options: { status_alias_mode: "normalize" },
    });
    const right = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "Last Name": "legal_last_name", "First Name": "legal_first_name" },
      options: { status_alias_mode: "normalize" },
    });

    assert.equal(left, right);
    assert.match(left, /^student-import:sha256:[a-f0-9]{64}$/);
  });

  it("is stable when nested option key order changes", async () => {
    const left = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {
        nested: { b: true, a: false },
        status_alias_mode: "normalize",
      },
    });
    const right = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {
        status_alias_mode: "normalize",
        nested: { a: false, b: true },
      },
    });

    assert.equal(left, right);
  });

  it("changes when the file content hash changes", async () => {
    const left = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    });
    const right = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:def",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    });

    assert.notEqual(left, right);
  });

  it("does not change when only file metadata changes outside the import request", async () => {
    const left = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    });
    const right = await buildStableImportKey({
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    });

    assert.equal(left, right);
  });

  it("changes when a duplicate decision changes and ignores empty decision maps", async () => {
    const base = {
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    };
    const plain = await buildStableImportKey(base);
    const emptyDecisions = await buildStableImportKey({ ...base, decisions: {} });
    const skip = await buildStableImportKey({
      ...base,
      decisions: { 4: { action: "skip", matched_student_id: "s1", of_row: null } },
    });
    const create = await buildStableImportKey({
      ...base,
      decisions: { 4: { action: "create", matched_student_id: "s1", of_row: null } },
    });

    assert.equal(emptyDecisions, plain);
    assert.notEqual(skip, plain);
    assert.notEqual(skip, create);
  });

  it("keeps validation results while decisions change but refreshes the import key", () => {
    const left = {
      rowCount: 2,
      contentHash: "sha256:abc",
      mapping: { "First Name": "legal_first_name" },
      options: {},
    };
    const right = {
      ...left,
      decisions: { 4: { action: "skip", matched_student_id: "s1", of_row: null } },
    };

    assert.equal(areCsvImportValidationInputsEqual(left, right), true);
    assert.equal(areCsvImportKeyInputsEqual(left, right), false);
    assert.equal(
      areCsvImportValidationInputsEqual(left, { ...right, contentHash: "sha256:def" }),
      false,
    );
  });

  it("compares import request inputs with the same canonical rules as idempotency keys", () => {
    assert.equal(
      areCsvImportKeyInputsEqual(
        {
          rowCount: 2,
          contentHash: "sha256:abc",
          mapping: { "First Name": "legal_first_name", "Last Name": "legal_last_name" },
          options: { status_alias_mode: "normalize", nested: { b: true, a: false } },
        },
        {
          rowCount: 2,
          contentHash: "sha256:abc",
          mapping: { "Last Name": "legal_last_name", "First Name": "legal_first_name" },
          options: { nested: { a: false, b: true }, status_alias_mode: "normalize" },
        },
      ),
      true,
    );
    assert.equal(
      areCsvImportKeyInputsEqual(
        {
          rowCount: 2,
          contentHash: "sha256:abc",
          mapping: { "First Name": "legal_first_name" },
          options: { status_alias_mode: "normalize" },
        },
        {
          rowCount: 2,
          contentHash: "sha256:abc",
          mapping: { "First Name": "preferred_name" },
          options: { status_alias_mode: "normalize" },
        },
      ),
      false,
    );
  });
});

describe("withCsvImportRefreshWarning", () => {
  it("keeps a committed import result successful while surfacing refresh follow-up", () => {
    const result = withCsvImportRefreshWarning(
      {
        imported_count: 12,
        execution_status: "completed",
        non_critical_errors: ["Audit log failed."],
      },
      "Students request timed out.",
    );

    assert.equal(result.imported_count, 12);
    assert.equal(result.execution_status, "completed_with_warnings");
    assert.equal(result.non_critical_errors.length, 2);
    assert.equal(result.non_critical_errors[1], "Students request timed out.");
  });
});

describe("formatCsvImportFileSizeLimit", () => {
  it("formats the shared frontend upload limit for owner-facing copy", () => {
    assert.equal(formatCsvImportFileSizeLimit(10 * 1024 * 1024), "10 MB");
  });
});

describe("preview CSV import id resolution", () => {
  it("resolves demo CSV program names to preview program ids", () => {
    assert.equal(
      resolvePreviewImportProgramId("Kids Brazilian Jiu-Jitsu", previewPrograms),
      "program-bjj-core",
    );
    assert.equal(
      resolvePreviewImportProgramId("Adult Brazilian Jiu-Jitsu", previewPrograms),
      "program-bjj-core",
    );
    assert.equal(
      resolvePreviewImportProgramId("Tae Kwon Do Fundamentals", previewPrograms),
      "program-tae-kwon-do",
    );
    assert.equal(
      resolvePreviewImportProgramId("program-bjj-core", previewPrograms),
      "program-bjj-core",
    );
    assert.equal(resolvePreviewImportProgramId("Unknown Program", previewPrograms), undefined);
  });

  it("resolves demo CSV belt names within the selected preview program", () => {
    assert.equal(
      resolvePreviewImportBeltRankId({
        value: "White Belt",
        programId: "program-bjj-core",
        beltLadders: previewLadders,
        fallbackRanks: [],
      }),
      "rank-1",
    );
    assert.equal(
      resolvePreviewImportBeltRankId({
        value: "White Belt",
        programId: "program-tae-kwon-do",
        beltLadders: previewLadders,
        fallbackRanks: [],
      }),
      "tkd-rank-1",
    );
    assert.equal(
      resolvePreviewImportBeltRankId({
        value: "White Stripe 1",
        programId: "program-bjj-core",
        beltLadders: previewLadders,
        fallbackRanks: [],
      }),
      "rank-1a",
    );
  });

  it("surfaces unresolved preview program and belt values as row warnings", () => {
    const result = resolvePreviewImportStudentIds({
      programValue: "Space Karate",
      beltRankValue: "White Belt",
      programs: previewPrograms,
      beltLadders: previewLadders,
      fallbackRanks: [],
    });

    assert.equal(result.programId, undefined);
    assert.equal(result.beltRankId, undefined);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["unresolved_program", "unresolved_belt"],
    );
    assert.deepEqual(
      result.issues.map((issue) => issue.severity),
      ["warning", "warning"],
    );
  });
});

it("includes source system in the browser import key only when set", async () => {
  const input = {
    rowCount: 1,
    mapping: { ID: "source_id" },
    contentHash: "synthetic",
    options: {},
  };
  assert.notEqual(
    await buildStableImportKey(input),
    await buildStableImportKey({ ...input, options: { source_system: "csv" } }),
  );
  assert.notEqual(
    await buildStableImportKey(input),
    await buildStableImportKey({ ...input, options: { source_system: "old-roster" } }),
  );
});

it("preserves browser keys issued before source IDs were supported", async () => {
  // Pins obtained by git archive b72536930c1aaf7e6380e60c8abbb757ff2445a2
  // frontend/src/lib/{csv-import,request-body-limits}.ts into a temporary checkout,
  // then calling that buildStableImportKey with Node --experimental-strip-types.
  // contentHash is SHA-256 of the exact bytes "First,Last\nAva,Nguyen\n".
  const { DEFAULT_IMPORT_OPTIONS } = await import("../src/lib/student-import-page-model.ts");
  const input = {
    rowCount: 1,
    contentHash: "ca2aad72014479d29655d8e7d9e2be2ba67d8593154469283e8094b71d951cbd",
    mapping: { First: "legal_first_name", Last: "legal_last_name" },
    options: DEFAULT_IMPORT_OPTIONS,
  };
  const expected =
    "student-import:sha256:10df2938ecd4ad9b1ab47cd552abd746976653d1599aa9ec5e0a6fc08ed1727b";
  assert.equal(await buildStableImportKey(input), expected);
  assert.equal(
    await buildStableImportKey({ ...input, options: { ...input.options, source_system: null } }),
    expected,
  );
  assert.notEqual(
    await buildStableImportKey({ ...input, options: { ...input.options, source_system: "csv" } }),
    expected,
  );
  assert.equal(
    await buildStableImportKey({
      ...input,
      decisions: { 2: { action: "skip", matched_student_id: "s1", of_row: null } },
    }),
    "student-import:sha256:a4ca6b168daed9dd6f596a7a29b29414fcba30e4d07884a5e748dbd0ce00854e",
  );
  assert.notEqual(
    await buildStableImportKey({ ...input, mapping: { ...input.mapping, ID: "source_id" } }),
    expected,
  );
});
