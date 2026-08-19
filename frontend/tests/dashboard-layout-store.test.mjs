import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DASHBOARD_LAYOUT_NAMESPACE,
  DASHBOARD_LAYOUT_MAX_ROWS,
  DASHBOARD_LAYOUT_VERSION,
  buildDashboardLayoutKey,
  buildDefaultDashboardLayout,
  getDashboardWidgetFootprint,
  moveDashboardLayoutItem,
  packDashboardLayoutItems,
  projectDashboardFrameTargetToStoredCell,
  purgeDashboardLayoutNamespace,
  readDashboardLayout,
  reconcileDashboardLayout,
  resizeDashboardLayoutItem,
  writeDashboardLayout,
} from "../src/lib/dashboard-layout-store.ts";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
}

const adminIdentity = { userId: "user/1", studioId: "studio:1", role: "admin" };

function assertCollisionFree(items, columns = 4) {
  const occupied = new Set();
  for (const item of items) {
    const footprint = getDashboardWidgetFootprint(item.size);
    assert.ok(item.column >= 0 && item.column + footprint.columns <= columns, item.widget_id);
    assert.ok(item.row >= 0, item.widget_id);
    for (let row = item.row; row < item.row + footprint.rows; row += 1) {
      for (let column = item.column; column < item.column + footprint.columns; column += 1) {
        const cell = `${column}:${row}`;
        assert.ok(!occupied.has(cell), `${item.widget_id} overlaps at ${cell}`);
        occupied.add(cell);
      }
    }
  }
}

describe("dashboard layout storage", () => {
  it("builds isolated, guarded keys for user, studio, and role", () => {
    const key = buildDashboardLayoutKey(adminIdentity.userId, adminIdentity.studioId, adminIdentity.role);
    assert.equal(key, `${DASHBOARD_LAYOUT_NAMESPACE}user%2F1:studio%3A1:admin`);
    assert.notEqual(key, buildDashboardLayoutKey("user/2", adminIdentity.studioId, "admin"));
    assert.notEqual(key, buildDashboardLayoutKey(adminIdentity.userId, "studio:2", "admin"));
    assert.notEqual(key, buildDashboardLayoutKey(adminIdentity.userId, adminIdentity.studioId, "front_desk"));
    assert.equal(buildDashboardLayoutKey("", "studio", "admin"), null);
    assert.equal(buildDashboardLayoutKey("user", "studio", "unknown"), null);
  });

  it("migrates v1 order, metadata, removals, and legacy sizes into collision-free v2 geometry", () => {
    const reconciled = reconcileDashboardLayout({
      version: 1,
      updated_at: "saved",
      client_id: "client-a",
      items: [
        { widget_id: "student_pulse", size: "4x2" },
        { widget_id: "student_pulse", size: "1x1" },
        { widget_id: "unknown", size: "1x1" },
        { widget_id: "billing_exceptions", size: "2x1" },
        { widget_id: "quick_actions", size: "4x1" },
        { widget_id: "recent_students", size: "4x2" },
      ],
      removed_widget_ids: ["classes_today"],
    }, "admin");

    assert.equal(reconciled.items[0].widget_id, "needs_attention");
    assert.equal(reconciled.items[0].size, "2x2");
    assert.equal(reconciled.version, DASHBOARD_LAYOUT_VERSION);
    assert.equal(reconciled.updated_at, "saved");
    assert.equal(reconciled.client_id, "client-a");
    assert.equal(reconciled.items.find((item) => item.widget_id === "student_pulse")?.size, "1x1");
    assert.equal(reconciled.items.filter((item) => item.widget_id === "student_pulse").length, 1);
    assert.ok(!reconciled.items.some((item) => item.widget_id === "classes_today"));
    assert.equal(reconciled.items.find((item) => item.widget_id === "quick_actions")?.size, "2x1");
    assert.equal(reconciled.items.find((item) => item.widget_id === "recent_students")?.size, "2x2");
    assertCollisionFree(reconciled.items);

    assert.deepEqual(
      reconcileDashboardLayout({ version: 999, items: [] }, "admin"),
      buildDefaultDashboardLayout("admin")
    );
  });

  it("drops seeded Admin billing panels for Instructor and unknown roles", () => {
    const seeded = {
      version: 1,
      items: [
        { widget_id: "billing_exceptions", size: "2x1" },
        { widget_id: "revenue_due", size: "2x1" },
        { widget_id: "quick_actions", size: "2x1" },
      ],
    };
    for (const role of ["instructor", null, "unknown"]) {
      const ids = reconcileDashboardLayout(seeded, role).items.map((item) => item.widget_id);
      assert.equal(ids[0], "needs_attention");
      assert.ok(!ids.includes("billing_exceptions"));
      assert.ok(!ids.includes("revenue_due"));
    }
  });

  it("repairs overlapping and out-of-bounds v2 coordinates without privilege gain", () => {
    const reconciled = reconcileDashboardLayout({
      version: DASHBOARD_LAYOUT_VERSION,
      items: [
        { widget_id: "needs_attention", size: "1x1", column: 3, row: 9 },
        { widget_id: "classes_today", size: "2x2", column: 0, row: 0 },
        { widget_id: "student_pulse", size: "1x1", column: 99, row: -1 },
        { widget_id: "billing_exceptions", size: "2x1", column: 2, row: 0 },
        { widget_id: "billing_exceptions", size: "1x1", column: 1, row: 1 },
        { widget_id: "unknown", size: "1x1", column: 0, row: 0 },
      ],
    }, "instructor");
    assert.deepEqual(reconciled.items[0], {
      widget_id: "needs_attention",
      size: "2x2",
      column: 0,
      row: 0,
    });
    assert.ok(!reconciled.items.some((item) => item.widget_id === "billing_exceptions"));
    assertCollisionFree(reconciled.items);
  });

  it("repacks unreasonable stored rows and clamps direct moves to the finite catalog grid", () => {
    const reconciled = reconcileDashboardLayout({
      version: DASHBOARD_LAYOUT_VERSION,
      items: [
        { widget_id: "needs_attention", size: "2x2", column: 0, row: 0 },
        { widget_id: "student_pulse", size: "1x1", column: 3, row: 256 },
      ],
    }, "admin");
    const repaired = reconciled.items.find((item) => item.widget_id === "student_pulse");
    assert.ok(repaired.row < DASHBOARD_LAYOUT_MAX_ROWS);
    assertCollisionFree(reconciled.items);

    const moved = moveDashboardLayoutItem(reconciled.items, "student_pulse", 3, 256);
    const clamped = moved.find((item) => item.widget_id === "student_pulse");
    assert.equal(clamped.row, DASHBOARD_LAYOUT_MAX_ROWS - 1);
    assertCollisionFree(moved);
  });

  it("packs defaults deterministically and exposes every footprint", () => {
    assert.deepEqual(getDashboardWidgetFootprint("1x1"), { columns: 1, rows: 1 });
    assert.deepEqual(getDashboardWidgetFootprint("2x1"), { columns: 2, rows: 1 });
    assert.deepEqual(getDashboardWidgetFootprint("1x2"), { columns: 1, rows: 2 });
    assert.deepEqual(getDashboardWidgetFootprint("2x2"), { columns: 2, rows: 2 });
    const first = buildDefaultDashboardLayout("admin");
    const second = buildDefaultDashboardLayout("admin");
    assert.deepEqual(first, second);
    assert.deepEqual(first.items.slice(0, 2), [
      { widget_id: "needs_attention", size: "2x2", column: 0, row: 0 },
      { widget_id: "classes_today", size: "2x2", column: 2, row: 0 },
    ]);
    assertCollisionFree(first.items);
  });

  it("moves into occupied space and resizes through 1x2 with deterministic reflow", () => {
    const initial = packDashboardLayoutItems([
      { widget_id: "needs_attention", size: "2x2" },
      { widget_id: "classes_today", size: "2x1" },
      { widget_id: "lead_follow_ups", size: "1x1" },
      { widget_id: "quick_actions", size: "1x1" },
    ], 4, false);
    const moved = moveDashboardLayoutItem(initial, "lead_follow_ups", 2, 0);
    assert.equal(moved.find((item) => item.widget_id === "lead_follow_ups")?.column, 2);
    assert.equal(moved.find((item) => item.widget_id === "lead_follow_ups")?.row, 0);
    assert.notDeepEqual(moved.find((item) => item.widget_id === "classes_today"), initial[1]);
    assertCollisionFree(moved);

    const stableOrder = initial.map((item) => item.widget_id);
    const stableMoved = moveDashboardLayoutItem(initial, "lead_follow_ups", 2, 0, stableOrder);
    const stableReturned = moveDashboardLayoutItem(stableMoved, "lead_follow_ups", 2, 1, stableOrder);
    assert.deepEqual(stableReturned, initial);

    const tall = resizeDashboardLayoutItem(moved, "lead_follow_ups", "1x2");
    assert.equal(tall.find((item) => item.widget_id === "lead_follow_ups")?.size, "1x2");
    assertCollisionFree(tall);
    const wide = resizeDashboardLayoutItem(tall, "lead_follow_ups", "2x1");
    assert.equal(wide.find((item) => item.widget_id === "lead_follow_ups")?.size, "2x1");
    assertCollisionFree(wide);
  });

  it("projects two-column visual targets back into stored four-column cells", () => {
    const stored = buildDefaultDashboardLayout("admin").items;
    const tablet = packDashboardLayoutItems(stored, 2, false);
    const attendance = tablet.find((item) => item.widget_id === "attendance");
    assert.ok(attendance);
    const projected = projectDashboardFrameTargetToStoredCell(
      stored,
      "student_pulse",
      2,
      attendance.column,
      attendance.row
    );
    const storedAttendance = stored.find((item) => item.widget_id === "attendance");
    assert.deepEqual(projected, {
      column: storedAttendance.column,
      row: storedAttendance.row,
    });
    assert.deepEqual(
      projectDashboardFrameTargetToStoredCell(stored, "student_pulse", 4, 3, 5),
      { column: 3, row: 5 }
    );
  });

  it("reads malformed and unavailable storage as a safe default", () => {
    const storage = new MemoryStorage();
    const key = buildDashboardLayoutKey(adminIdentity.userId, adminIdentity.studioId, adminIdentity.role);
    storage.setItem(key, "{broken");
    assert.deepEqual(readDashboardLayout(storage, adminIdentity), {
      layout: buildDefaultDashboardLayout("admin"),
      source: "default",
    });
    assert.deepEqual(readDashboardLayout(null, adminIdentity).layout, buildDefaultDashboardLayout("admin"));
    storage.setItem(key, JSON.stringify({ version: 999, items: [] }));
    assert.equal(readDashboardLayout(storage, adminIdentity).source, "default");
    const throwing = {
      get length() { throw new Error("blocked"); },
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
      key() { throw new Error("blocked"); },
    };
    assert.deepEqual(readDashboardLayout(throwing, adminIdentity).layout, buildDefaultDashboardLayout("admin"));
  });

  it("persists anonymous client metadata and survives quota errors", () => {
    const storage = new MemoryStorage();
    const result = writeDashboardLayout(storage, adminIdentity, buildDefaultDashboardLayout("admin"), {
      now: () => "2026-08-17T17:00:00.000Z",
      createClientId: () => "anonymous-client",
    });
    assert.equal(result.ok, true);
    assert.equal(result.layout.updated_at, "2026-08-17T17:00:00.000Z");
    assert.equal(result.layout.client_id, "anonymous-client");
    assert.deepEqual(readDashboardLayout(storage, adminIdentity), {
      layout: result.layout,
      source: "stored",
    });

    const quotaStorage = new MemoryStorage();
    quotaStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    const quota = writeDashboardLayout(quotaStorage, adminIdentity, result.layout);
    assert.equal(quota.ok, false);
    assert.equal(quota.layout.items[0].widget_id, "needs_attention");
  });

  it("purges the complete namespace and preserves unrelated keys", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${DASHBOARD_LAYOUT_NAMESPACE}one`, "1");
    storage.setItem(`${DASHBOARD_LAYOUT_NAMESPACE}two`, "2");
    storage.setItem("koaryu-theme", "dark");
    storage.setItem("koaryu:preview:students", "[]");
    assert.equal(purgeDashboardLayoutNamespace(storage), 2);
    assert.equal(storage.getItem(`${DASHBOARD_LAYOUT_NAMESPACE}one`), null);
    assert.equal(storage.getItem(`${DASHBOARD_LAYOUT_NAMESPACE}two`), null);
    assert.equal(storage.getItem("koaryu-theme"), "dark");
    assert.equal(storage.getItem("koaryu:preview:students"), "[]");
  });
});
