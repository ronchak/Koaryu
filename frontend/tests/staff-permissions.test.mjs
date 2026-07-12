import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasStaffPermission } from "../src/lib/staff-permissions.ts";
describe("staff permission policy", () => {
  it("allows roster bulk operations, schedule management, and lead conversion to admin and front desk", () => {
    for (const permission of ["manage_roster_bulk", "manage_schedule", "convert_leads"]) {
      assert.equal(hasStaffPermission("admin", permission), true);
      assert.equal(hasStaffPermission("front_desk", permission), true);
      assert.equal(hasStaffPermission("instructor", permission), false);
    }
  });

  it("keeps belt configuration admin-only and promotions available to admin and instructors", () => {
    assert.equal(hasStaffPermission("admin", "configure_belts"), true);
    assert.equal(hasStaffPermission("front_desk", "configure_belts"), false);
    assert.equal(hasStaffPermission("instructor", "configure_belts"), false);
    assert.equal(hasStaffPermission("admin", "promote_students"), true);
    assert.equal(hasStaffPermission("instructor", "promote_students"), true);
    assert.equal(hasStaffPermission("front_desk", "promote_students"), false);
  });

  it("keeps routine attendance available to every staff role and denies an unresolved role", () => {
    for (const role of ["admin", "front_desk", "instructor"]) {
      assert.equal(hasStaffPermission(role, "take_attendance"), true);
    }
    assert.equal(hasStaffPermission(null, "take_attendance"), false);
    assert.equal(hasStaffPermission(null, "manage_roster_bulk"), false);
  });
});
