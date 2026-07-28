#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_REF = "mimguepumzsgmcaycdsh";
const STAGING_REF = "nxgsektqsgrtyfhawxbc";
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateTarget(env) {
  const projectRef = required(env, "SUPABASE_AUTH_TEST_PROJECT_REF");
  const url = required(env, "SUPABASE_AUTH_TEST_URL").replace(/\/+$/, "");
  if (projectRef === PRODUCTION_REF || url.includes(PRODUCTION_REF)) {
    throw new Error("Refusing to run the synthetic Auth test against production");
  }
  if (projectRef !== STAGING_REF || url !== STAGING_URL) {
    throw new Error("Synthetic Auth test target must match Koaryu's pinned staging project");
  }
  if (required(env, "SUPABASE_AUTH_TEST_ACKNOWLEDGE_DISPOSABLE") !== "true") {
    throw new Error("SUPABASE_AUTH_TEST_ACKNOWLEDGE_DISPOSABLE must equal true");
  }
  return {
    url,
    anonKey: required(env, "SUPABASE_AUTH_TEST_ANON_KEY"),
    serviceRoleKey: required(env, "SUPABASE_AUTH_TEST_SERVICE_ROLE_KEY"),
  };
}

function requestHeaders(apiKey, accessToken = apiKey) {
  return {
    Accept: "application/json",
    apikey: apiKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

async function jsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function sessionFromResponse(payload, label) {
  const accessToken = payload?.access_token;
  const refreshToken = payload?.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error(`${label} did not return a complete session`);
  }
  return { accessToken, refreshToken };
}

function decodeJwtEvidence(accessToken) {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Synthetic access token is not a JWT");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Synthetic access token payload is invalid");
  }
  const issuedAt = payload?.iat;
  const expiresAt = payload?.exp;
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new Error("Synthetic access token lacks a valid lifetime");
  }
  return {
    jwtLifetimeSeconds: expiresAt - issuedAt,
    sessionIdClaimPresent:
      typeof payload?.session_id === "string" && payload.session_id.length > 0,
  };
}

async function signIn(fetchImpl, target, email, password, label) {
  const response = await fetchImpl(`${target.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: requestHeaders(target.anonKey),
    body: JSON.stringify({ email, password }),
  });
  return sessionFromResponse(await jsonResponse(response, label), label);
}

async function refreshIsRejected(fetchImpl, target, refreshToken) {
  const response = await fetchImpl(
    `${target.url}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: requestHeaders(target.anonKey),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  return response.status === 400 || response.status === 401;
}

async function cleanupSyntheticUser(fetchImpl, target, userId) {
  const deleteResponse = await fetchImpl(`${target.url}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: requestHeaders(target.serviceRoleKey),
  });
  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(`synthetic Auth cleanup failed with HTTP ${deleteResponse.status}`);
  }
  const verifyResponse = await fetchImpl(`${target.url}/auth/v1/admin/users/${userId}`, {
    method: "GET",
    headers: requestHeaders(target.serviceRoleKey),
  });
  if (verifyResponse.status !== 404) {
    throw new Error(`synthetic Auth cleanup verification failed with HTTP ${verifyResponse.status}`);
  }
}

export async function verifyStagingAuthRevocation({
  env = process.env,
  fetchImpl = fetch,
  randomBytesImpl = randomBytes,
  now = Date.now,
} = {}) {
  const target = validateTarget(env);
  const nonce = randomBytesImpl(18).toString("hex");
  const email = `koaryu-auth-control-${now()}-${nonce}@example.invalid`;
  const password = `Koa!${randomBytesImpl(32).toString("base64url")}9z`;
  let userId = null;
  let result;
  let primaryError = null;

  try {
    const createResponse = await fetchImpl(`${target.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: requestHeaders(target.serviceRoleKey),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
      }),
    });
    const created = await jsonResponse(createResponse, "synthetic Auth user creation");
    userId = created?.user?.id ?? created?.id;
    if (typeof userId !== "string" || !userId) {
      throw new Error("synthetic Auth user creation returned no user identifier");
    }

    const [firstSession, secondSession] = await Promise.all([
      signIn(fetchImpl, target, email, password, "first synthetic sign-in"),
      signIn(fetchImpl, target, email, password, "second synthetic sign-in"),
    ]);
    const jwtEvidence = decodeJwtEvidence(firstSession.accessToken);
    if (!jwtEvidence.sessionIdClaimPresent) {
      throw new Error("synthetic access token lacks the session_id claim");
    }

    const signOutResponse = await fetchImpl(`${target.url}/auth/v1/logout?scope=global`, {
      method: "POST",
      headers: requestHeaders(target.anonKey, firstSession.accessToken),
    });
    if (!signOutResponse.ok) {
      throw new Error(`synthetic global sign-out failed with HTTP ${signOutResponse.status}`);
    }

    const [firstRefreshRejected, secondRefreshRejected, accessProbe] = await Promise.all([
      refreshIsRejected(fetchImpl, target, firstSession.refreshToken),
      refreshIsRejected(fetchImpl, target, secondSession.refreshToken),
      fetchImpl(`${target.url}/auth/v1/user`, {
        method: "GET",
        headers: requestHeaders(target.anonKey, firstSession.accessToken),
      }),
    ]);
    if (!firstRefreshRejected || !secondRefreshRejected) {
      throw new Error("global sign-out did not revoke both synthetic refresh tokens");
    }

    result = {
      jwtLifetimeSeconds: jwtEvidence.jwtLifetimeSeconds,
      sessionIdClaimPresent: true,
      refreshTokensRejected: 2,
      accessTokenAcceptedAfterSignOut: accessProbe.ok,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }

  let cleanupError = null;
  if (userId) {
    try {
      await cleanupSyntheticUser(fetchImpl, target, userId);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (cleanupError) {
    throw new Error(
      primaryError
        ? `${primaryError.message}; ${cleanupError.message}`
        : cleanupError.message,
    );
  }
  if (primaryError) {
    throw primaryError;
  }
  if (!result || !userId) {
    throw new Error("synthetic Auth test produced no result");
  }
  return { ...result, cleanupConfirmed: true };
}

async function main() {
  try {
    const result = await verifyStagingAuthRevocation();
    const accessBehavior = result.accessTokenAcceptedAfterSignOut
      ? "remained valid until expiry"
      : "was rejected before expiry";
    console.log(
      [
        "Synthetic staging Auth revocation check passed",
        `(two sessions; global sign-out; ${result.refreshTokensRejected} refresh tokens rejected;`,
        `access token ${accessBehavior}; JWT lifetime ${result.jwtLifetimeSeconds}s;`,
        "session_id present; cleanup confirmed; no user data printed).",
      ].join(" "),
    );
    return 0;
  } catch (error) {
    console.error(
      `Synthetic staging Auth revocation check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  process.exitCode = await main();
}
