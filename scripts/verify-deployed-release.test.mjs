import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyDeployedRelease } from "./verify-deployed-release.mjs";

const SHA = "a".repeat(40);
const OPTIONS = {
  environment: "production",
  expectedSha: SHA,
  frontendOrigin: "https://koaryu.app",
  backendApi: "https://koaryu.onrender.com/api/v1",
};
const STAGING_OPTIONS = {
  environment: "staging",
  expectedSha: SHA,
  frontendOrigin: "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app",
  backendApi: "https://koaryu-staging.onrender.com/api/v1",
  expectedStripeMode: "test",
};

function responseFor(url, { sha = SHA, environment = "production", configuredStripeMode } = {}) {
  if (url.endsWith("/api/version")) {
    return Response.json({
      service: "koaryu-frontend",
      environment,
      commit_sha: sha,
    });
  }
  const payload = {
    status: "ready",
    version: "1.0.0",
    service: "koaryu-api",
    environment,
    commit_sha: sha,
  };
  if (configuredStripeMode !== undefined) {
    payload.configured_stripe_mode = configuredStripeMode;
  }
  return Response.json(payload);
}

describe("exact-SHA deployed-release verifier", () => {
  it("checks the frontend plus both backend readiness paths", async () => {
    const requests = [];
    const result = await verifyDeployedRelease(OPTIONS, {
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return responseFor(url);
      },
    });

    assert.equal(result.verified, true);
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://koaryu.app/api/version",
      "https://koaryu.onrender.com/health/ready",
      "https://koaryu.onrender.com/api/v1/health/ready",
    ]);
    assert.ok(requests.every(({ init }) => init.method === "GET" && init.redirect === "error"));
  });

  it("rejects an exact-SHA mismatch before reporting evidence", async () => {
    await assert.rejects(
      verifyDeployedRelease(OPTIONS, {
        fetchImpl: async (url) => responseFor(url, { sha: "b".repeat(40) }),
      }),
      /exact expected release identity/,
    );
  });

  it("rejects an unpinned destination", async () => {
    await assert.rejects(
      verifyDeployedRelease({ ...OPTIONS, backendApi: "https://attacker.example/api/v1" }, {
        fetchImpl: async (url) => responseFor(url),
      }),
      /pinned production pair/,
    );
  });

  it("proves both staging readiness payloads report Stripe test mode for the rehearsal", async () => {
    const result = await verifyDeployedRelease(STAGING_OPTIONS, {
      fetchImpl: async (url) => responseFor(url, {
        environment: "staging",
        configuredStripeMode: "test",
      }),
    });

    assert.deepEqual(result.stripe_rehearsal, {
      configured_mode: "test",
      backend_root_mode: "test",
      backend_api_mode: "test",
    });
  });

  it("rejects missing Stripe mode evidence from either backend readiness payload", async () => {
    for (const missingPath of ["/health/ready", "/api/v1/health/ready"]) {
      await assert.rejects(
        verifyDeployedRelease(STAGING_OPTIONS, {
          fetchImpl: async (url) => responseFor(url, {
            environment: "staging",
            configuredStripeMode: url.endsWith(missingPath) ? undefined : "test",
          }),
        }),
        new RegExp(`${missingPath.replaceAll("/", "\\/")} does not report configured Stripe mode test`),
      );
    }
  });

  it("rejects wrong or malformed Stripe mode evidence and non-staging rehearsal requests", async () => {
    for (const configuredStripeMode of ["live", "TEST"]) {
      await assert.rejects(
        verifyDeployedRelease(STAGING_OPTIONS, {
          fetchImpl: async (url) => responseFor(url, { environment: "staging", configuredStripeMode }),
        }),
        /does not report configured Stripe mode test/,
      );
    }
    await assert.rejects(
      verifyDeployedRelease({ ...OPTIONS, expectedStripeMode: "test" }, {
        fetchImpl: async (url) => responseFor(url),
      }),
      /requires the pinned staging pair/,
    );
  });
});
