import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedRequestCategory, sanitizeVisibleMarks, validateFunctionalCapture } from "../scripts/performance-capture-policy.mjs";
const policy = { frontendOrigin: "https://frontend.invalid", backendOrigin: "https://backend.invalid", supabaseOrigin: "https://auth.invalid", allowedOrigins: new Set(["https://frontend.invalid", "https://backend.invalid", "https://auth.invalid"]) };
const check = (path, method = "GET", functional = false, origin = policy.backendOrigin) => blockedRequestCategory({ url: origin + path, method }, { ...policy, functional });
test("read-only capture blocks provider-refresh GETs as well as writes and unknown origins", () => {
  assert.equal(check("/api/v1/billing/system/status"), "provider_refresh_reads");
  assert.equal(check("/api/proxy/billing/landing"), "provider_refresh_reads");
  assert.equal(check("/api/v1/schedule/window/materialize", "POST"), "write_methods");
  assert.equal(check("/dashboard", "GET", false, "https://unknown.invalid"), "unknown_origins");
  assert.equal(check("/api/v1/dashboard/summary"), null);
});
test("disposable functional mode permits only exact refresh/materialization POST destinations", () => {
  assert.equal(check("/api/v1/schedule/window/materialize", "POST", true), null);
  assert.equal(check("/auth/v1/token?grant_type=refresh_token", "POST", true, policy.supabaseOrigin), null);
  assert.equal(check("/auth/v1/token?grant_type=password", "POST", true, policy.supabaseOrigin), "write_methods");
  assert.equal(check("/auth/v1/token?grant_type=refresh_token", "POST", true), "write_methods");
  assert.equal(check("/api/v1/schedule/window/materialize/extra", "POST", true), "write_methods");
  assert.equal(check("/api/v1/billing/connect/sync", "POST", true), "write_methods");
  assert.throws(() => validateFunctionalCapture({ environment: "production", disposableData: true }), /production is unsupported/);
  assert.throws(() => validateFunctionalCapture({ environment: "staging" }), /disposable-data/);
  assert.doesNotThrow(() => validateFunctionalCapture({ environment: "staging", disposableData: true }));
});
test("visible mark sanitation drops unknown routes and identifiers, retaining numeric generations only", () => {
  const entry = { name: "koaryu.visible.useful", startTime: 12, detail: { route: "billing", identity_generation: 2, navigation_generation: 3, user_id: "private", url: "private" } };
  assert.deepEqual(sanitizeVisibleMarks([entry], "billing"), [{ stage: "useful", route: "billing", identity_generation: 2, navigation_generation: 3, at_ms: 12 }]);
  assert.deepEqual(sanitizeVisibleMarks([{ ...entry, detail: { ...entry.detail, route: "private" } }], "billing"), []);
});
