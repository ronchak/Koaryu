import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadedDataset, resolvePageDatasetReadiness } from "../src/lib/page-dataset-readiness.ts";

describe("page dataset readiness", () => {
  it("allows unrelated datasets to remain unsettled when they are not declared", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        loadedDataset({ error: null, label: "Students", loaded: true }),
        loadedDataset({ error: null, label: "Programs", loaded: true }),
      ]),
      { error: null, status: "ready" },
    );
  });

  it("keeps required datasets loading until every one is ready", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        loadedDataset({ error: null, label: "Students", loaded: true }),
        { error: null, label: "Schedule", status: "loading" },
      ]),
      { error: null, status: "loading" },
    );
  });

  it("surfaces a required dataset failure instead of treating empty data as settled", () => {
    assert.deepEqual(
      resolvePageDatasetReadiness([
        { error: "request timed out", label: "Schedule", status: "error" },
      ]),
      { error: "Schedule: request timed out", status: "error" },
    );
  });
});
