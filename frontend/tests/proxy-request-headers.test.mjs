import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildUpstreamProxyRequestHeaders } from "../src/lib/proxy-request-headers.ts";

describe("buildUpstreamProxyRequestHeaders", () => {
  it("uses the active-studio cookie instead of a caller-supplied studio header", () => {
    const headers = buildUpstreamProxyRequestHeaders(
      new Headers({
        authorization: "Bearer token",
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": "idem-1",
        "x-studio-id": "caller-controlled-studio",
      }),
      "cookie-studio"
    );

    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("idempotency-key"), "idem-1");
    assert.equal(headers.get("x-studio-id"), "cookie-studio");
  });

  it("does not forward caller-supplied studio headers when the cookie is absent", () => {
    const headers = buildUpstreamProxyRequestHeaders(
      new Headers({
        "x-studio-id": "caller-controlled-studio",
      }),
      null
    );

    assert.equal(headers.get("x-studio-id"), null);
  });

  it("does not force multipart content-type boundaries through the proxy", () => {
    const headers = buildUpstreamProxyRequestHeaders(
      new Headers({
        "content-type": "multipart/form-data; boundary=browser-generated",
      }),
      "cookie-studio"
    );

    assert.equal(headers.get("content-type"), null);
    assert.equal(headers.get("x-studio-id"), "cookie-studio");
  });
});
