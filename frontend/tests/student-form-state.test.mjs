import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStudentFormSubmitPayload,
  buildInitialStudentFormFields,
  buildStudentCreatePayload,
  buildStudentUpdatePayload,
  validateStudentFormFields,
} from "../src/components/students/student-form-state.ts";

describe("student form state", () => {
  it("builds initial field state from student data", () => {
    const fields = buildInitialStudentFormFields({
      legal_first_name: "Aiko",
      legal_last_name: "Tanaka",
      program_id: "program-a",
      tags: ["youth", "beginner"],
      guardians: [
        {
          first_name: "Kenji",
          last_name: "Tanaka",
          email: "kenji@example.com",
          is_primary_contact: true,
        },
      ],
    });

    assert.equal(fields.legalFirst, "Aiko");
    assert.deepEqual(fields.programIds, ["program-a"]);
    assert.equal(fields.tags, "youth, beginner");
    assert.equal(fields.guardianFirst, "Kenji");
  });

  it("validates required names and hold date ordering", () => {
    const fields = buildInitialStudentFormFields();

    assert.deepEqual(validateStudentFormFields(fields), {
      message: "First name and last name are required.",
      tab: "info",
    });

    assert.deepEqual(validateStudentFormFields({
      ...fields,
      legalFirst: "Aiko",
      legalLast: "Tanaka",
      holdEnd: "2026-06-01",
    }), {
      message: "Add a hold start date before setting a hold end date.",
      tab: "info",
    });

    assert.deepEqual(validateStudentFormFields({
      ...fields,
      legalFirst: "Aiko",
      legalLast: "Tanaka",
      holdStart: "2026-06-10",
      holdEnd: "2026-06-01",
    }), {
      message: "Hold end date cannot be before the hold start date.",
      tab: "info",
    });
  });

  it("builds the submitted StudentCreate payload", () => {
    const payload = buildStudentCreatePayload(
      {
        ...buildInitialStudentFormFields(),
        legalFirst: " Aiko ",
        legalLast: " Tanaka ",
        preferredName: " Ai ",
        status: "trialing",
        programIds: ["program-a", "program-b"],
        tags: " youth, , beginner ",
        guardianFirst: " Kenji ",
        guardianLast: " Tanaka ",
        guardianEmail: " kenji@example.com ",
      },
      { current_belt_rank_id: "rank-a" }
    );

    assert.equal(payload.legal_first_name, "Aiko");
    assert.equal(payload.preferred_name, "Ai");
    assert.equal(payload.status, "trialing");
    assert.equal(payload.program_id, "program-a");
    assert.deepEqual(payload.program_ids, ["program-a", "program-b"]);
    assert.deepEqual(payload.tags, ["youth", "beginner"]);
    assert.equal(payload.current_belt_rank_id, "rank-a");
    assert.deepEqual(payload.guardians, [
      {
        first_name: "Kenji",
        last_name: "Tanaka",
        email: "kenji@example.com",
        phone: undefined,
        relation: undefined,
        is_primary_contact: true,
      },
    ]);
  });

  it("builds an explicit StudentUpdate payload without guardian fields", () => {
    const payload = buildStudentUpdatePayload(
      {
        ...buildInitialStudentFormFields({
          current_belt_rank_id: "rank-a",
          guardians: [
            {
              first_name: "Kenji",
              last_name: "Tanaka",
              email: "kenji@example.com",
              is_primary_contact: true,
            },
          ],
        }),
        legalFirst: " Aiko ",
        legalLast: " Tanaka ",
        preferredName: "",
        status: "paused",
        holdStart: "",
        holdEnd: "",
        programIds: ["program-a", "program-b"],
        tags: " youth, , leadership ",
        email: "",
        phone: " 555-0100 ",
      },
      { current_belt_rank_id: "rank-a" }
    );

    assert.equal(payload.legal_first_name, "Aiko");
    assert.equal(payload.preferred_name, null);
    assert.equal(payload.hold_start_date, null);
    assert.equal(payload.email, null);
    assert.equal(payload.phone, "555-0100");
    assert.equal(payload.status, "paused");
    assert.equal(payload.program_id, "program-a");
    assert.deepEqual(payload.program_ids, ["program-a", "program-b"]);
    assert.deepEqual(payload.tags, ["youth", "leadership"]);
    assert.equal(payload.current_belt_rank_id, "rank-a");
    assert.equal(Object.hasOwn(payload, "guardians"), false);
  });

  it("selects create or update payloads from the same submit decision as the form hook", () => {
    const createPayload = buildStudentFormSubmitPayload({
      ...buildInitialStudentFormFields(),
      legalFirst: " Aiko ",
      legalLast: " Tanaka ",
      guardianFirst: " Kenji ",
    });
    const updatePayload = buildStudentFormSubmitPayload(
      {
        ...buildInitialStudentFormFields({ current_belt_rank_id: "rank-a" }),
        legalFirst: " Aiko ",
        legalLast: " Tanaka ",
        preferredName: "",
      },
      { current_belt_rank_id: "rank-a" }
    );

    assert.deepEqual(createPayload.guardians, [
      {
        first_name: "Kenji",
        last_name: "",
        email: undefined,
        phone: undefined,
        relation: undefined,
        is_primary_contact: true,
      },
    ]);
    assert.equal(Object.hasOwn(updatePayload, "guardians"), false);
    assert.equal(updatePayload.current_belt_rank_id, "rank-a");
    assert.equal(updatePayload.preferred_name, null);
  });
});
