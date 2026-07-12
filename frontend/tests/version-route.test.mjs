import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { GET } from "../src/app/api/version/route.ts";
import { getDeploymentMetadata } from "../src/lib/deployment-metadata.ts";

const ORIGINAL_ENV = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
};

function restore(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restore(name, value);
  }
});

describe("deployment version route", () => {
  it("returns normalized safe Vercel deployment metadata without caching", async () => {
    process.env.VERCEL_TARGET_ENV = "Staging";
    process.env.VERCEL_GIT_COMMIT_SHA = "A".repeat(40);

    const response = await GET();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.deepEqual(await response.json(), {
      service: "koaryu-frontend",
      environment: "staging",
      commit_sha: "a".repeat(40),
    });
  });

  it("drops malformed provider metadata instead of reflecting it", () => {
    const metadata = getDeploymentMetadata({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: "secret-bearing-not-a-sha",
      VERCEL_TARGET_ENV: "<unsafe-environment>",
    });

    assert.deepEqual(metadata, {
      service: "koaryu-frontend",
      environment: "preview",
      commit_sha: null,
    });
    assert.doesNotMatch(JSON.stringify(metadata), /secret-bearing|unsafe-environment/);
  });
});
