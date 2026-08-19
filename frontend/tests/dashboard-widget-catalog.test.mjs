import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DASHBOARD_WIDGET_CATALOG,
  DASHBOARD_WIDGET_SIZES,
  getDashboardWidgetCatalogForRole,
} from "../src/lib/dashboard-widget-catalog.ts";

describe("dashboard widget catalog", () => {
  it("declares the approved product-owned catalog and complete state copy", () => {
    assert.deepEqual(
      DASHBOARD_WIDGET_CATALOG.map((entry) => entry.title),
      [
        "Needs Attention",
        "Classes Today",
        "Student Pulse",
        "Attendance",
        "Lead Follow-ups",
        "Promotions Due",
        "Billing Exceptions",
        "Revenue Due",
        "Setup Progress",
        "Recent Students",
        "Saved Report",
        "Quick Actions",
        "Emergency Contacts",
      ]
    );
    const expectedAllowedSizes = {
      needs_attention: ["2x2"],
      classes_today: ["2x1", "1x2", "2x2"],
      student_pulse: ["1x1", "2x1"],
      attendance: ["1x1", "2x1"],
      lead_follow_ups: ["1x1", "2x1", "1x2", "2x2"],
      promotions_due: ["1x1", "2x1", "1x2", "2x2"],
      billing_exceptions: ["1x1", "2x1", "1x2"],
      revenue_due: ["1x1", "2x1"],
      setup_progress: ["1x1", "2x1"],
      recent_students: ["2x1", "1x2", "2x2"],
      saved_report: ["2x1", "2x2"],
      quick_actions: ["1x1", "2x1", "1x2"],
      emergency_contacts: ["2x1", "1x2", "2x2"],
    };
    for (const entry of DASHBOARD_WIDGET_CATALOG) {
      assert.deepEqual(entry.allowedSizes, expectedAllowedSizes[entry.id], entry.id);
      assert.ok(entry.allowedSizes.includes(entry.defaultSize), entry.id);
      assert.ok(entry.sourceRoute.startsWith("/"), entry.id);
      assert.ok(entry.provenanceCopy && entry.windowCopy, entry.id);
      assert.deepEqual(Object.keys(entry.stateCopy).sort(), [
        "empty",
        "error",
        "loading",
        "partial",
        "unavailable",
      ]);
      for (const size of entry.allowedSizes) assert.ok(DASHBOARD_WIDGET_SIZES.includes(size));
    }
    assert.deepEqual(DASHBOARD_WIDGET_SIZES, ["1x1", "2x1", "1x2", "2x2"]);
  });

  it("keeps Needs Attention fixed and fails billing entitlement closed", () => {
    const attention = DASHBOARD_WIDGET_CATALOG[0];
    assert.equal(attention.id, "needs_attention");
    assert.equal(attention.fixed, true);
    assert.equal(attention.removable, false);
    assert.deepEqual(attention.allowedSizes, ["2x2"]);
    assert.equal(attention.defaultSize, "2x2");
    const classes = DASHBOARD_WIDGET_CATALOG[1];
    assert.deepEqual(classes.allowedSizes, ["2x1", "1x2", "2x2"]);
    assert.equal(classes.defaultSize, "2x2");

    for (const role of ["instructor", null, "unknown"]) {
      const ids = getDashboardWidgetCatalogForRole(role).map((entry) => entry.id);
      assert.ok(ids.includes("needs_attention"));
      assert.ok(!ids.includes("billing_exceptions"));
      assert.ok(!ids.includes("revenue_due"));
    }
    const adminIds = getDashboardWidgetCatalogForRole("admin").map((entry) => entry.id);
    assert.ok(adminIds.includes("billing_exceptions"));
    assert.ok(adminIds.includes("revenue_due"));
  });
});
