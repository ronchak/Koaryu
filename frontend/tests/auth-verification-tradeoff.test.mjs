import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requestAuthUser } from "../src/lib/auth-user-request.ts";

test("a valid cached JWT is insufficient when the authority rejects the current session", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-rotation-key", alg: "ES256", use: "sig" };
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${encode({ sub: "synthetic-user", aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}`;
  const jwt = `${payload}.${sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  let reads = 0;
  const client = createClient("https://synthetic-auth.example.test", "synthetic-public-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: async url => {
      assert.equal(new URL(url).pathname, "/auth/v1/user");
      reads++;
      return Response.json({ code: "session_not_found", message: "Synthetic session was revoked" }, { status: 401 });
    } },
  });
  const claims = await client.auth.getClaims(jwt, { jwks: { keys: [jwk] } });
  assert.equal(claims.error, null);
  assert.equal(claims.data.claims.sub, "synthetic-user");
  assert.equal(reads, 0, "cached signature verification avoids the authority entirely");
  const user = await requestAuthUser(() => client.auth.getUser(jwt), new AbortController().signal);
  assert.equal(user, null, "the existing page check retains authoritative rejection");
  assert.equal(reads, 1);
});
