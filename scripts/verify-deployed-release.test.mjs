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

function responseFor(url, sha = SHA) {
  if (url.endsWith("/api/version")) {
    return Response.json({
      service: "koaryu-frontend",
      environment: "production",
      commit_sha: sha,
    });
  }
  return Response.json({
    status: "ready",
    version: "1.0.0",
    service: "koaryu-api",
    environment: "production",
    commit_sha: sha,
  });
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
        fetchImpl: async (url) => responseFor(url, "b".repeat(40)),
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
});
