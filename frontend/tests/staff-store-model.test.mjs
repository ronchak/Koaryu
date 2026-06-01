import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyStaffRoleUpdate,
  buildPreviewStaffInvite,
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

  it("builds preview staff invitations with normalized email and fallback inviter", () => {
    const built = buildPreviewStaffInvite(
      { email: "  INSTRUCTOR@Example.TEST  ", role: "instructor" },
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
});
