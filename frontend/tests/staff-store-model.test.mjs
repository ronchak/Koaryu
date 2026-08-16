import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyStaffLegalNameUpdate,
  applyStaffRoleUpdate,
  buildPreviewStaffInvite,
  mergeStaffLegalNameResponse,
  sortStaffMembers,
  upsertStaffMember,
} from "../src/lib/staff-store-model.ts";

function staffMember(id, overrides = {}) {
  return {
    id,
    studio_id: "mock-studio",
    user_id: `user-${id}`,
    email: `${id}@example.test`,
    full_name: null,
    role: "front_desk",
    status: "pending",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    last_sign_in_at: null,
    ...overrides,
  };
}

describe("staff store model", () => {
  it("sorts the current user first, then role, status, and creation date", () => {
    const sorted = sortStaffMembers(
      [
        staffMember("later-front", { role: "front_desk", status: "active", created_at: "2026-05-04T00:00:00.000Z" }),
        staffMember("instructor", { role: "instructor", status: "active", created_at: "2026-05-03T00:00:00.000Z" }),
        staffMember("current", { user_id: "user-current", role: "front_desk", status: "pending", created_at: "2026-05-05T00:00:00.000Z" }),
        staffMember("admin-pending", { role: "admin", status: "pending", created_at: "2026-05-02T00:00:00.000Z" }),
        staffMember("admin-active", { role: "admin", status: "active", created_at: "2026-05-06T00:00:00.000Z" }),
      ],
      "user-current"
    );

    assert.deepEqual(
      sorted.map((member) => member.id),
      ["current", "admin-active", "admin-pending", "instructor", "later-front"]
    );
  });

  it("builds preview staff invitations with normalized email and all submitted names", () => {
    const built = buildPreviewStaffInvite(
      {
        email: "  INSTRUCTOR@Example.TEST  ",
        role: "instructor",
        full_name: "  Instructor   Display  ",
        legal_first_name: "  Legal\tFirst ",
        legal_last_name: " Last\nName ",
      },
      null,
      {
        now: new Date("2026-05-24T12:00:00.000Z"),
        nowMs: 12345,
      }
    );

    assert.deepEqual(
      {
        id: built.id,
        studio_id: built.studio_id,
        user_id: built.user_id,
        email: built.email,
        role: built.role,
        full_name: built.full_name,
        legal_first_name: built.legal_first_name,
        legal_last_name: built.legal_last_name,
        status: built.status,
        invited_by: built.invited_by,
        created_at: built.created_at,
        updated_at: built.updated_at,
      },
      {
        id: "preview-staff-12345",
        studio_id: "mock-studio",
        user_id: "preview-staff-user-12345",
        email: "instructor@example.test",
        role: "instructor",
        full_name: "Instructor Display",
        legal_first_name: "Legal First",
        legal_last_name: "Last Name",
        status: "pending",
        invited_by: "preview-user",
        created_at: "2026-05-24T12:00:00.000Z",
        updated_at: "2026-05-24T12:00:00.000Z",
      }
    );
  });

  it("upserts and re-sorts returned staff members", () => {
    const members = [
      staffMember("member-1", { role: "front_desk" }),
      staffMember("member-2", { role: "instructor" }),
    ];
    const upserted = upsertStaffMember(
      members,
      staffMember("member-1", { role: "admin", status: "active" }),
      null
    );

    assert.deepEqual(upserted.map((member) => [member.id, member.role]), [
      ["member-1", "admin"],
      ["member-2", "instructor"],
    ]);
  });

  it("applies preview role updates and reports missing members", () => {
    const members = [
      staffMember("member-1", { role: "front_desk" }),
      staffMember("member-2", { role: "instructor" }),
    ];

    const result = applyStaffRoleUpdate(
      members,
      "member-1",
      "admin",
      null,
      "2026-05-24T12:00:00.000Z"
    );
    assert.deepEqual(result.members.map((member) => [member.id, member.role, member.updated_at]), [
      ["member-1", "admin", "2026-05-24T12:00:00.000Z"],
      ["member-2", "instructor", "2026-05-01T00:00:00.000Z"],
    ]);
    assert.deepEqual([result.updated?.id, result.updated?.role], ["member-1", "admin"]);

    const missing = applyStaffRoleUpdate(members, "missing", "admin");
    assert.equal(missing.updated, null);
    assert.deepEqual(missing.members.map((member) => member.id), ["member-2", "member-1"]);
  });

  it("merges legal names by user id without replacing unrelated roster fields", () => {
    const members = [
      staffMember("member-1", {
        full_name: "Display Person",
        legal_first_name: "Old",
        legal_last_name: "Name",
        updated_at: "2026-05-24T10:00:00.000Z",
      }),
      staffMember("member-2", { user_id: "user-other", full_name: "Other Person" }),
    ];

    const result = mergeStaffLegalNameResponse(members, {
      user_id: "user-member-1",
      legal_first_name: "New",
      legal_last_name: "Name",
    });

    assert.equal(result.updated?.id, "member-1");
    assert.deepEqual(
      result.members.map((member) => ({
        id: member.id,
        full_name: member.full_name,
        legal_first_name: member.legal_first_name,
        legal_last_name: member.legal_last_name,
        updated_at: member.updated_at,
      })),
      [
        {
          id: "member-1",
          full_name: "Display Person",
          legal_first_name: "New",
          legal_last_name: "Name",
          updated_at: "2026-05-24T10:00:00.000Z",
        },
        {
          id: "member-2",
          full_name: "Other Person",
          legal_first_name: undefined,
          legal_last_name: undefined,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ]
    );

    const missing = applyStaffLegalNameUpdate(members, "missing-user", "Ari", "Lane");
    assert.equal(missing.updated, null);
    assert.deepEqual(missing.members, members);
  });
});
