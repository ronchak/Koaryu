import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildContentSecurityPolicy,
  resolveOrigin,
  securityHeaders,
  securityHeadersFromProcessEnv,
} from "../src/lib/security-headers.ts";

const PRODUCTION = {
  supabaseUrl: "https://mimguepumzsgmcaycdsh.supabase.co",
  apiUrl: "https://koaryu.onrender.com/api/v1",
  siteUrl: "https://koaryu.app",
  nodeEnv: "production",
  vercelEnv: "production",
};

function directive(policy, name) {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ? found.slice(name.length).trim() : null;
}

describe("resolveOrigin", () => {
  it("reduces a URL with a path to its origin", () => {
    assert.equal(
      resolveOrigin("https://koaryu.onrender.com/api/v1"),
      "https://koaryu.onrender.com",
    );
  });

  it("drops values that are not parseable http(s) URLs", () => {
    for (const value of [null, undefined, "", "   ", "not a url", "javascript:alert(1)", "ftp://x.test"]) {
      assert.equal(resolveOrigin(value), null, `expected ${String(value)} to be dropped`);
    }
  });
});

describe("buildContentSecurityPolicy", () => {
  it("allows the configured Supabase and backend origins to be reached", () => {
    const connect = directive(buildContentSecurityPolicy(PRODUCTION), "connect-src");
    assert.match(connect, /'self'/);
    assert.match(connect, /https:\/\/mimguepumzsgmcaycdsh\.supabase\.co/);
    assert.match(connect, /https:\/\/koaryu\.onrender\.com/);
  });

  it("allows student photos from Supabase storage plus blob and data previews", () => {
    const img = directive(buildContentSecurityPolicy(PRODUCTION), "img-src");
    assert.match(img, /https:\/\/mimguepumzsgmcaycdsh\.supabase\.co/);
    assert.match(img, /blob:/);
    assert.match(img, /data:/);
  });

  it("locks down the directives that carry no legitimate source", () => {
    const policy = buildContentSecurityPolicy(PRODUCTION);
    assert.equal(directive(policy, "object-src"), "'none'");
    assert.equal(directive(policy, "frame-ancestors"), "'none'");
    assert.equal(directive(policy, "frame-src"), "'none'");
    assert.equal(directive(policy, "worker-src"), "'none'");
    assert.equal(directive(policy, "media-src"), "'none'");
    assert.equal(directive(policy, "base-uri"), "'self'");
    assert.equal(directive(policy, "form-action"), "'self'");
  });

  it("keeps unsafe-eval and the dev websocket out of production", () => {
    const policy = buildContentSecurityPolicy(PRODUCTION);
    assert.doesNotMatch(policy, /unsafe-eval/);
    assert.doesNotMatch(policy, /ws:/);
    assert.match(policy, /upgrade-insecure-requests/);
  });

  it("grants unsafe-eval and localhost only in development", () => {
    const policy = buildContentSecurityPolicy({ ...PRODUCTION, nodeEnv: "development" });
    assert.match(directive(policy, "script-src"), /'unsafe-eval'/);
    assert.match(directive(policy, "connect-src"), /ws:/);
    // http would be rewritten to https and break local dev.
    assert.doesNotMatch(policy, /upgrade-insecure-requests/);
  });

  it("admits the Vercel toolbar only on preview deployments", () => {
    const preview = buildContentSecurityPolicy({ ...PRODUCTION, vercelEnv: "preview" });
    assert.match(directive(preview, "frame-src"), /https:\/\/vercel\.live/);
    assert.match(directive(preview, "connect-src"), /wss:\/\/ws-us3\.pusher\.com/);

    const production = buildContentSecurityPolicy(PRODUCTION);
    assert.doesNotMatch(production, /vercel\.live/);
    assert.doesNotMatch(production, /pusher\.com/);
  });

  it("omits origins it cannot parse rather than interpolating them", () => {
    const policy = buildContentSecurityPolicy({
      ...PRODUCTION,
      supabaseUrl: "not a url",
      apiUrl: undefined,
    });
    assert.equal(directive(policy, "connect-src"), "'self'");
    assert.equal(directive(policy, "img-src"), "'self' data: blob:");
    assert.doesNotMatch(policy, /undefined|not a url/);
  });

  it("omits upgrade-insecure-requests when a configured origin is plaintext", () => {
    const policy = buildContentSecurityPolicy({
      ...PRODUCTION,
      apiUrl: "http://127.0.0.1:8001/api/v1",
    });
    assert.doesNotMatch(policy, /upgrade-insecure-requests/);
  });

  it("routes violations to the collector", () => {
    assert.match(buildContentSecurityPolicy(PRODUCTION), /report-uri \/api\/csp-report/);
  });
});

describe("securityHeaders", () => {
  it("ships the policy in report-only mode", () => {
    const keys = securityHeaders(PRODUCTION).map((header) => header.key);
    assert.ok(keys.includes("Content-Security-Policy-Report-Only"));
    assert.ok(!keys.includes("Content-Security-Policy"));
  });

  it("covers the baseline headers the external assessment found missing", () => {
    const headers = new Map(securityHeaders(PRODUCTION).map((h) => [h.key, h.value]));
    assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.match(headers.get("Permissions-Policy"), /camera=\(\)/);
    assert.equal(
      headers.get("Strict-Transport-Security"),
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("narrows the wildcard CORS header to the site origin", () => {
    const headers = new Map(securityHeaders(PRODUCTION).map((h) => [h.key, h.value]));
    assert.equal(headers.get("Access-Control-Allow-Origin"), "https://koaryu.app");
    assert.notEqual(headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("falls back to the canonical origin when the site URL is unusable", () => {
    const headers = new Map(
      securityHeaders({ ...PRODUCTION, siteUrl: "" }).map((h) => [h.key, h.value]),
    );
    assert.equal(headers.get("Access-Control-Allow-Origin"), "https://koaryu.app");
  });
});

describe("securityHeadersFromProcessEnv", () => {
  it("reads the public env vars the deployment already defines", () => {
    const headers = new Map(
      securityHeadersFromProcessEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_API_URL: "https://api.example.test/api/v1",
        NEXT_PUBLIC_SITE_URL: "https://site.example.test",
        NODE_ENV: "production",
      }).map((h) => [h.key, h.value]),
    );

    assert.equal(headers.get("Access-Control-Allow-Origin"), "https://site.example.test");
    const connect = directive(headers.get("Content-Security-Policy-Report-Only"), "connect-src");
    assert.match(connect, /https:\/\/example\.supabase\.co/);
    assert.match(connect, /https:\/\/api\.example\.test/);
  });
});
