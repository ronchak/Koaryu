import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countActiveAdminMembers,
  filterStaffMembersForDisplay,
  getDisplayedStaffIdentity,
  isLastActiveAdmin,
  matchesStaffDeletionConfirmation,
  normalizeStaffConfirmationInput,
} from "../src/lib/staff-roles-ui-model.ts";

function member(id, overrides = {}) {
  return {
    id,
    studio_id: "studio-1",
    user_id: `${id}-user`,
    email: `${id}@example.test`,
    full_name: `${id} display`,
    deletion_confirmation_name: `${id} display`,
    legal_first_name: `${id} legal`,
    legal_last_name: "name",
    role: "instructor",
    status: "active",
    archived_at: null,
    invited_by: null,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    last_sign_in_at: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("staff roles UI model", () => {
  it("filters archived rows by default while retaining them for the explicit view", () => {
    const active = member("active");
    const archived = member("archived", {
      status: "archived",
      archived_at: "2026-08-16T00:00:00.000Z",
    });

    assert.deepEqual(
      filterStaffMembersForDisplay([active, archived], false),
      [active]
    );
    assert.deepEqual(
      filterStaffMembersForDisplay([active, archived], true),
      [active, archived]
    );
  });

  it("uses the server-owned confirmation identity without deriving it from legal or email fields", () => {
    const fallback = member("role-123", {
      full_name: null,
      email: "",
      legal_first_name: null,
      legal_last_name: null,
      deletion_confirmation_name: "staff role role-123",
    });

    assert.equal(getDisplayedStaffIdentity(fallback), "staff role role-123");
  });

  it("normalizes whitespace but preserves case for typed confirmation", () => {
    const target = member("maya", {
      deletion_confirmation_name: "Maya Chen",
    });

    assert.equal(normalizeStaffConfirmationInput("  Maya\n  Chen  "), "Maya Chen");
    assert.equal(matchesStaffDeletionConfirmation(target, "  Maya\n  Chen  "), true);
    assert.equal(matchesStaffDeletionConfirmation(target, "maya chen"), false);
    assert.equal(matchesStaffDeletionConfirmation(target, "Maya Ch en"), false);
  });

  it("counts only active admins and protects the last active admin", () => {
    const activeAdmin = member("active-admin", { role: "admin" });
    const archivedAdmin = member("archived-admin", {
      role: "admin",
      status: "archived",
      archived_at: "2026-08-16T00:00:00.000Z",
    });
    const pendingAdmin = member("pending-admin", {
      role: "admin",
      status: "pending",
      last_sign_in_at: null,
    });

    assert.equal(countActiveAdminMembers([activeAdmin, archivedAdmin, pendingAdmin]), 1);
    assert.equal(isLastActiveAdmin([activeAdmin, archivedAdmin, pendingAdmin], activeAdmin), true);
    assert.equal(isLastActiveAdmin([activeAdmin, archivedAdmin], archivedAdmin), false);

    const secondActiveAdmin = member("second-active-admin", { role: "admin" });
    assert.equal(
      isLastActiveAdmin([activeAdmin, secondActiveAdmin, archivedAdmin], activeAdmin),
      false
    );
  });
});
