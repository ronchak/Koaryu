import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEnvKeys,
  extractBackendSettingsKeys,
  extractRenderEnvEntries,
  extractFrontendRuntimeEnvKeys,
  extractRenderEnvKeys,
  isPlaceholderValue,
  isSecretLikeKey,
  parseEnvText,
  validateEnvExample,
  validateProviderDeploymentControls,
  validateRenderManifest,
} from "./check-env-examples.mjs";

describe("environment example validation", () => {
  it("accepts deliberate placeholders and rejects real-looking secrets", () => {
    assert.equal(isPlaceholderValue("sk_test_your_key"), true);
    assert.equal(isPlaceholderValue("whsec_your_first,whsec_your_second"), true);
    assert.equal(isPlaceholderValue("provider-real-looking-production-value"), false);
    assert.equal(isPlaceholderValue("webhook-real-looking-production-value"), false);
    assert.equal(isPlaceholderValue("whsec_your_first,provider-real-looking-production-value"), false);
    assert.equal(isPlaceholderValue("provider_yourRealLookingValue"), false);
    assert.equal(isSecretLikeKey("NEW_SIGNING_KEY"), true);
    assert.equal(isSecretLikeKey("DATABASE_URL"), true);
    assert.equal(isSecretLikeKey("DATABASE_POOLER_URL"), true);
    assert.equal(isSecretLikeKey("REDIS_TLS_URL"), true);
    assert.equal(isSecretLikeKey("SUPABASE_POSTGRES_URL"), true);
    assert.equal(isSecretLikeKey("PRIMARY_DB_CONNECTION_STRING"), true);
    assert.equal(isSecretLikeKey("NEXT_PUBLIC_API_URL"), false);
  });

  it("fails closed when a discovered environment key has no deliberate classification", () => {
    const classification = classifyEnvKeys(
      ["FRONTEND_URL", "NEW_SIGNING_KEY", "OPAQUE_HANDLE", "MYSTERY_VALUE"],
      ["FRONTEND_URL"],
      ["OPAQUE_HANDLE"],
    );

    assert.deepEqual(classification.secretKeys, ["NEW_SIGNING_KEY", "OPAQUE_HANDLE"]);
    assert.deepEqual(classification.unclassifiedKeys, ["MYSTERY_VALUE"]);
    assert.deepEqual(classification.conflictingKeys, []);

    const conflicts = classifyEnvKeys(
      ["PUBLIC_SIGNING_KEY", "OPAQUE_HANDLE"],
      ["PUBLIC_SIGNING_KEY", "OPAQUE_HANDLE"],
      ["OPAQUE_HANDLE"],
    );
    assert.deepEqual(conflicts.conflictingKeys, ["OPAQUE_HANDLE", "PUBLIC_SIGNING_KEY"]);
  });

  it("reports malformed, duplicate, missing, blank, and non-placeholder secret entries", () => {
    const parsed = parseEnvText(
      "example.env",
      "GOOD=\nBAD KEY=value\nSECRET=real-production-value\nSECRET=second-value\n",
    );
    const failures = validateEnvExample(
      {
        path: "example.env",
        requiredKeys: ["GOOD", "MISSING", "SECRET"],
        placeholderKeys: ["SECRET"],
      },
      parsed,
    );

    assert.ok(failures.some((failure) => failure.includes("duplicate key(s): SECRET")));
    assert.ok(failures.some((failure) => failure.includes("invalid key name(s): BAD KEY")));
    assert.ok(failures.some((failure) => failure.includes("missing required key(s): MISSING")));
    assert.ok(failures.some((failure) => failure.includes("blank required key(s): GOOD")));
    assert.ok(failures.some((failure) => failure.includes("placeholder-only: SECRET")));
  });

  it("extracts backend, Render, and frontend runtime contracts", () => {
    assert.deepEqual(
      extractBackendSettingsKeys("class Settings:\n    API_URL: str = \"\"\n    ENABLED: bool = False\n"),
      ["API_URL", "ENABLED"],
    );
    assert.deepEqual(
      extractRenderEnvKeys("envVars:\n  - key: API_URL\n  - key: ENABLED\n"),
      ["API_URL", "ENABLED"],
    );
    assert.deepEqual(
      extractFrontendRuntimeEnvKeys(
        "process.env.NEXT_PUBLIC_API_URL; process.env['BACKEND_API_URL']; const { CRON_SECRET, NODE_ENV: mode } = process.env;",
      ),
      ["BACKEND_API_URL", "CRON_SECRET", "NEXT_PUBLIC_API_URL"],
    );
  });

  it("rejects duplicate Render keys and literal or synced deployment secrets", () => {
    const entries = extractRenderEnvEntries(`
services:
  - type: web
    envVars:
      - key: API_URL
        value: https://example.com
      - key: API_SECRET
        sync: false
      - key: API_SECRET
        value: literal-secret
`);
    const failures = validateRenderManifest(
      ["API_URL", "API_SECRET"],
      entries,
      ["API_SECRET"],
    );

    assert.ok(failures.some((failure) => failure.includes("duplicate key(s): API_SECRET")));
    assert.ok(failures.some((failure) => failure.includes("must use sync: false")));
    assert.ok(failures.some((failure) => failure.includes("must not contain a literal value")));
  });

  it("rejects unsafe critical Render values even when the example drifts with them", () => {
    const unsafeValues = new Map([
      ["ENVIRONMENT", "development"],
      ["DEMO_RESET_ENABLED", "true"],
      ["DEMO_RESET_STUDIO_IDS", "live-studio-id"],
      ["SUPABASE_ALLOW_LEGACY_HS256", "true"],
      ["API_V1_PREFIX", "/api"],
      ["FRONTEND_URL", "https://koaryu.dev"],
    ]);
    const entries = extractRenderEnvEntries(`
envVars:
  - key: ENVIRONMENT
    value: development
  - key: DEMO_RESET_ENABLED
    value: "true"
  - key: DEMO_RESET_STUDIO_IDS
    value: live-studio-id
  - key: SUPABASE_ALLOW_LEGACY_HS256
    value: "true"
  - key: API_V1_PREFIX
    value: /api
  - key: FRONTEND_URL
    value: https://koaryu.test
`);
    const failures = validateRenderManifest(
      [...unsafeValues.keys()],
      entries,
      [],
      unsafeValues,
    );

    for (const key of ["ENVIRONMENT", "DEMO_RESET_ENABLED", "DEMO_RESET_STUDIO_IDS", "SUPABASE_ALLOW_LEGACY_HS256", "API_V1_PREFIX"]) {
      assert.ok(failures.some((failure) => failure.includes(key) && failure.includes("must equal")));
    }
    assert.ok(failures.some((failure) => failure.includes("FRONTEND_URL") && failure.includes("must match")));
  });

  it("requires manual production promotion while preserving staging and cron controls", () => {
    const renderSource = `
services:
  - type: web
    name: koaryu
    healthCheckPath: /health
    autoDeployTrigger: 'off'
`;
    const vercelConfig = {
      git: { deploymentEnabled: { main: false, staging: true } },
      crons: [{ path: "/api/cron/account-deletions/process-due", schedule: "0 8 * * *" }],
    };

    assert.deepEqual(validateProviderDeploymentControls(renderSource, vercelConfig), []);
  });

  it("rejects provider config that can deploy main automatically", () => {
    const unsafeRender = `
services:
  - type: web
    name: koaryu
    healthCheckPath: /health/live
    autoDeployTrigger: commit
`;
    const unsafeVercel = {
      git: { deploymentEnabled: { main: false, staging: true, "*": true } },
      crons: [],
    };
    const failures = validateProviderDeploymentControls(unsafeRender, unsafeVercel);

    assert.ok(failures.some((failure) => failure.includes("autoDeployTrigger must be off")));
    assert.ok(failures.some((failure) => failure.includes("bootstrap healthCheckPath must remain /health")));
    assert.ok(failures.some((failure) => failure.includes("enabled branch pattern \"*\"")));
    assert.ok(failures.some((failure) => failure.includes("cron contract must be preserved")));
  });
});
