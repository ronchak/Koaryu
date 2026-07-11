import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { NextRequest } from "next/server.js";

import { POST } from "../src/app/api/proxy/[...path]/route.ts";
import {
  CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
  DEFAULT_PROXY_REQUEST_MAX_BYTES,
} from "../src/lib/request-body-limits.ts";

const ORIGINAL_BACKEND_API_URL = process.env.BACKEND_API_URL;
const ORIGINAL_FETCH = globalThis.fetch;

function requestWithStream(path, chunks, headers = {}) {
  return new NextRequest(`https://app.example.test/api/proxy/${path.join("/")}`, {
    method: "POST",
    headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    duplex: "half",
  });
}

async function post(request, path) {
  return POST(request, { params: Promise.resolve({ path }) });
}

describe("Next API proxy request boundaries", () => {
  beforeEach(() => {
    process.env.BACKEND_API_URL = "https://backend.example.test/api/v1";
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_BACKEND_API_URL === undefined) {
      delete process.env.BACKEND_API_URL;
    } else {
      process.env.BACKEND_API_URL = ORIGINAL_BACKEND_API_URL;
    }
  });

  it("forwards raw multipart bytes and the original boundary", async () => {
    const path = ["students", "import", "parse"];
    const boundary = "browser-generated-boundary";
    const bytes = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="students.csv"\r\n` +
      "Content-Type: text/csv\r\n\r\nFirst Name,Last Name\r\nAva,Nguyen\r\n" +
      `--${boundary}--\r\n`
    );
    let forwarded = null;
    globalThis.fetch = async (url, init) => {
      forwarded = { url: String(url), init };
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await post(
      requestWithStream(
        path,
        [bytes.subarray(0, 19), bytes.subarray(19)],
        { "content-type": `multipart/form-data; boundary=${boundary}` }
      ),
      path
    );

    assert.equal(response.status, 200);
    assert.equal(forwarded.url, "https://backend.example.test/api/v1/students/import/parse");
    assert.equal(
      new Headers(forwarded.init.headers).get("content-type"),
      `multipart/form-data; boundary=${boundary}`
    );
    assert.deepEqual(new Uint8Array(forwarded.init.body), bytes);
  });

  it("returns a private normalized 413 for oversized declared bodies without fetching", async () => {
    const path = ["students", "bulk", "status"];
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response();
    };
    const response = await post(
      requestWithStream(path, [new Uint8Array([1])], {
        "content-length": String(DEFAULT_PROXY_REQUEST_MAX_BYTES + 1),
        "content-type": "application/json",
      }),
      path
    );

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { detail: "Request body is too large." });
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.match(response.headers.get("vary"), /Authorization/);
    assert.equal(fetchCalled, false);
  });

  it("returns a private normalized 413 for oversized chunked bodies", async () => {
    const path = ["students", "bulk", "status"];
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response();
    };
    const response = await post(
      requestWithStream(path, [
        new Uint8Array(DEFAULT_PROXY_REQUEST_MAX_BYTES),
        new Uint8Array([1]),
      ], { "content-type": "application/json" }),
      path
    );

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { detail: "Request body is too large." });
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(fetchCalled, false);
  });

  it("selects the larger CSV envelope for the import route", async () => {
    const oversizedForDefault = new Uint8Array(DEFAULT_PROXY_REQUEST_MAX_BYTES + 1);
    let forwardedBytes = 0;
    globalThis.fetch = async (_url, init) => {
      forwardedBytes = init.body.byteLength;
      return new Response(null, { status: 204 });
    };
    const path = ["students", "import", "execute"];

    const response = await post(requestWithStream(path, [oversizedForDefault]), path);

    assert.equal(response.status, 204);
    assert.equal(forwardedBytes, oversizedForDefault.byteLength);
    assert.ok(CSV_IMPORT_PROXY_REQUEST_MAX_BYTES > oversizedForDefault.byteLength);
  });
});
