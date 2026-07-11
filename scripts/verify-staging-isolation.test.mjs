import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyStagingIsolation } from "./verify-staging-isolation.mjs";

function syntheticCredential(prefix, character) {
  return `${prefix}${character.repeat(24)}`;
}

function validEnvironment() {
  return {
    EXPECTED_STAGING_REF: "nxgsektqsgrtyfhawxbc",
    PRODUCTION_REF: "mimguepumzsgmcaycdsh",
    EXPECTED_STAGING_FRONTEND_ORIGIN:
      "https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app",
    EXPECTED_STAGING_BACKEND_API: "https://koaryu-staging.onrender.com/api/v1",
    NEXT_PUBLIC_SITE_URL:
      "https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app",
    FRONTEND_URL:
      "https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app",
    NEXT_PUBLIC_API_URL: "https://koaryu-staging.onrender.com/api/v1",
    BACKEND_API_URL: "https://koaryu-staging.onrender.com/api/v1",
    NEXT_PUBLIC_SUPABASE_URL: "https://nxgsektqsgrtyfhawxbc.supabase.co",
    SUPABASE_URL: "https://nxgsektqsgrtyfhawxbc.supabase.co",
    STAGING_PLATFORM_WEBHOOK_DESTINATION:
      "https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/platform",
    STAGING_CONNECT_WEBHOOK_DESTINATION:
      "https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/connect",
    ENVIRONMENT: "staging",
    NEXT_PUBLIC_PREVIEW_MODE: "false",
    DEMO_RESET_ENABLED: "false",
    DEMO_RESET_STUDIO_IDS: "",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: syntheticCredential("pk_test_", "A"),
    STRIPE_SECRET_KEY: syntheticCredential("sk_test_", "B"),
    STRIPE_RESTRICTED_KEY: syntheticCredential("rk_test_", "C"),
    STRIPE_PLATFORM_WEBHOOK_SECRET: syntheticCredential("whsec_", "D"),
    STRIPE_CONNECT_WEBHOOK_SECRET: [
      syntheticCredential("whsec_", "E"),
      syntheticCredential("whsec_", "F"),
    ].join(","),
  };
}

describe("staging isolation guard", () => {
  it("accepts an exact isolated staging configuration", () => {
    const result = verifyStagingIsolation(validEnvironment());
    assert.equal(result.environment, "staging");
    assert.equal(result.checks.length, 7);
  });

  for (const [name, value] of [
    ["NEXT_PUBLIC_SITE_URL", "https://koaryu.app"],
    ["FRONTEND_URL", "https://www.koaryu.app"],
    ["NEXT_PUBLIC_API_URL", "https://koaryu.onrender.com/api/v1"],
    ["BACKEND_API_URL", "https://koaryu.onrender.com/api/v1"],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://mimguepumzsgmcaycdsh.supabase.co"],
    ["SUPABASE_URL", "https://mimguepumzsgmcaycdsh.supabase.co"],
  ]) {
    it(`rejects a production destination in ${name}`, () => {
      assert.throws(
        () => verifyStagingIsolation({ ...validEnvironment(), [name]: value }),
        /production|expected staging destination/,
      );
    });
  }

  it("cannot bless production through caller-controlled project refs", () => {
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        EXPECTED_STAGING_REF: "mimguepumzsgmcaycdsh",
        PRODUCTION_REF: "mimguepumzsgmcaycdsi",
        NEXT_PUBLIC_SUPABASE_URL: "https://mimguepumzsgmcaycdsh.supabase.co",
        SUPABASE_URL: "https://mimguepumzsgmcaycdsh.supabase.co",
      }),
      /pinned staging project/,
    );
  });

  it("rejects malformed project refs", () => {
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        EXPECTED_STAGING_REF: "nxgsektqsgrtyfhawxbc/path",
      }),
      /20-character Supabase project ref/,
    );
  });

  for (const [name, value] of [
    ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_live_deliberate_fixture"],
    ["STRIPE_SECRET_KEY", "sk_live_deliberate_fixture"],
    ["STRIPE_RESTRICTED_KEY", "rk_live_deliberate_fixture"],
  ]) {
    it(`rejects live Stripe configuration in ${name}`, () => {
      assert.throws(() => verifyStagingIsolation({ ...validEnvironment(), [name]: value }), /test_/);
    });
  }

  it("requires both exact staging webhook destinations", () => {
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        STAGING_CONNECT_WEBHOOK_DESTINATION:
          "https://unrelated-staging.onrender.com/api/v1/webhooks/stripe/connect",
      }),
      /expected staging destination/,
    );
  });

  it("rejects preview/demo shortcuts during application smoke verification", () => {
    assert.throws(
      () => verifyStagingIsolation({ ...validEnvironment(), NEXT_PUBLIC_PREVIEW_MODE: "true" }),
      /PREVIEW_MODE/,
    );
    assert.throws(
      () => verifyStagingIsolation({ ...validEnvironment(), DEMO_RESET_ENABLED: "true" }),
      /DEMO_RESET_ENABLED/,
    );
    assert.throws(
      () => verifyStagingIsolation({ ...validEnvironment(), DEMO_RESET_STUDIO_IDS: "fixture" }),
      /DEMO_RESET_STUDIO_IDS/,
    );
  });

  it("rejects a trailing slash that would break exact CORS origin matching", () => {
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        FRONTEND_URL:
          "https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app/",
      }),
      /canonical URL form/,
    );
  });

  it("rejects surrounding whitespace that would break exact CORS origin matching", () => {
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        FRONTEND_URL:
          " https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app ",
      }),
      /surrounding whitespace/,
    );
  });

  it("rejects incomplete and placeholder Stripe credentials", () => {
    for (const [name, value] of [
      ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_"],
      ["STRIPE_SECRET_KEY", "sk_test_your_key_goes_here"],
      ["STRIPE_PLATFORM_WEBHOOK_SECRET", "whsec_"],
      ["STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_deliberate_fixture_value"],
    ]) {
      assert.throws(
        () => verifyStagingIsolation({ ...validEnvironment(), [name]: value }),
        /structurally complete|placeholder value/,
      );
    }
  });

  it("rejects malformed or ambiguous URLs", () => {
    assert.throws(
      () => verifyStagingIsolation({ ...validEnvironment(), BACKEND_API_URL: "http://localhost:8001/api/v1" }),
      /public HTTPS URL/,
    );
    assert.throws(
      () => verifyStagingIsolation({
        ...validEnvironment(),
        EXPECTED_STAGING_BACKEND_API: "https://koaryu-staging.onrender.com/api/v1?target=staging",
      }),
      /query/,
    );
  });
});
