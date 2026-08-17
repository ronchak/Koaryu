import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DASHBOARD_LAYOUT_NAMESPACE,
  DASHBOARD_LAYOUT_VERSION,
  buildDashboardLayoutKey,
  buildDefaultDashboardLayout,
  purgeDashboardLayoutNamespace,
  readDashboardLayout,
  reconcileDashboardLayout,
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

  it("reconciles unknown, duplicate, fixed, sizes, defaults, removals, and version fallback", () => {
    const reconciled = reconcileDashboardLayout({
      version: DASHBOARD_LAYOUT_VERSION,
      updated_at: "saved",
      client_id: "client-a",
      items: [
        { widget_id: "student_pulse", size: "4x2" },
        { widget_id: "student_pulse", size: "1x1" },
        { widget_id: "unknown", size: "1x1" },
        { widget_id: "billing_exceptions", size: "2x1" },
      ],
      removed_widget_ids: ["classes_today"],
    }, "admin");

    assert.equal(reconciled.items[0].widget_id, "needs_attention");
    assert.equal(reconciled.items[0].size, "2x2");
    assert.deepEqual(reconciled.items.find((item) => item.widget_id === "student_pulse"), {
      widget_id: "student_pulse",
      size: "1x1",
    });
    assert.equal(reconciled.items.filter((item) => item.widget_id === "student_pulse").length, 1);
    assert.ok(!reconciled.items.some((item) => item.widget_id === "classes_today"));
    assert.ok(reconciled.items.some((item) => item.widget_id === "quick_actions"));

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
