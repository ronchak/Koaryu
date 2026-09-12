import assert from "node:assert/strict";
import { test } from "node:test";
import { getNavigationDeploymentId } from "../src/lib/deployment-id.ts";

test("navigation IDs fit Vercel and distinguish environment and deployment at the same commit", () => {
  const env = {
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    VERCEL_ENV: "production",
    VERCEL_URL: "first.example.test",
  };
  const id = getNavigationDeploymentId(env);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(getNavigationDeploymentId(env), id);
  assert.notEqual(getNavigationDeploymentId({ ...env, VERCEL_ENV: "preview" }), id);
  assert.notEqual(getNavigationDeploymentId({ ...env, VERCEL_URL: "second.example.test" }), id);
  assert.equal(
    getNavigationDeploymentId({ ...env, NEXT_DEPLOYMENT_ID: "provider-id" }),
    "provider-id",
  );
  assert.equal(getNavigationDeploymentId({}), undefined);
});
