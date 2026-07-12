import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { refreshLiveLeadDataset } from "../src/lib/store-lead-refresh-model.ts";

const lead = { id: "lead-1", first_name: "Ari", last_name: "Lane", status: "new" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function leadRefreshHarness({ current = true, loaded = true, error = "Previous error" } = {}) {
  const request = deferred();
  const state = { committed: null, current, error, loaded };
  const refresh = refreshLiveLeadDataset({
    beginLiveAuthRequest: () => ({
      token: "token-1",
      isCurrent: () => state.current,
    }),
    fetchLeads: () => request.promise,
    setLeads: (leads) => {
      state.committed = leads;
    },
    setLeadsLoaded: (nextLoaded) => {
      state.loaded = nextLoaded;
    },
    setLeadsLoadError: (nextError) => {
      state.error = nextError;
    },
  });
  return { refresh, request, state };
}

describe("live lead dataset refresh", () => {
  it("preserves authoritative readiness when auth supersedes an in-flight refresh", async () => {
    const harness = leadRefreshHarness();

    assert.equal(harness.state.loaded, true);
    assert.equal(harness.state.error, null);

    harness.state.current = false;
    harness.state.error = "Auth state changed";
    harness.request.resolve([lead]);
    assert.deepEqual(await harness.refresh, [lead]);
    assert.equal(harness.state.loaded, true);
    assert.equal(harness.state.committed, null);
    assert.equal(harness.state.error, "Auth state changed");
  });

  it("marks an initial current refresh ready only after committing its payload", async () => {
    const harness = leadRefreshHarness({ loaded: false, error: null });

    assert.equal(harness.state.loaded, false);
    harness.request.resolve([lead]);
    assert.deepEqual(await harness.refresh, [lead]);
    assert.equal(harness.state.loaded, true);
    assert.deepEqual(harness.state.committed, [lead]);
    assert.equal(harness.state.error, null);
  });

  it("records only current refresh failures", async () => {
    const harness = leadRefreshHarness({ loaded: true });
    harness.request.reject(new Error("Lead service unavailable"));

    await assert.rejects(harness.refresh, /Lead service unavailable/);
    assert.equal(harness.state.loaded, false);
    assert.equal(harness.state.error, "Lead service unavailable");
  });

  it("does not let a superseded failure overwrite readiness or errors", async () => {
    const harness = leadRefreshHarness({ loaded: true });
    harness.state.current = false;
    harness.state.error = "Auth state changed";
    harness.request.reject(new Error("Old token failed"));

    await assert.rejects(harness.refresh, /Old token failed/);
    assert.equal(harness.state.loaded, true);
    assert.equal(harness.state.error, "Auth state changed");
    assert.equal(harness.state.committed, null);
  });
});
