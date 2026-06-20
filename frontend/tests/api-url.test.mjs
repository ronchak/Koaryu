import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildApiUrl } from "../src/lib/api-url.ts";

describe("buildApiUrl", () => {
  it("strips api/v1 only for browser proxy calls", () => {
    assert.equal(
      buildApiUrl("/api/v1/students", {
        serverApiBase: "https://api.example.test/api/v1",
        useApiProxy: true,
        isBrowser: true,
      }),
      "/api/proxy/students",
    );
  });

  it("preserves api/v1 paths for direct browser calls", () => {
    assert.equal(
      buildApiUrl("/students", {
        serverApiBase: "https://api.example.test/api/v1",
        useApiProxy: false,
        isBrowser: true,
      }),
      "https://api.example.test/api/v1/students",
    );
  });

  it("keeps server calls pointed at the backend API base", () => {
    assert.equal(
      buildApiUrl("/api/v1/students", {
        serverApiBase: "https://api.example.test",
        useApiProxy: true,
        isBrowser: false,
      }),
      "https://api.example.test/api/v1/students",
    );
  });
});
