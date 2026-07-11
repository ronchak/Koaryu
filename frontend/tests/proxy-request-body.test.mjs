import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CSV_IMPORT_MAX_BYTES,
  CSV_IMPORT_MAPPING_JSON_MAX_BYTES,
  CSV_IMPORT_MAX_CELL_CHARS,
  CSV_IMPORT_MAX_COLUMNS,
  CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES,
  CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
  DEFAULT_PROXY_REQUEST_MAX_BYTES,
  STUDENT_PHOTO_MAX_BYTES,
  STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES,
} from "../src/lib/request-body-limits.ts";
import {
  getProxyRequestBodyLimit,
  getProxyRequestBodyError,
  InvalidProxyContentLengthError,
  ProxyRequestBodyTooLargeError,
  readBoundedProxyRequestBody,
} from "../src/lib/proxy-request-body.ts";

function streamedRequest(chunks, headers = {}) {
  return new Request("https://app.example.test/api/proxy/students", {
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

describe("bounded proxy request bodies", () => {
  it("uses product upload limits plus bounded multipart overhead", () => {
    assert.equal(
      getProxyRequestBodyLimit(["students", "import", "execute"]),
      CSV_IMPORT_PROXY_REQUEST_MAX_BYTES
    );
    assert.equal(
      getProxyRequestBodyLimit(["students", "student-1", "photo"]),
      STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES
    );
    assert.equal(getProxyRequestBodyLimit(["students", "bulk", "status"]), DEFAULT_PROXY_REQUEST_MAX_BYTES);
    assert.ok(CSV_IMPORT_PROXY_REQUEST_MAX_BYTES > CSV_IMPORT_MAX_BYTES);
    assert.equal(
      CSV_IMPORT_PROXY_REQUEST_MAX_BYTES,
      CSV_IMPORT_MAX_BYTES +
        CSV_IMPORT_MAX_COLUMNS * CSV_IMPORT_MAX_CELL_CHARS * 6 +
        CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES
    );
    assert.equal(
      CSV_IMPORT_MAPPING_JSON_MAX_BYTES,
      CSV_IMPORT_MAX_COLUMNS * CSV_IMPORT_MAX_CELL_CHARS * 6
    );
    assert.ok(STUDENT_PHOTO_PROXY_REQUEST_MAX_BYTES > STUDENT_PHOTO_MAX_BYTES);
  });

  it("preserves valid multipart bytes exactly instead of parsing and reserializing", async () => {
    const boundary = "browser-generated-boundary";
    const multipart = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="students.csv"\r\n` +
      "Content-Type: text/csv\r\n\r\nFirst Name,Last Name\r\nAva,Nguyen\r\n" +
      `--${boundary}--\r\n`
    );
    const request = streamedRequest(
      [multipart.subarray(0, 31), multipart.subarray(31)],
      { "content-type": `multipart/form-data; boundary=${boundary}` }
    );

    const body = await readBoundedProxyRequestBody(request, CSV_IMPORT_PROXY_REQUEST_MAX_BYTES);

    assert.deepEqual(new Uint8Array(body), multipart);
  });

  it("rejects an oversized Content-Length before consuming the stream", async () => {
    let bodyAccessCount = 0;
    const request = {
      headers: new Headers({
        "content-length": String(DEFAULT_PROXY_REQUEST_MAX_BYTES + 1),
      }),
      get body() {
        bodyAccessCount += 1;
        throw new Error("The body should not be accessed.");
      },
    };

    await assert.rejects(
      readBoundedProxyRequestBody(request, DEFAULT_PROXY_REQUEST_MAX_BYTES),
      ProxyRequestBodyTooLargeError
    );
    assert.equal(bodyAccessCount, 0);
  });

  it("rejects an oversized chunked body without relying on Content-Length", async () => {
    const request = streamedRequest([
      new Uint8Array(DEFAULT_PROXY_REQUEST_MAX_BYTES),
      new Uint8Array([1]),
    ]);

    await assert.rejects(
      readBoundedProxyRequestBody(request, DEFAULT_PROXY_REQUEST_MAX_BYTES),
      ProxyRequestBodyTooLargeError
    );
  });

  it("maps boundary failures to minimal safe proxy errors", async () => {
    assert.deepEqual(
      getProxyRequestBodyError(new ProxyRequestBodyTooLargeError()),
      { status: 413, detail: "Request body is too large." }
    );
    assert.deepEqual(
      getProxyRequestBodyError(new InvalidProxyContentLengthError()),
      { status: 400, detail: "Invalid Content-Length header." }
    );
    assert.equal(getProxyRequestBodyError(new Error("upstream detail")), null);

    await assert.rejects(
      readBoundedProxyRequestBody(
        { body: null, headers: new Headers({ "content-length": "not-a-number" }) },
        DEFAULT_PROXY_REQUEST_MAX_BYTES
      ),
      InvalidProxyContentLengthError
    );
  });
});
