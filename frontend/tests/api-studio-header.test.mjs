import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyBrowserStudioHeader } from "../src/lib/api-studio-header.ts";

describe("applyBrowserStudioHeader", () => {
  it("adds the active studio header for direct browser API calls", () => {
    const headers = applyBrowserStudioHeader(
      { Accept: "application/json" },
      "studio-1",
      { useApiProxy: false }
    );

    assert.equal(headers.Accept, "application/json");
    assert.equal(headers["X-Studio-Id"], "studio-1");
  });

  it("uses the active studio selector instead of an explicit direct API studio header", () => {
    const headers = applyBrowserStudioHeader(
      { "x-studio-id": "explicit-studio" },
      "cookie-studio",
      { useApiProxy: false }
    );

    assert.deepEqual(headers, { "X-Studio-Id": "cookie-studio" });
  });

  it("strips explicit direct API studio headers when no active studio is selected", () => {
    const headers = applyBrowserStudioHeader(
      { "x-studio-id": "explicit-studio" },
      null,
      { useApiProxy: false }
    );

    assert.deepEqual(headers, {});
  });

  it("strips caller-supplied studio headers when browser calls use the Next proxy", () => {
    const headers = applyBrowserStudioHeader(
      {
        Authorization: "Bearer token",
        "X-Studio-Id": "caller-controlled-studio",
      },
      "cookie-studio",
      { useApiProxy: true }
    );

    assert.deepEqual(headers, { Authorization: "Bearer token" });
  });

  it("does not add a studio header when automatic studio selection is omitted", () => {
    const headers = applyBrowserStudioHeader(
      { Accept: "application/json" },
      "studio-1",
      { omitStudioHeader: true }
    );

    assert.deepEqual(headers, { Accept: "application/json" });
  });
});
