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
  validateOperationalAlertCadence,
  validateProviderDeploymentControls,
  validateRenderDockerRuntime,
  validateRenderManifest,
  validateStagingRenderService,
} from "./check-env-examples.mjs";

const reviewedVercelConfig = {
  crons: [
    { path: "/api/cron/account-deletions/process-due", schedule: "0 8 * * *" },
    { path: "/api/cron/operational-alerts/evaluate", schedule: "0 9 * * *" },
  ],
};

const reviewedOperationalAlerts = `
The primary trigger is an external scheduler on the director-operated home server; the committed Vercel cron is a daily 09:00 UTC backup.
This changes the trigger source, not the required five-minute cadence.
The provider-independent external trigger contract is: call \`https://<production-frontend-origin>/api/cron/operational-alerts/evaluate\` every five minutes with method \`GET\`, header \`Authorization: Bearer $CRON_SECRET\`, and a 35-second request timeout. Expect \`204\` while disabled and \`200\` when enabled. No retry may start concurrently with an in-flight evaluation, and scheduler executions must be serialized.
The external scheduler's restricted secret store is an additional custody location for \`CRON_SECRET\` and must be included in every \`CRON_SECRET\` rotation.
Configure the director-operated home server's external scheduler to invoke the trigger every five minutes.
`;

const reviewedReleaseControls = `
The operational-alert evaluator's primary trigger is the director-operated home server's external scheduler at the required five-minute cadence; the committed Vercel cron is a daily 09:00 UTC backup.
This resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence.
Nobody may weaken the five-minute cadence merely to make a preview deploy.
`;

function stagingRenderSource() {
  return `
services:
  - type: web
    name: koaryu-staging
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerContext: .
    healthCheckPath: /health/ready
    autoDeployTrigger: 'off'
    envVars:
      - key: ENVIRONMENT
        value: staging
      - key: STRIPE_MODE
        value: test
      - key: LIVE_BILLING_ENABLED
        value: "false"
      - key: CORE_SELF_CHECKOUT_ENABLED
        value: "false"
      - key: SUPABASE_URL
        value: https://nxgsektqsgrtyfhawxbc.supabase.co
      - key: FRONTEND_URL
        value: https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app
      - key: DEMO_RESET_ENABLED
        value: "false"
`;
}

const reviewedDockerfile = `
FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317
RUN apt-get install --yes --no-install-recommends libjemalloc2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
USER koaryu
CMD ["./scripts/start-render.sh"]
`;

const reviewedRenderStartScript = `
grep -Fq "libjemalloc.so.2" /proc/self/maps
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "\${PORT:-10000}"
`;

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

  it("accepts the jemalloc Docker contract for both Render services", () => {
    const renderSource = `${stagingRenderSource()}
  - type: web
    name: koaryu
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerContext: .
`;
    assert.deepEqual(
      validateRenderDockerRuntime(
        renderSource,
        reviewedDockerfile,
        reviewedRenderStartScript,
      ),
      [],
    );
  });

  it("rejects native runtime drift, inactive arena config, or an unverified preload", () => {
    const renderSource = `${stagingRenderSource()}
  - type: web
    name: koaryu
    runtime: python
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app
    dockerfilePath: wrong/Dockerfile
    dockerContext: backend
    envVars:
      - key: MALLOC_ARENA_MAX
        value: "2"
`;
    const failures = validateRenderDockerRuntime(
      renderSource,
      "FROM python:3.12",
      "exec uvicorn",
    );
    for (const diagnostic of [
      "koaryu runtime",
      "koaryu dockerfilePath",
      "koaryu dockerContext",
      "native-runtime buildCommand",
      "native-runtime startCommand",
      "MALLOC_ARENA_MAX",
      "install libjemalloc2",
      "preload the installed jemalloc library",
      "verify jemalloc is mapped",
    ]) {
      assert.ok(failures.some((failure) => failure.includes(diagnostic)), diagnostic);
    }
  });

  it("rejects unsafe critical Render values even when the example drifts with them", () => {
    const unsafeValues = new Map([
      ["ENVIRONMENT", "development"],
      ["DEMO_RESET_ENABLED", "true"],
      ["DEMO_RESET_STUDIO_IDS", "live-studio-id"],
      ["SUPABASE_ALLOW_LEGACY_HS256", "true"],
      ["SUPABASE_DEVELOPMENT_PROJECT_REF", "production-project"],
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
  - key: SUPABASE_DEVELOPMENT_PROJECT_REF
    value: production-project
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

    for (const key of ["ENVIRONMENT", "DEMO_RESET_ENABLED", "DEMO_RESET_STUDIO_IDS", "SUPABASE_ALLOW_LEGACY_HS256", "SUPABASE_DEVELOPMENT_PROJECT_REF", "API_V1_PREFIX"]) {
      assert.ok(failures.some((failure) => failure.includes(key) && failure.includes("must equal")));
    }
    assert.ok(failures.some((failure) => failure.includes("FRONTEND_URL") && failure.includes("must match")));
  });

  it("accepts only the exact fail-closed example divergence for production live billing", () => {
    const entries = extractRenderEnvEntries(`
envVars:
  - key: LIVE_BILLING_ENABLED
    value: "true"
`);

    assert.deepEqual(validateRenderManifest(
      ["LIVE_BILLING_ENABLED"],
      entries,
      [],
      new Map([["LIVE_BILLING_ENABLED", "false"]]),
    ), []);

    const unsafeExampleFailures = validateRenderManifest(
      ["LIVE_BILLING_ENABLED"],
      entries,
      [],
      new Map([["LIVE_BILLING_ENABLED", "true"]]),
    );
    assert.ok(unsafeExampleFailures.some(
      (failure) => failure.includes("backend/.env.render.example")
        && failure.includes("LIVE_BILLING_ENABLED")
        && failure.includes('must equal "false"'),
    ));
  });

  it("rejects production live billing disabled even when the example stays fail-closed", () => {
    const entries = extractRenderEnvEntries(`
envVars:
  - key: LIVE_BILLING_ENABLED
    value: "false"
`);
    const failures = validateRenderManifest(
      ["LIVE_BILLING_ENABLED"],
      entries,
      [],
      new Map([["LIVE_BILLING_ENABLED", "false"]]),
    );

    assert.ok(failures.some(
      (failure) => failure.includes("LIVE_BILLING_ENABLED")
        && failure.includes('must equal "true"'),
    ));
  });

  it("rejects live billing enabled on the staging Render service", () => {
    const renderSource = `
services:
  - type: web
    name: koaryu-staging
    healthCheckPath: /health/ready
    autoDeployTrigger: 'off'
    envVars:
      - key: ENVIRONMENT
        value: staging
      - key: STRIPE_MODE
        value: test
      - key: LIVE_BILLING_ENABLED
        value: "true"
      - key: CORE_SELF_CHECKOUT_ENABLED
        value: "false"
      - key: SUPABASE_URL
        value: https://nxgsektqsgrtyfhawxbc.supabase.co
      - key: FRONTEND_URL
        value: https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app
      - key: DEMO_RESET_ENABLED
        value: "false"
`;
    const failures = validateStagingRenderService(renderSource, []);

    assert.ok(failures.some(
      (failure) => failure.includes("staging LIVE_BILLING_ENABLED")
        && failure.includes('must equal "false"'),
    ));
  });

  it("requires manual production promotion while preserving staging and cron controls", () => {
    const renderSource = `
services:
  - type: web
    name: koaryu
    healthCheckPath: /health/ready
    autoDeployTrigger: 'off'
`;
    const vercelConfig = {
      git: {
        deploymentEnabled: {
          main: false,
          staging: true,
          "codex/launch-readiness-candidate": false,
        },
      },
      crons: [
        { path: "/api/cron/account-deletions/process-due", schedule: "0 8 * * *" },
        { path: "/api/cron/operational-alerts/evaluate", schedule: "0 9 * * *" },
      ],
    };

    assert.deepEqual(validateProviderDeploymentControls(renderSource, vercelConfig), []);
  });

  it("rejects provider config that can deploy main automatically", () => {
    const unsafeRender = `
services:
  - type: web
    name: koaryu
    healthCheckPath: /health
    autoDeployTrigger: commit
`;
    const unsafeVercel = {
      git: { deploymentEnabled: { main: false, staging: true, "*": true } },
      crons: [],
    };
    const failures = validateProviderDeploymentControls(unsafeRender, unsafeVercel);

    assert.ok(failures.some((failure) => failure.includes("autoDeployTrigger must be off")));
    assert.ok(failures.some((failure) => failure.includes("healthCheckPath must enforce /health/ready")));
    assert.ok(failures.some((failure) => failure.includes("enabled branch pattern \"*\"")));
    assert.ok(failures.some((failure) => failure.includes("cron contract must be preserved")));
  });

  it("rejects drift from the exact operational alert evaluator schedule", () => {
    const renderSource = `
services:
  - type: web
    name: koaryu
    healthCheckPath: /health/ready
    autoDeployTrigger: 'off'
`;
    const vercelConfig = {
      git: {
        deploymentEnabled: {
          main: false,
          staging: true,
          "codex/launch-readiness-candidate": false,
        },
      },
      crons: [
        { path: "/api/cron/account-deletions/process-due", schedule: "0 8 * * *" },
        { path: "/api/cron/operational-alerts/evaluate", schedule: "0 * * * *" },
      ],
    };

    assert.ok(validateProviderDeploymentControls(renderSource, vercelConfig).some(
      (failure) => failure.includes("daily 09:00 UTC"),
    ));
  });

  it("accepts the reviewed external-primary and daily-Vercel-backup contract", () => {
    assert.deepEqual(validateOperationalAlertCadence(
      reviewedVercelConfig,
      reviewedOperationalAlerts,
      reviewedReleaseControls,
    ), []);
  });

  it("rejects an obsolete or otherwise wrong operational-alert Vercel schedule", () => {
    for (const schedule of ["*/5 * * * *", "0 * * * *"]) {
      const vercelConfig = structuredClone(reviewedVercelConfig);
      vercelConfig.crons[1].schedule = schedule;
      const failures = validateOperationalAlertCadence(
        vercelConfig,
        reviewedOperationalAlerts,
        reviewedReleaseControls,
      );
      assert.ok(failures.some((failure) => failure.includes("daily 09:00 UTC")), schedule);
    }
  });

  it("rejects extra and duplicate Vercel crons", () => {
    const extra = structuredClone(reviewedVercelConfig);
    extra.crons.push({ path: "/api/cron/unapproved", schedule: "0 10 * * *" });
    assert.ok(validateOperationalAlertCadence(extra).some(
      (failure) => failure.includes("exactly the two approved entries"),
    ));

    const duplicate = structuredClone(reviewedVercelConfig);
    duplicate.crons[1] = { ...duplicate.crons[0] };
    const failures = validateOperationalAlertCadence(duplicate);
    assert.ok(failures.some((failure) => failure.includes("account-deletion") && failure.includes("exactly once")));
    assert.ok(failures.some((failure) => failure.includes("operational-alert") && failure.includes("exactly once")));
  });

  it("rejects missing external-primary five-minute language", () => {
    const source = reviewedOperationalAlerts
      .replace("The primary trigger is an external scheduler on the director-operated home server", "Vercel is the primary trigger")
      .replace("every five minutes.\n", "every hour.\n");
    const failures = validateOperationalAlertCadence(
      reviewedVercelConfig,
      source,
      reviewedReleaseControls,
    );

    assert.ok(failures.some((failure) => failure.includes("external scheduler as the primary trigger")));
    assert.ok(failures.some((failure) => failure.includes("run every five minutes")));
  });

  it("rejects missing daily 09:00 UTC Vercel backup language", () => {
    const source = reviewedOperationalAlerts.replace(
      "the committed Vercel cron is a daily 09:00 UTC backup",
      "the committed Vercel cron is a frequent primary",
    );
    assert.ok(validateOperationalAlertCadence(
      reviewedVercelConfig,
      source,
      reviewedReleaseControls,
    ).some((failure) => failure.includes("daily 09:00 UTC backup")));
  });

  it("rejects operational documentation that omits the unchanged five-minute cadence", () => {
    const source = reviewedOperationalAlerts.replace(
      "This changes the trigger source, not the required five-minute cadence.",
      "This changes the evaluation cadence.",
    );
    assert.ok(validateOperationalAlertCadence(
      reviewedVercelConfig,
      source,
      reviewedReleaseControls,
    ).some((failure) => failure.includes("without weakening")));
  });

  it("rejects each missing external trigger-contract detail", () => {
    const cases = [
      ["https://<production-frontend-origin>/api/cron/operational-alerts/evaluate", "https://example.test/wrong", "exact external trigger URL"],
      ["method `GET`", "method `POST`", "trigger method"],
      ["Authorization: Bearer $CRON_SECRET", "X-Cron: token", "Authorization"],
      ["Expect `204` while disabled and `200` when enabled", "Expect success", "response expectations"],
      ["35-second request timeout", "60-second request timeout", "35-second"],
      ["No retry may start concurrently with an in-flight evaluation", "Retries may overlap an in-flight evaluation", "forbid retries"],
      ["scheduler executions must be serialized", "scheduler executions may overlap", "serialized"],
    ];

    for (const [contract, drift, diagnostic] of cases) {
      const source = reviewedOperationalAlerts.replace(contract, drift);
      assert.ok(validateOperationalAlertCadence(
        reviewedVercelConfig,
        source,
        reviewedReleaseControls,
      ).some((failure) => failure.includes(diagnostic)), contract);
    }
  });

  it("rejects missing CRON_SECRET custody and rotation language", () => {
    const source = reviewedOperationalAlerts.replace(
      "The external scheduler's restricted secret store is an additional custody location for `CRON_SECRET` and must be included in every `CRON_SECRET` rotation.",
      "Keep scheduler credentials private.",
    );
    assert.ok(validateOperationalAlertCadence(
      reviewedVercelConfig,
      source,
      reviewedReleaseControls,
    ).some((failure) => failure.includes("custody") && failure.includes("rotation")));
  });

  it("rejects stale or missing funded-plan resolution-without-weakening language", () => {
    for (const replacement of [
      "The funded-plan gate remains unresolved.",
      "This resolves the Vercel funded-plan gate by weakening the cadence.",
    ]) {
      const source = reviewedReleaseControls.replace(
        "This resolves the Vercel funded-plan gate by moving the primary trigger source, not by weakening the cadence.",
        replacement,
      );
      assert.ok(validateOperationalAlertCadence(
        reviewedVercelConfig,
        reviewedOperationalAlerts,
        source,
      ).some((failure) => failure.includes("without weakening cadence")));
    }
  });

  it("rejects release-control drift in the primary, backup, or preview warning", () => {
    const cases = [
      ["external scheduler at the required five-minute cadence", "Vercel scheduler at an hourly cadence", "external primary trigger"],
      ["daily 09:00 UTC backup", "hourly primary", "daily 09:00 UTC Vercel backup"],
      ["Nobody may weaken the five-minute cadence merely to make a preview deploy.", "Preview deploys may use a weaker cadence.", "preview-deploy cadence warning"],
    ];

    for (const [contract, drift, diagnostic] of cases) {
      const source = reviewedReleaseControls.replace(contract, drift);
      assert.ok(validateOperationalAlertCadence(
        reviewedVercelConfig,
        reviewedOperationalAlerts,
        source,
      ).some((failure) => failure.includes(diagnostic)), contract);
    }
  });

  it("rejects contradictory stale claims even when the canonical contract remains", () => {
    const operationalFailures = validateOperationalAlertCadence(
      reviewedVercelConfig,
      `${reviewedOperationalAlerts}\nConfirm the Vercel plan supports the committed five-minute cron.`,
      reviewedReleaseControls,
    );
    assert.ok(operationalFailures.some((failure) => failure.includes("open activation gate")));

    const releaseFailures = validateOperationalAlertCadence(
      reviewedVercelConfig,
      reviewedOperationalAlerts,
      `${reviewedReleaseControls}\nThe funded-plan gate remains unresolved. Vercel scheduler is the five-minute primary.`,
    );
    assert.ok(releaseFailures.some((failure) => failure.includes("resolved Vercel funded-plan")));
    assert.ok(releaseFailures.some((failure) => failure.includes("must not identify Vercel as the primary")));
  });
});
