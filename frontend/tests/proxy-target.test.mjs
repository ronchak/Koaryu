import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProxyTargetUrl, UnsafeProxyPathError } from "../src/lib/proxy-target.ts";

describe("buildProxyTargetUrl", () => {
  it("encodes path segments and preserves the request search string", () => {
    const url = buildProxyTargetUrl(
      "https://api.example.test/api/v1/",
      "https://app.example.test/api/proxy/students/first%20last?limit=10",
      ["students", "first last"],
    );

    assert.equal(url.toString(), "https://api.example.test/api/v1/students/first%20last?limit=10");
  });

  it("does not double-prefix api/v1 paths normalized by the browser API client", () => {
    const browserPath = "/api/v1/students";
    const proxyPath = browserPath.replace(/^\/api\/v1/, "");
    const url = buildProxyTargetUrl(
      "https://api.example.test/api/v1",
      `https://app.example.test/api/proxy${proxyPath}`,
      ["students"],
    );

    assert.equal(url.toString(), "https://api.example.test/api/v1/students");
  });

  it("rejects route-boundary dot segments", () => {
    assert.throws(
      () => buildProxyTargetUrl("https://api.example.test/api/v1", "https://app.example.test/api/proxy/../health", ["..", "health"]),
      UnsafeProxyPathError,
    );
    assert.throws(
      () => buildProxyTargetUrl("https://api.example.test/api/v1", "https://app.example.test/api/proxy/./health", [".", "health"]),
      UnsafeProxyPathError,
    );
  });

  it("rejects segments that already contain path separators", () => {
    assert.throws(
      () => buildProxyTargetUrl("https://api.example.test/api/v1", "https://app.example.test/api/proxy/students", ["students/hidden"]),
      UnsafeProxyPathError,
    );
    assert.throws(
      () => buildProxyTargetUrl("https://api.example.test/api/v1", "https://app.example.test/api/proxy/students", ["students\\hidden"]),
      UnsafeProxyPathError,
    );
  });
});
