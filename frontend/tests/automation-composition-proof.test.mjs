import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext, Script } from "node:vm";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
import {
  bundleWorkflowComposition,
  createCompositionProofFetch,
} from "./helpers/workflow-composition-mounted.mjs";
const actorId = "10000000-0000-4000-8000-000000000001";
const studioId = "20000000-0000-4000-8000-000000000001";
const workflowId = "30000000-0000-4000-8000-000000000001";
const apiUrl = "http://127.0.0.1:49321/api/v1";
const token = "composition-synthetic-token";
function realClient(forward) {
  const { add, modules } = createCommonJsPacker({});
  const id = add("@/lib/api");
  const context = {
    process: { env: { NEXT_PUBLIC_API_URL: apiUrl, NEXT_PUBLIC_USE_API_PROXY: "false" } },
    window: { localStorage: { setItem() {} } },
    document: { cookie: `koaryu-active-studio=${studioId}` },
    fetch: createCompositionProofFetch(apiUrl, forward),
    URL,
    Response,
    Headers,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  return runInNewContext(
    `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}require(${id})`,
    context,
  );
}
test("optional composition bundles the real API and explicit fixture identity without a server", () => {
  const bundle = bundleWorkflowComposition({ proof: { apiUrl, actorId, studioId, token } });
  new Script(bundle);
  assert.ok(bundle.includes('NEXT_PUBLIC_USE_API_PROXY:"false"'));
  assert.ok(bundle.includes(apiUrl));
  assert.ok(bundle.includes("Actual automation API; synthetic Auth and fixture-only pickers"));
  assert.ok(!bundle.includes("Enable synthetic delivery"));
  assert.ok(!bundle.includes("exports.api={get:(path,token)=>window.fixture.read"));
});
test("real client sends owner headers and preserves command body and receipt/current responses", async () => {
  const calls = [];
  const payload = { operation_id: workflowId, test_delivery_id: workflowId, state: "unknown" };
  const client = realClient(async (url, init) => {
    calls.push({ url, init });
    return Response.json(payload);
  });
  const body = { operation_id: workflowId, expected_revision: 2 };
  const response = await client.api.post(`/automations/workflows/${workflowId}/start`, body, token);
  assert.equal(JSON.stringify(response), JSON.stringify(payload));
  assert.equal(calls[0].url, `${apiUrl}/automations/workflows/${workflowId}/start`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers["X-Studio-Id"], studioId);
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  await client.api.get(`/automations/operations/${workflowId}`, token);
  await client.api.get(`/automations/test-deliveries/${workflowId}`, token);
  assert.equal(calls.length, 3);
});
test("real client keeps catalog failure and uncertain command classifications", async () => {
  const client = realClient(async () =>
    Response.json({ detail: "Actual gate unavailable" }, { status: 503 }),
  );
  await assert.rejects(
    client.api.get("/automations/catalog", token),
    (error) =>
      error instanceof client.ApiError &&
      error.status === 503 &&
      error.message === "Actual gate unavailable",
  );
  await assert.rejects(
    client.api.post(`/automations/workflows/${workflowId}/test-email`, {}, token),
    (error) => error instanceof client.CommandOutcomeUnknown,
  );
  const denied = realClient(async () => Response.json({ detail: "Forbidden" }, { status: 403 }));
  await assert.rejects(
    denied.api.post(`/automations/workflows/${workflowId}/start`, {}, token),
    (error) => error instanceof denied.ApiError && error.status === 403,
  );
  const lost = realClient(async () => {
    throw Error("Synthetic lost response");
  });
  await assert.rejects(
    lost.api.put(`/automations/workflows/${workflowId}`, {}, token),
    (error) => error instanceof lost.CommandOutcomeUnknown,
  );
});
test("forwarder preserves response object and refuses unrelated requests", async () => {
  const response = new Response("unchanged", { status: 409, headers: { "X-Request-Id": "proof" } });
  const forward = createCompositionProofFetch(apiUrl, async () => response);
  assert.equal(await forward(`${apiUrl}/automations/catalog`), response);
  for (const url of [
    "https://example.com/api/v1/automations/catalog",
    `${apiUrl}/students`,
    `${apiUrl}/automations/catalog#fragment`,
  ])
    await assert.rejects(forward(url));
  await assert.rejects(forward(`${apiUrl}/automations/catalog`, { method: "DELETE" }));
  const picker = await forward(`${apiUrl}/programs`);
  assert.equal(picker.headers.get("X-Composition-Source"), "fixture-only-picker");
  assert.deepEqual(await picker.json(), []);
  assert.equal(
    (await forward(`${apiUrl}/programs?include_archived=false`)).headers.get(
      "X-Composition-Source",
    ),
    "fixture-only-picker",
  );
  await assert.rejects(forward(`${apiUrl}/programs?unapproved=true`));
  for (const url of [
    "https://127.0.0.1/api/v1",
    "http://example.com/api/v1",
    `${apiUrl}?override=1`,
  ])
    assert.throws(() => createCompositionProofFetch(url, () => {}));
});

test("proof body bound refuses oversized and unsupported bodies before forwarding", async () => {
  let calls = 0;
  const forward = createCompositionProofFetch(apiUrl, async () => {
    calls++;
    return Response.json({});
  });
  for (const body of ["x".repeat(1024 * 1024 + 1), "é".repeat(1024 * 1024), new Uint8Array(2)])
    await assert.rejects(forward(`${apiUrl}/automations/workflows`, { method: "POST", body }));
  assert.equal(calls, 0);
  await forward(`${apiUrl}/automations/workflows`, {
    method: "POST",
    body: "x".repeat(1024 * 1024),
  });
  assert.equal(calls, 1);
});
test("proof verifies the active studio cookie before mount and default fixture stays synthetic", () => {
  const proof = bundleWorkflowComposition({ proof: { apiUrl, actorId, studioId, token } });
  assert.ok(proof.includes("Composition active studio cookie missing before mount"));
  assert.ok(
    proof.indexOf("f.publish();") <
      proof.indexOf("Composition active studio cookie missing before mount"),
  );
  const normal = bundleWorkflowComposition();
  new Script(normal);
  assert.ok(normal.includes("exports.api={get:(path,token)=>window.fixture.read"));
  assert.ok(normal.includes("Enable synthetic delivery"));
  assert.ok(!normal.includes("Composition active studio cookie missing before mount"));
});

test("proof HTML CLI flushes the complete bundle without starting a server", () => {
  const html = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./helpers/workflow-composition-mounted.mjs", import.meta.url)),
      "--proof-html",
    ],
    {
      input: JSON.stringify({ apiUrl, actorId, studioId, token }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.endsWith("</script></body></html>"));
  assert.ok(html.includes("Composition active studio cookie missing before mount"));
});
