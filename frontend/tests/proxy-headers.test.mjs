import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPrivateProxyHeaders,
  buildPrivateProxyJsonHeaders,
} from "../src/lib/proxy-headers.ts";

describe("buildPrivateProxyHeaders", () => {
  it("preserves download filename metadata while keeping private cache defaults", () => {
    const headers = buildPrivateProxyHeaders(new Headers({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="students.csv"',
      "server-timing": "koaryu_total;dur=12.3",
    }));

    assert.equal(headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(headers.get("content-disposition"), 'attachment; filename="students.csv"');
    assert.equal(headers.get("cache-control"), "no-store, private");
    assert.equal(headers.get("server-timing"), "koaryu_total;dur=12.3");
    assert.equal(headers.get("vary"), "Authorization, Cookie");
  });

  it("does not forward unsafe upstream headers", () => {
    const headers = buildPrivateProxyHeaders(new Headers({
      "set-cookie": "session=secret",
      "location": "https://example.com",
      "x-powered-by": "backend",
      "cache-control": "private, max-age=0",
      "vary": "Accept-Encoding, authorization",
    }));

    assert.equal(headers.get("set-cookie"), null);
    assert.equal(headers.get("location"), null);
    assert.equal(headers.get("x-powered-by"), null);
    assert.equal(headers.get("cache-control"), "no-store, private");
    assert.equal(headers.get("vary"), "Accept-Encoding, authorization, Cookie");
  });

  it("overrides public upstream cache headers for authenticated proxy responses", () => {
    const headers = buildPrivateProxyHeaders(new Headers({
      "content-type": "application/json",
      "cache-control": "public, max-age=3600, stale-while-revalidate=60",
    }));

    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("cache-control"), "no-store, private");
    assert.equal(headers.get("vary"), "Authorization, Cookie");
  });

  it("builds private JSON headers for proxy error responses", () => {
    const headers = buildPrivateProxyJsonHeaders();

    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("cache-control"), "no-store, private");
    assert.equal(headers.get("vary"), "Authorization, Cookie");
  });
});
