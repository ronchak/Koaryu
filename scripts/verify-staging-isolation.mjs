#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_FRONTEND_HOSTS = new Set(["koaryu.app", "www.koaryu.app"]);
const PRODUCTION_BACKEND_HOST = "koaryu.onrender.com";
const KOARYU_PRODUCTION_REF = "mimguepumzsgmcaycdsh";
const KOARYU_STAGING_REF = "nxgsektqsgrtyfhawxbc";
const KOARYU_STAGING_FRONTEND =
  "https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app";
const KOARYU_STAGING_BACKEND = "https://koaryu-staging.onrender.com/api/v1";

function normalizeUrl(name, value, { requireApiV1 = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`${name} must be a public HTTPS URL.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not include credentials, a query, or a fragment.`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (requireApiV1 && parsed.pathname !== "/api/v1") {
    throw new Error(`${name} must end at /api/v1.`);
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  if (value !== normalized) {
    throw new Error(`${name} must use canonical URL form without a trailing slash.`);
  }
  return normalized;
}

function required(env, name) {
  const rawValue = env[name];
  const value = rawValue?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  if (rawValue !== value) {
    throw new Error(`${name} must not contain surrounding whitespace.`);
  }
  return value;
}

function rejectProductionUrl(name, value) {
  const parsed = new URL(value);
  if (PRODUCTION_FRONTEND_HOSTS.has(parsed.hostname) || parsed.hostname === PRODUCTION_BACKEND_HOST) {
    throw new Error(`${name} resolves to a production destination.`);
  }
}

function requireProjectRef(name, value) {
  if (!/^[a-z0-9]{20}$/.test(value)) {
    throw new Error(`${name} must be a 20-character Supabase project ref.`);
  }
  return value;
}

function requireCredentialShape(name, value, prefix) {
  if (!value.startsWith(prefix)) {
    throw new Error(`${name} must use ${prefix} configuration.`);
  }
  const suffix = value.slice(prefix.length);
  if (suffix.length < 16 || !/^[A-Za-z0-9_]+$/.test(suffix)) {
    throw new Error(`${name} is not structurally complete.`);
  }
  if (/(?:your|placeholder|example|fixture|replace|changeme)/i.test(suffix)) {
    throw new Error(`${name} must not use a placeholder value.`);
  }
}

export function verifyStagingIsolation(env) {
  const expectedStagingRef = requireProjectRef(
    "EXPECTED_STAGING_REF",
    required(env, "EXPECTED_STAGING_REF"),
  );
  const productionRef = requireProjectRef("PRODUCTION_REF", required(env, "PRODUCTION_REF"));
  if (expectedStagingRef !== KOARYU_STAGING_REF) {
    throw new Error("EXPECTED_STAGING_REF does not match Koaryu's pinned staging project.");
  }
  if (productionRef !== KOARYU_PRODUCTION_REF) {
    throw new Error("PRODUCTION_REF does not match Koaryu's pinned production project.");
  }
  if (expectedStagingRef === productionRef) {
    throw new Error("EXPECTED_STAGING_REF must differ from PRODUCTION_REF.");
  }

  const expectedFrontend = normalizeUrl(
    "EXPECTED_STAGING_FRONTEND_ORIGIN",
    required(env, "EXPECTED_STAGING_FRONTEND_ORIGIN"),
  );
  const expectedBackend = normalizeUrl(
    "EXPECTED_STAGING_BACKEND_API",
    required(env, "EXPECTED_STAGING_BACKEND_API"),
    { requireApiV1: true },
  );
  rejectProductionUrl("EXPECTED_STAGING_FRONTEND_ORIGIN", expectedFrontend);
  rejectProductionUrl("EXPECTED_STAGING_BACKEND_API", expectedBackend);
  if (expectedFrontend !== KOARYU_STAGING_FRONTEND) {
    throw new Error("EXPECTED_STAGING_FRONTEND_ORIGIN does not match Koaryu's pinned staging frontend.");
  }
  if (expectedBackend !== KOARYU_STAGING_BACKEND) {
    throw new Error("EXPECTED_STAGING_BACKEND_API does not match Koaryu's pinned staging backend.");
  }

  const configuredUrls = {
    NEXT_PUBLIC_SITE_URL: normalizeUrl(
      "NEXT_PUBLIC_SITE_URL",
      required(env, "NEXT_PUBLIC_SITE_URL"),
    ),
    FRONTEND_URL: normalizeUrl("FRONTEND_URL", required(env, "FRONTEND_URL")),
    NEXT_PUBLIC_API_URL: normalizeUrl(
      "NEXT_PUBLIC_API_URL",
      required(env, "NEXT_PUBLIC_API_URL"),
      { requireApiV1: true },
    ),
    BACKEND_API_URL: normalizeUrl(
      "BACKEND_API_URL",
      required(env, "BACKEND_API_URL"),
      { requireApiV1: true },
    ),
    NEXT_PUBLIC_SUPABASE_URL: normalizeUrl(
      "NEXT_PUBLIC_SUPABASE_URL",
      required(env, "NEXT_PUBLIC_SUPABASE_URL"),
    ),
    SUPABASE_URL: normalizeUrl("SUPABASE_URL", required(env, "SUPABASE_URL")),
    STAGING_PLATFORM_WEBHOOK_DESTINATION: normalizeUrl(
      "STAGING_PLATFORM_WEBHOOK_DESTINATION",
      required(env, "STAGING_PLATFORM_WEBHOOK_DESTINATION"),
    ),
    STAGING_CONNECT_WEBHOOK_DESTINATION: normalizeUrl(
      "STAGING_CONNECT_WEBHOOK_DESTINATION",
      required(env, "STAGING_CONNECT_WEBHOOK_DESTINATION"),
    ),
  };

  for (const [name, value] of Object.entries(configuredUrls)) {
    rejectProductionUrl(name, value);
    if (value.includes(productionRef)) {
      throw new Error(`${name} contains the production Supabase ref.`);
    }
  }

  const expectedSupabase = `https://${expectedStagingRef}.supabase.co`;
  const expectedPlatformWebhook = `${expectedBackend}/webhooks/stripe/platform`;
  const expectedConnectWebhook = `${expectedBackend}/webhooks/stripe/connect`;
  const exactMatches = [
    ["NEXT_PUBLIC_SITE_URL", configuredUrls.NEXT_PUBLIC_SITE_URL, expectedFrontend],
    ["FRONTEND_URL", configuredUrls.FRONTEND_URL, expectedFrontend],
    ["NEXT_PUBLIC_API_URL", configuredUrls.NEXT_PUBLIC_API_URL, expectedBackend],
    ["BACKEND_API_URL", configuredUrls.BACKEND_API_URL, expectedBackend],
    ["NEXT_PUBLIC_SUPABASE_URL", configuredUrls.NEXT_PUBLIC_SUPABASE_URL, expectedSupabase],
    ["SUPABASE_URL", configuredUrls.SUPABASE_URL, expectedSupabase],
    [
      "STAGING_PLATFORM_WEBHOOK_DESTINATION",
      configuredUrls.STAGING_PLATFORM_WEBHOOK_DESTINATION,
      expectedPlatformWebhook,
    ],
    [
      "STAGING_CONNECT_WEBHOOK_DESTINATION",
      configuredUrls.STAGING_CONNECT_WEBHOOK_DESTINATION,
      expectedConnectWebhook,
    ],
  ];
  for (const [name, actual, expected] of exactMatches) {
    if (actual !== expected) {
      throw new Error(`${name} does not match the expected staging destination.`);
    }
  }

  if (required(env, "ENVIRONMENT").toLowerCase() !== "staging") {
    throw new Error("ENVIRONMENT must be staging for the dedicated staging backend.");
  }
  if (required(env, "NEXT_PUBLIC_PREVIEW_MODE").toLowerCase() !== "false") {
    throw new Error("NEXT_PUBLIC_PREVIEW_MODE must be false for application smoke checks.");
  }
  if (required(env, "NEXT_PUBLIC_USE_API_PROXY").toLowerCase() !== "true") {
    throw new Error("NEXT_PUBLIC_USE_API_PROXY must be true for application smoke checks.");
  }
  if (required(env, "NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG").toLowerCase() !== "false") {
    throw new Error("NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG must be false for application smoke checks.");
  }
  if (required(env, "DEMO_RESET_ENABLED").toLowerCase() !== "false") {
    throw new Error("DEMO_RESET_ENABLED must be false during release-gate verification.");
  }
  if ((env.DEMO_RESET_STUDIO_IDS ?? "").trim()) {
    throw new Error("DEMO_RESET_STUDIO_IDS must be empty during release-gate verification.");
  }
  if (required(env, "STRIPE_MODE").toLowerCase() !== "test") {
    throw new Error("STRIPE_MODE must be test for staging release-gate verification.");
  }
  if (required(env, "LIVE_BILLING_ENABLED").toLowerCase() !== "false") {
    throw new Error("LIVE_BILLING_ENABLED must be false for staging release-gate verification.");
  }

  requireCredentialShape(
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    required(env, "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"),
    "pk_test_",
  );
  requireCredentialShape("STRIPE_SECRET_KEY", required(env, "STRIPE_SECRET_KEY"), "sk_test_");
  const restrictedKey = (env.STRIPE_RESTRICTED_KEY ?? "").trim();
  if (restrictedKey) {
    requireCredentialShape("STRIPE_RESTRICTED_KEY", restrictedKey, "rk_test_");
  }
  requireCredentialShape(
    "STRIPE_PLATFORM_WEBHOOK_SECRET",
    required(env, "STRIPE_PLATFORM_WEBHOOK_SECRET"),
    "whsec_",
  );
  const connectSecrets = required(env, "STRIPE_CONNECT_WEBHOOK_SECRET")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (connectSecrets.length === 0) {
    throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET must contain webhook signing secrets.");
  }
  for (const value of connectSecrets) {
    requireCredentialShape("STRIPE_CONNECT_WEBHOOK_SECRET", value, "whsec_");
  }

  return {
    environment: "staging",
    supabaseRef: expectedStagingRef,
    checks: [
      "dedicated origins",
      "staging Supabase ref",
      "explicit test-mode Stripe configuration",
      "platform and Connect webhook destinations",
      "live application mode",
      "server-side API proxy enabled",
      "performance debug disabled",
      "demo reset disabled",
      "production destinations rejected",
    ],
  };
}

function main() {
  try {
    const result = verifyStagingIsolation(process.env);
    console.log(`Staging isolation guard passed (${result.checks.length} checks; no secret values printed).`);
  } catch (error) {
    console.error(`Staging isolation guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
