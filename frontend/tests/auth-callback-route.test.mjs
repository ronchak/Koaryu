import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { resolveAuthCallbackNextPath } from "../src/lib/auth-callback.ts";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const source = ts.transpileModule(
  readFileSync(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

async function callback(query, failed = false) {
  const calls = [];
  const exports = {};
  const dependencies = {
    "next/server": { NextResponse },
    "@/lib/auth-callback": { resolveAuthCallbackNextPath },
    "@supabase/ssr": {
      createServerClient: (_url, _key, { cookies }) => ({
        auth: {
          exchangeCodeForSession: async (code) => {
            calls.push(code);
            cookies.setAll([{ name: "pkce", value: "", options: { maxAge: 0 } }], {
              "Cache-Control": "private, no-store",
              Pragma: "no-cache",
            });
            cookies.setAll([{ name: "session", value: "synthetic", options: { httpOnly: true } }], {
              "Cache-Control": "private, no-store",
            });
            return { error: failed ? new Error("private provider detail") : null };
          },
        },
      }),
    },
  };
  new Function("require", "exports", source)((name) => dependencies[name], exports);
  const response = await exports.GET(
    new NextRequest(`https://studio.example/auth/callback${query}`),
  );
  return { response, calls };
}

test("PKCE success preserves every cookie update and private cache headers for login and recovery", async () => {
  for (const next of ["/dashboard", "/onboarding", "/reset-password?source=email"]) {
    const { response, calls } = await callback(`?code=synthetic&next=${encodeURIComponent(next)}`);
    assert.deepEqual(calls, ["synthetic"]);
    assert.equal(response.headers.get("location"), `https://studio.example${next}`);
    assert.equal(response.cookies.get("session").value, "synthetic");
    assert.equal(response.cookies.get("pkce").value, "");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
  }
});

test("exchange failures retain PKCE cleanup and return a fixed error", async () => {
  const { response } = await callback("?code=expired", true);
  assert.equal(
    response.headers.get("location"),
    "https://studio.example/login?error=callback_failed",
  );
  assert.equal(response.cookies.get("pkce").value, "");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("missing code and denied consent never exchange a code or reflect provider text", async () => {
  for (const [query, code] of [
    ["", "missing_code"],
    ["?error=access_denied&code=ignored", "access_denied"],
    ["?error=untrusted&error_description=secret", "callback_failed"],
  ]) {
    const { response, calls } = await callback(query);
    assert.deepEqual(calls, []);
    assert.equal(response.headers.get("location"), `https://studio.example/login?error=${code}`);
  }
});
