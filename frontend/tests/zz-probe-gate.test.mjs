import assert from "node:assert/strict";
import { test } from "node:test";

// Disposable probe for the release gate: this failure must block merge.
test("probe: a deliberate failure must block the release candidate gate", () => {
  assert.equal(1, 2);
});
