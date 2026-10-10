import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createRetainedStore } from "../src/lib/retained-store.ts";
import {
  readStudentRosterSnapshot,
  readStudentSummary,
  rememberStudentRosterSnapshot,
  rememberStudentSummaries,
} from "../src/lib/student-retained-data.ts";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(frontendRoot, relative), "utf8");

function filesUnder(relative) {
  const root = path.join(frontendRoot, relative);
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    return statSync(full).isDirectory()
      ? filesUnder(path.join(relative, name))
      : [path.join(relative, name)];
  });
}

function student(id) {
  return { id, legal_first_name: `First ${id}`, legal_last_name: "Last", guardians: [] };
}

describe("dashboard loading contract", () => {
  it("keeps route-level loading screens out of the dashboard", () => {
    // Each page owns one cold-load placeholder shaped like itself. A route
    // loading.tsx renders first and then gets replaced by the page's own state,
    // which is the stacked, mismatched loading the owner reported.
    const loadingFiles = filesUnder("src/app/(dashboard)").filter((file) =>
      /(^|\/)loading\.(tsx|ts|jsx|js)$/.test(file),
    );
    assert.deepEqual(loadingFiles, []);
  });

  it("leaves the content area quiet while workspace identity loads", () => {
    const skeleton = read("src/components/dashboard-identity-skeleton.tsx");
    assert.doesNotMatch(skeleton, /DashboardLoadingSkeleton|RecordsLoading|OperationsLoading/);
    assert.match(skeleton, /role="status"/);
  });

  it("scopes retained page state to one identity and studio", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    assert.match(
      layout,
      /<RetainedStateProvider\s+scope=\{`\$\{identityGeneration\}:\$\{currentUserId \?\? ""\}:\$\{currentStudioId \?\? ""\}`\}\s*>\s*<DashboardRouteTransition>/,
    );
  });

  it("delays cold-load placeholders, including under reduced motion", () => {
    const css = read("src/app/globals.css");
    assert.match(
      css,
      /\.koaryu-skeleton-reveal \{\s*animation: koaryu-skeleton-reveal [^;]* 220ms both;/,
    );
    assert.match(
      css,
      /prefers-reduced-motion: reduce\) \{\s*\.koaryu-skeleton-reveal\.koaryu-skeleton-reveal \{\s*animation: koaryu-skeleton-reveal 1ms linear 220ms both !important;/,
    );
  });
});

describe("retained store", () => {
  it("returns stored values and forgets deleted keys", () => {
    const store = createRetainedStore("scope-1");
    assert.equal(store.scope, "scope-1");
    assert.equal(store.has("a"), false);
    store.set("a", { rows: [1] });
    assert.deepEqual(store.get("a"), { rows: [1] });
    store.delete("a");
    assert.equal(store.get("a"), undefined);
  });

  it("evicts the least recently written key beyond its limit", () => {
    const store = createRetainedStore("scope-1", 2);
    store.set("a", 1);
    store.set("b", 2);
    store.set("a", 3);
    store.set("c", 4);
    assert.equal(store.has("b"), false);
    assert.equal(store.get("a"), 3);
    assert.equal(store.get("c"), 4);
  });
});

describe("retained student data", () => {
  it("keeps the last roster page and its rows as record seeds", () => {
    const store = createRetainedStore("scope-1");
    const snapshot = {
      queryKey: "query-1",
      page: 2,
      cursor: "cursor-2",
      history: [[1, { pageOrdinal: 1, nextCursor: "cursor-2", previousCursor: null }]],
      students: [student("s1"), student("s2")],
      total: 60,
      hasNext: true,
      hasPrevious: true,
      nextCursor: "cursor-3",
      previousCursor: "cursor-1",
    };
    rememberStudentRosterSnapshot(store, snapshot);
    assert.deepEqual(readStudentRosterSnapshot(store), snapshot);
    assert.equal(readStudentSummary(store, "s2")?.legal_first_name, "First s2");
    assert.equal(readStudentSummary(store, "missing"), undefined);
  });

  it("replaces a summary with the newer row and bounds the summaries", () => {
    const store = createRetainedStore("scope-1");
    rememberStudentSummaries(
      store,
      Array.from({ length: 505 }, (_, index) => student(`s${index}`)),
    );
    assert.equal(readStudentSummary(store, "s0"), undefined);
    assert.ok(readStudentSummary(store, "s504"));
    rememberStudentSummaries(store, [{ ...student("s504"), legal_first_name: "Renamed" }]);
    assert.equal(readStudentSummary(store, "s504")?.legal_first_name, "Renamed");
  });

  it("does nothing without a retained store", () => {
    assert.equal(readStudentRosterSnapshot(null), null);
    assert.equal(readStudentSummary(null, "s1"), undefined);
    rememberStudentSummaries(null, [student("s1")]);
  });
});
