import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");
const result = { exports: {} };
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
new Function("require", "module", "exports", compiled)(
  () => ({ updateSession() {} }),
  result,
  result.exports,
);
const config = result.exports.config;
const paths = [
  "/login",
  "/signup",
  "/onboarding",
  "/account-archived",
  "/subscription-required",
  "/dashboard",
  "/students",
  "/leads",
  "/schedule",
  "/belt-tracker",
  "/reports",
  "/settings",
  "/billing",
  "/automations",
  "/account",
  "/help",
];
const matches = (url, headers = {}) =>
  unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers });

test("all protected paths skip marked prefetches while documents and plain RSC navigations still run proxy", () => {
  assert.deepEqual(
    config.matcher.map((entry) => entry.source.replace("/:path*", "")),
    paths,
  );
  for (const path of [...paths, "/students/student-1", "/billing/connect/refresh"]) {
    assert.equal(matches(path), true, path);
    assert.equal(matches(`${path}?_rsc=synthetic`, { rsc: "1" }), true, path);
    assert.equal(
      matches(`${path}?_rsc=synthetic`, { rsc: "1", "next-router-prefetch": "1" }),
      false,
      path,
    );
  }
  for (const path of ["/", "/api/proxy/billing/landing", "/_next/static/test.js", "/privacy"])
    assert.equal(matches(path), false, path);
});
