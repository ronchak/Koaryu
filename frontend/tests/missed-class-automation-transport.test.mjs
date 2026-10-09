import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { register } from "node:module";

register("./helpers/path-alias-loader.mjs", import.meta.url);
const { api, ApiError, CommandOutcomeUnknown } = await import("../src/lib/api.ts");
const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});

test("PUT uses the existing JSON/auth transport and preserves definite rejection status", async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return new Response('{"detail":"Stale revision"}', {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  };
  await assert.rejects(
    api.put("/automations/missed-class", { expected_revision: 7 }, "synthetic-token"),
    (error) => error instanceof ApiError && error.status === 409,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].headers.Authorization, "Bearer synthetic-token");
  assert.deepEqual(JSON.parse(calls[0].body), { expected_revision: 7 });
});

test("PUT lost response has unknown outcome and is never automatically replayed", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("Synthetic connection loss");
  };
  await assert.rejects(
    api.put("/automations/missed-class", { enabled: false }),
    CommandOutcomeUnknown,
  );
  assert.equal(calls, 1);
});
