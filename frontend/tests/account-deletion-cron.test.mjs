import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { GET } from "../src/app/api/cron/account-deletions/process-due/route.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "ACCOUNT_DELETION_WORKER_SECRET",
  "BACKEND_API_URL",
  "CRON_SECRET",
  "NEXT_PUBLIC_API_URL",
  "OPERATIONAL_ALERTS_ENABLED",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_HOST",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256",
  "OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const DEADMAN_URL = "https://deadman.example.com/deletion-worker";

function request(secret = "cron-secret") {
  return new Request(
    "https://staging.example.test/api/cron/account-deletions/process-due",
    { headers: { authorization: `Bearer ${secret}` } },
  );
}

describe("account deletion cron backend binding", () => {
  beforeEach(() => {
    process.env.ACCOUNT_DELETION_WORKER_SECRET = "W".repeat(40);
    process.env.BACKEND_API_URL = "https://koaryu-staging.onrender.com/api/v1";
    delete process.env.NEXT_PUBLIC_API_URL;
    process.env.CRON_SECRET = "cron-secret";
    process.env.OPERATIONAL_ALERTS_ENABLED = "false";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL = DEADMAN_URL;
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "deadman.example.com";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_URL_SHA256 = createHash("sha256")
      .update(DEADMAN_URL)
      .digest("hex");
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_BEARER_SECRET = "D".repeat(40);
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.VERCEL_TARGET_ENV = "staging";
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("rejects arbitrary, ambiguous, and non-exact URLs without forwarding the credential", async (context) => {
    const rejectedTargets = [
      "https://attacker.example.test/api/v1",
      "https://user:password@koaryu-staging.onrender.com/api/v1",
      " https://koaryu-staging.onrender.com/api/v1",
      "https://koaryu-staging.onrender.com/api/v1\n",
      "https://koaryu-staging.onrender.com/api/v1/",
      "https://koaryu-staging.onrender.com/api/v1/../credential-sink",
      "https://koaryu-staging.оnrender.com/api/v1",
      "http://localhost:8001/api/v1",
    ];

    for (const target of rejectedTargets) {
      await context.test(target.replaceAll("\n", "\\n"), async () => {
        process.env.BACKEND_API_URL = target;
        let fetched = false;
        globalThis.fetch = async () => {
          fetched = true;
          return Response.json({ processed: 0 });
        };

        const response = await GET(request());

        assert.equal(response.status, 500);
        assert.equal(fetched, false);
      });
    }
  });

  it("rejects every cross-environment target without forwarding the credential", async (context) => {
    const crossEnvironmentTargets = [
      ["staging", "https://koaryu.onrender.com/api/v1"],
      ["production", "https://koaryu-staging.onrender.com/api/v1"],
      ["development", "https://koaryu-staging.onrender.com/api/v1"],
      ["test", "https://koaryu.onrender.com/api/v1"],
    ];

    for (const [environment, target] of crossEnvironmentTargets) {
      await context.test(`${environment} -> ${target}`, async () => {
        process.env.VERCEL_TARGET_ENV = environment;
        process.env.BACKEND_API_URL = target;
        let capturedSecret;
        globalThis.fetch = async (_url, init) => {
          capturedSecret = init?.headers?.["x-internal-secret"];
          return Response.json({ processed: 0 });
        };

        const response = await GET(request());

        assert.equal(response.status, 500);
        assert.equal(capturedSecret, undefined);
      });
    }
  });

  it("validates the backend target before reading worker-secret configuration", async () => {
    process.env.BACKEND_API_URL = "https://attacker.example.test/api/v1";
    delete process.env.ACCOUNT_DELETION_WORKER_SECRET;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return Response.json({ processed: 0 });
    };

    const response = await GET(request());

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { detail: "Backend API URL is not configured." });
    assert.equal(fetched, false);
  });

  it("uses the exact staging target with redirects disabled", async () => {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return Response.json({ processed: 0 });
    };

    const response = await GET(request());

    assert.equal(response.status, 200);
    assert.equal(
      captured.url,
      "https://koaryu-staging.onrender.com/api/v1/internal/account-deletions/process-due",
    );
    assert.equal(captured.init.headers["x-internal-secret"], "W".repeat(40));
    assert.equal(captured.init.redirect, "error");
    assert.ok(captured.init.signal instanceof AbortSignal);
    assert.equal(captured.init.headers.Authorization, undefined);
    assert.equal(captured.init.headers.authorization, undefined);
  });

  it("does not replay credentials when the exact backend responds with a redirect", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://attacker.example.test/")) {
        return Response.json({ processed: 0 });
      }
      if (init?.redirect === "error") {
        throw new TypeError("redirect blocked");
      }
      return globalThis.fetch("https://attacker.example.test/credential-sink", init);
    };

    const response = await GET(request());

    assert.equal(response.status, 502);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://koaryu-staging.onrender.com/api/v1/internal/account-deletions/process-due",
    );
    assert.equal(calls[0].init.redirect, "error");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(calls[0].init.headers["x-internal-secret"], "W".repeat(40));
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  it("preflights dead-man configuration before worker invocation", async () => {
    process.env.OPERATIONAL_ALERTS_ENABLED = "true";
    process.env.OPERATIONAL_ALERT_DELETION_DEADMAN_HOST = "other.example.com";
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return Response.json({ processed: 0 });
    };

    const response = await GET(request());

    assert.equal(response.status, 500);
    assert.equal(fetched, false);
  });
});
