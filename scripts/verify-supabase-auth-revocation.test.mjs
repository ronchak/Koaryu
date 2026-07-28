import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyStagingAuthRevocation } from "./verify-supabase-auth-revocation.mjs";

function validEnvironment() {
  return {
    SUPABASE_AUTH_TEST_PROJECT_REF: "nxgsektqsgrtyfhawxbc",
    SUPABASE_AUTH_TEST_URL: "https://nxgsektqsgrtyfhawxbc.supabase.co",
    SUPABASE_AUTH_TEST_ANON_KEY: "deliberate-anon-test-value",
    SUPABASE_AUTH_TEST_SERVICE_ROLE_KEY: "deliberate-service-role-test-value",
    SUPABASE_AUTH_TEST_ACKNOWLEDGE_DISPOSABLE: "true",
  };
}

function token(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function fakeProvider({ allowSecondRefresh = false, createErrorBody = null } = {}) {
  const calls = [];
  let signInCount = 0;
  let refreshCount = 0;
  let deleted = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/admin/users") && options.method === "POST") {
      if (createErrorBody) {
        return new Response(JSON.stringify(createErrorBody), { status: 400 });
      }
      return Response.json({ id: "synthetic-user-id" });
    }
    if (parsed.pathname.endsWith("/token") && parsed.searchParams.get("grant_type") === "password") {
      signInCount += 1;
      return Response.json({
        access_token: token({
          iat: 1_000,
          exp: 4_600,
          session_id: `synthetic-session-${signInCount}`,
        }),
        refresh_token: `synthetic-refresh-${signInCount}`,
      });
    }
    if (parsed.pathname.endsWith("/logout") && options.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (
      parsed.pathname.endsWith("/token")
      && parsed.searchParams.get("grant_type") === "refresh_token"
    ) {
      refreshCount += 1;
      return new Response(null, {
        status: allowSecondRefresh && refreshCount === 2 ? 200 : 400,
      });
    }
    if (parsed.pathname.endsWith("/auth/v1/user")) {
      return Response.json({ id: "synthetic-user-id" });
    }
    if (
      parsed.pathname.endsWith("/admin/users/synthetic-user-id")
      && options.method === "DELETE"
    ) {
      deleted = true;
      return Response.json({});
    }
    if (
      parsed.pathname.endsWith("/admin/users/synthetic-user-id")
      && (options.method ?? "GET") === "GET"
    ) {
      return new Response(null, { status: deleted ? 404 : 200 });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

describe("synthetic staging Auth revocation check", () => {
  it("proves two-session refresh revocation and cleanup without returning user data", async () => {
    const provider = fakeProvider();
    const result = await verifyStagingAuthRevocation({
      env: validEnvironment(),
      fetchImpl: provider.fetchImpl,
      randomBytesImpl: (size) => Buffer.alloc(size, 7),
      now: () => 1_785_207_600_000,
    });

    assert.deepEqual(result, {
      jwtLifetimeSeconds: 3600,
      sessionIdClaimPresent: true,
      refreshTokensRejected: 2,
      accessTokenAcceptedAfterSignOut: true,
      cleanupConfirmed: true,
    });
    assert.equal(
      provider.calls.filter((call) => call.method === "DELETE").length,
      1,
    );
  });

  it("refuses production before making any provider request", async () => {
    const provider = fakeProvider();
    await assert.rejects(
      verifyStagingAuthRevocation({
        env: {
          ...validEnvironment(),
          SUPABASE_AUTH_TEST_PROJECT_REF: "mimguepumzsgmcaycdsh",
          SUPABASE_AUTH_TEST_URL: "https://mimguepumzsgmcaycdsh.supabase.co",
        },
        fetchImpl: provider.fetchImpl,
      }),
      /Refusing.*production/,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("fails when any synthetic refresh token survives and still cleans up", async () => {
    const provider = fakeProvider({ allowSecondRefresh: true });
    await assert.rejects(
      verifyStagingAuthRevocation({
        env: validEnvironment(),
        fetchImpl: provider.fetchImpl,
        randomBytesImpl: (size) => Buffer.alloc(size, 3),
        now: () => 1_785_207_600_000,
      }),
      /did not revoke both synthetic refresh tokens/,
    );
    assert.equal(
      provider.calls.filter((call) => call.method === "DELETE").length,
      1,
    );
  });

  it("does not expose provider response bodies in errors", async () => {
    const provider = fakeProvider({
      createErrorBody: {
        message: "sensitive provider detail",
        email: "synthetic@example.invalid",
      },
    });

    await assert.rejects(
      verifyStagingAuthRevocation({
        env: validEnvironment(),
        fetchImpl: provider.fetchImpl,
      }),
      (error) => {
        assert.match(error.message, /HTTP 400/);
        assert.doesNotMatch(error.message, /sensitive provider detail|synthetic@example/);
        return true;
      },
    );
  });
});
