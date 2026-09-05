import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchProxyUpstream, ProxyUpstreamTimeoutError } from "../src/lib/proxy-upstream.ts";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
const target = new URL("http://127.0.0.1:8001/api/v1/test");

function stalledResponse() {
  let canceled = false;
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial")); },
      cancel() { canceled = true; },
    }));
  };
  return { get canceled() { return canceled; }, get signal() { return signal; } };
}

test("deadline cancels a stalled response body after partial streaming", async () => {
  const upstream = stalledResponse();
  const response = await fetchProxyUpstream(target, {}, new AbortController().signal, 30);
  // Keep the test alive independently of the unref'd server deadline.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(response.text(), ProxyUpstreamTimeoutError);
    assert.equal(upstream.signal.aborted, true);
    assert.equal(upstream.canceled, true);
  } finally { clearTimeout(keepAlive); }
});

test("caller cancellation after headers cancels upstream and fails the body", async () => {
  const upstream = stalledResponse();
  const caller = new AbortController();
  const response = await fetchProxyUpstream(target, {}, caller.signal);
  caller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
  assert.equal(upstream.signal.aborted, true);
  assert.equal(upstream.canceled, true);
});

test("consumer cancellation aborts the upstream request", async () => {
  const upstream = stalledResponse();
  const response = await fetchProxyUpstream(target, {}, new AbortController().signal);
  await response.body.cancel();
  assert.equal(upstream.signal.aborted, true);
  assert.equal(upstream.canceled, true);
});

test("finished body releases caller cancellation", async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response("complete");
  };
  const caller = new AbortController();
  const response = await fetchProxyUpstream(target, {}, caller.signal);
  assert.equal(await response.text(), "complete");
  caller.abort();
  assert.equal(signal.aborted, false);
});

test("deadline before headers aborts fetch with the specific timeout", async () => {
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(fetchProxyUpstream(target, {}, new AbortController().signal, 20), ProxyUpstreamTimeoutError);
  } finally { clearTimeout(keepAlive); }
});
