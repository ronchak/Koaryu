import assert from "node:assert/strict";
import { test } from "node:test";
import { authErrorMessage } from "../src/lib/auth-error.ts";
import { resolveAuthCallbackNextPath } from "../src/lib/auth-callback.ts";

test("callback errors use fixed recovery messages and ignore untrusted text", () => {
  for (const code of ["callback_failed", "missing_code", "access_denied"]) {
    assert.match(authErrorMessage(code), /sign-in/);
  }
  for (const code of [null, "", "<script>alert(1)</script>", "https://evil.example"]) {
    assert.equal(authErrorMessage(code), null);
  }
});

test("OAuth retains the redirect guard against twelve external destination bypasses", () => {
  for (const path of [
    "//evil.example",
    "/\\evil.example",
    "/%2f%2fevil.example",
    "/%5cevil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "data:text/html,evil",
    "/\t/evil.example",
    "/\r\n/evil.example",
    "/%252f%252fevil.example",
    "///evil.example",
    "https://koaryu.local@evil.example/onboarding",
  ])
    assert.equal(resolveAuthCallbackNextPath(path), "/dashboard", path);
});
