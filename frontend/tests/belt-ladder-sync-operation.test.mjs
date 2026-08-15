import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearPendingBeltLadderSync,
  isTerminalBeltLadderSyncError,
  loadPendingBeltLadderSync,
  persistPendingBeltLadderSync,
} from "../src/lib/belt-ladder-sync-operation.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("belt ladder sync operation receipts", () => {
  const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  it("restores and clears the same studio-scoped operation after a remount", () => {
    const storage = memoryStorage();
    const pending = {
      fingerprint: "payload-a",
      request: {
        operation_id: "11111111-1111-4111-8111-111111111111",
        sub_rank_term: "Stripe",
        ranks: [],
      },
    };

    persistPendingBeltLadderSync("studio-1", "ladder-1", pending, storage);
    assert.deepEqual(
      loadPendingBeltLadderSync("studio-1", "ladder-1", storage),
      pending,
    );
    assert.equal(loadPendingBeltLadderSync("studio-2", "ladder-1", storage), null);

    clearPendingBeltLadderSync("studio-1", "ladder-1", storage);
    assert.equal(loadPendingBeltLadderSync("studio-1", "ladder-1", storage), null);
  });

  it("clears deterministic client errors but retains ambiguous outcomes", () => {
    assert.equal(isTerminalBeltLadderSyncError(apiError(400)), true);
    assert.equal(isTerminalBeltLadderSyncError(apiError(409)), true);
    assert.equal(isTerminalBeltLadderSyncError(apiError(408)), false);
    assert.equal(isTerminalBeltLadderSyncError(apiError(429)), false);
    assert.equal(isTerminalBeltLadderSyncError(apiError(500)), false);
    assert.equal(isTerminalBeltLadderSyncError(new Error("network")), false);
  });

  it("discards malformed persisted operations", () => {
    const storage = memoryStorage();
    storage.setItem(
      "koaryu:pending-belt-sync:studio-1:ladder-1",
      JSON.stringify({ fingerprint: "payload-a", request: { operation_id: "op" } }),
    );
    assert.equal(loadPendingBeltLadderSync("studio-1", "ladder-1", storage), null);
  });
});
