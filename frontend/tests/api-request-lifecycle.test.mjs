import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createServer } from "node:http";
import { register } from "node:module";

register("./helpers/path-alias-loader.mjs", import.meta.url);
const { api, ApiError } = await import("../src/lib/api.ts");
const nativeFetch = globalThis.fetch;
let server;
let origin;
let handle;
let onHeaders;

before(async () => {
  server = createServer((request, response) => handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { globalThis.fetch = nativeFetch; onHeaders = undefined; });
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

function useServer(handler) {
  handle = handler;
  globalThis.fetch = async (_url, init) => {
    const response = await nativeFetch(origin, init);
    onHeaders?.();
    return response;
  };
}

for (const kind of ["json", "error", "download", "form"]) {
  test(`${kind} stalled body remains subject to the timeout`, { timeout: 3000 }, async () => {
    let receivedHeaders = false;
    onHeaders = () => { receivedHeaders = true; };
    useServer((_request, response) => {
      response.writeHead(kind === "error" ? 503 : 200, { "content-type": "application/json" });
      response.write('{"partial":');
    });
    const options = { timeoutMs: 250, timeoutMessage: "Deadline reached" };
    const work = kind === "download" ? api.download("/test", undefined, options)
      : kind === "form" ? api.postForm("/test", new FormData(), undefined, options)
      : api.get("/test", undefined, options);
    await assert.rejects(work, { message: "Deadline reached" });
    assert.equal(receivedHeaders, true);
  });
}

test("delayed headers time out", async () => {
  useServer(() => {});
  await assert.rejects(api.get("/test", undefined, { timeoutMs: 40 }), /timed out/);
});

for (const phase of ["before fetch", "before headers", "after headers"]) {
  test(`caller cancellation ${phase} stays distinct from timeout`, { timeout: 3000 }, async () => {
    const caller = new AbortController();
    useServer((_request, response) => {
      if (phase === "after headers") response.write("partial");
      else caller.abort();
    });
    if (phase === "before fetch") caller.abort();
    if (phase === "after headers") onHeaders = () => caller.abort();
    await assert.rejects(api.download("/test", undefined, { signal: caller.signal, timeoutMs: 500 }),
      { name: "AbortError", message: "Request was canceled." });
  });
}

test("a legitimate large download completes under its override and releases cancellation", async () => {
  const caller = new AbortController();
  const expected = "x".repeat(512 * 1024);
  useServer((_request, response) => {
    response.writeHead(200, { "content-disposition": 'attachment; filename="students.csv"' });
    response.write(expected.slice(0, 256 * 1024));
    setTimeout(() => response.end(expected.slice(256 * 1024)), 40);
  });
  const result = await api.download("/test", undefined, { signal: caller.signal, timeoutMs: 1000 });
  caller.abort();
  assert.equal(result.filename, "students.csv");
  assert.equal(await result.blob.text(), expected);
});

test("null disables the request timer while retaining cancellation and normal errors", async () => {
  useServer((_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.write('{"detail":');
    setTimeout(() => response.end('"Forbidden"}'), 40);
  });
  await assert.rejects(api.get("/test", undefined, { timeoutMs: null }),
    error => error instanceof ApiError && error.status === 403 && error.message === "Forbidden");
});
