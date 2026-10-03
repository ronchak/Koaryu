import assert from "node:assert/strict";
import { test } from "node:test";
import { initialBootstrapView, bootstrapDatasets } from "../src/lib/bootstrap-route.ts";
import {
  markDashboardFactsChanged,
  needsFreshDashboardFacts,
} from "../src/lib/dashboard-freshness.ts";

test("route bootstrap requirements omit unrelated feature collections", () => {
  for (const route of ["schedule", "settings"])
    assert.deepEqual(
      [...bootstrapDatasets(initialBootstrapView(`/${route}`))],
      ["studio", "programs"],
    );
  for (const route of ["leads", "reports"])
    assert.deepEqual(
      [...bootstrapDatasets(initialBootstrapView(`/${route}`))],
      ["studio", "programs", "leads"],
    );
  assert.deepEqual(
    [...bootstrapDatasets(initialBootstrapView("/belt-tracker"))],
    ["studio", "programs", "belts"],
  );
  assert.equal(initialBootstrapView("/billing"), null);
  assert.equal(initialBootstrapView("/account/settings"), null);
  assert.equal(initialBootstrapView("/students/student-id"), "students");
});

test("ordinary visits can reuse facts but local and other-tab writes demand fresh reconciliation", () => {
  const oldWindow = globalThis.window;
  const data = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  };
  try {
    assert.equal(needsFreshDashboardFacts(1000), false);
    markDashboardFactsChanged(2000);
    assert.equal(needsFreshDashboardFacts(2001), true);
    assert.equal(needsFreshDashboardFacts(61000), true);
    assert.equal(needsFreshDashboardFacts(62001), false);
    data.set("koaryu:facts-changed-at", "63000");
    assert.equal(needsFreshDashboardFacts(63001), true);
    data.set("koaryu:facts-changed-at", "invalid");
    assert.equal(needsFreshDashboardFacts(64000), false);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
