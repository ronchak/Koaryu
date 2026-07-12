import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dashboardSummaryDataset,
  eligibilityDataset,
  loadIndependentDataset,
  loadedDataset,
  resolvePageDatasetReadiness,
} from "../src/lib/page-dataset-readiness.ts";

describe("page dataset readiness", () => {
  it("commits a required fallback dataset while an unrelated request remains pending", async () => {
    let resolveUnrelated;
    let unrelatedSettled = false;
    const unrelatedLoad = new Promise((resolve) => {
      resolveUnrelated = resolve;
    });
    const commits = [];
    const context = Promise.resolve();

    const required = loadIndependentDataset({
      context,
      fallback: [],
      load: Promise.resolve(["program-1"]),
      onError: () => {},
      onLoaded: (value) => commits.push(value),
    });
    const unrelated = loadIndependentDataset({
      context,
      fallback: [],
      load: unrelatedLoad,
      onError: () => {},
      onLoaded: () => {
        unrelatedSettled = true;
      },
    });

    assert.deepEqual(await required, ["program-1"]);
    assert.deepEqual(commits, [["program-1"]]);
    assert.equal(unrelatedSettled, false);

    resolveUnrelated([]);
    await unrelated;
  });
  it("allows unrelated datasets to remain unsettled when they are not declared", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        loadedDataset({ error: null, label: "Students", loaded: true }),
        loadedDataset({ error: null, label: "Programs", loaded: true }),
      ]),
      { error: null, status: "ready" }
    );
  });

  it("keeps required datasets loading until every one is ready", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        loadedDataset({ error: null, label: "Students", loaded: true }),
        { error: null, label: "Schedule", status: "loading" },
      ]),
      { error: null, status: "loading" }
    );
  });

  it("surfaces a required dataset failure instead of treating empty data as settled", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        { error: "request timed out", label: "Schedule", status: "error" },
      ]),
      { error: "Schedule: request timed out", status: "error" }
    );
  });

  it("requires a live dashboard summary but not a preview summary", () => {
    assert.deepEqual(
      dashboardSummaryDataset({ hasSummary: false, isPreviewMode: false, loaded: false }),
      { error: null, label: "Dashboard summary", status: "loading" }
    );
    assert.equal(
      dashboardSummaryDataset({ hasSummary: false, isPreviewMode: false, loaded: true }).status,
      "error"
    );
    assert.equal(
      dashboardSummaryDataset({ hasSummary: false, isPreviewMode: true, loaded: true }).status,
      "ready"
    );
  });

  it("requires eligibility for the selected ladder without blocking studios that have none", () => {
    assert.equal(eligibilityDataset({
      currentLadderId: null,
      error: null,
      loadedLadderId: null,
      pendingLadderId: null,
    }).status, "ready");
    assert.equal(eligibilityDataset({
      currentLadderId: "ladder-1",
      error: null,
      loadedLadderId: null,
      pendingLadderId: "ladder-1",
    }).status, "loading");
    assert.deepEqual(eligibilityDataset({
      currentLadderId: "ladder-1",
      error: "Eligibility timed out",
      loadedLadderId: null,
      pendingLadderId: null,
    }), {
      error: "Eligibility timed out",
      label: "Belt eligibility",
      status: "error",
    });
  });
});
