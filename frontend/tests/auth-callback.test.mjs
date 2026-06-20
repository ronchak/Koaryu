import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAuthCallbackNextPath } from "../src/lib/auth-callback.ts";

describe("resolveAuthCallbackNextPath", () => {
  it("defaults missing and external callback redirects to dashboard", () => {
    assert.equal(resolveAuthCallbackNextPath(null), "/dashboard");
    assert.equal(resolveAuthCallbackNextPath("dashboard"), "/dashboard");
    assert.equal(resolveAuthCallbackNextPath("https://evil.example/dashboard"), "/dashboard");
    assert.equal(resolveAuthCallbackNextPath("//evil.example/dashboard"), "/dashboard");
  });

  it("allows expected same-origin auth-flow destinations", () => {
    assert.equal(resolveAuthCallbackNextPath("/dashboard"), "/dashboard");
    assert.equal(resolveAuthCallbackNextPath("/onboarding"), "/onboarding");
    assert.equal(resolveAuthCallbackNextPath("/reset-password"), "/reset-password");
  });

  it("preserves query strings only for allowed destinations", () => {
    assert.equal(resolveAuthCallbackNextPath("/reset-password?source=email"), "/reset-password?source=email");
    assert.equal(resolveAuthCallbackNextPath("/api/proxy/health?source=email"), "/dashboard");
  });
});
