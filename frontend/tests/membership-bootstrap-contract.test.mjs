import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const middlewareSource = source("../src/lib/supabase/middleware.ts");
const proxySource = source("../src/proxy.ts");
const storeSource = source("../src/lib/store.tsx");

describe("archived membership integration contracts", () => {
  it("parses explicit auth membership status and writes it to middleware cache state", () => {
    assert.match(middlewareSource, /parseAuthProfileResponse\(await authMeResponse\.json\(\)\)/);
    assert.match(middlewareSource, /profile\.membership_status/);
    assert.match(middlewareSource, /serializeStudioStateCookie\(userId, hasStudio, membershipStatus\)/);
    assert.match(middlewareSource, /resolveMembershipRoute\(/);
    assert.match(middlewareSource, /clearActiveStudioCookie\(supabaseResponse, request\)/);
  });

  it("limits the new middleware matcher to archived-account routing", () => {
    assert.match(proxySource, /"\/account-archived\/:path\*"/);
    assert.doesNotMatch(proxySource, /"\/reset-password\/:path\*"/);
    assert.doesNotMatch(middlewareSource, /pathname\.startsWith\("\/reset-password"\)/);
  });

  it("refreshes authoritative auth before converging structured archived failures", () => {
    assert.match(storeSource, /isStaffArchivedError\(error\)/);
    assert.match(storeSource, /parseAuthProfileResponse\(response\)/);
    assert.match(storeSource, /applyAuthoritativeNoStudioState\(authProfile, session\.user\)/);
    assert.match(storeSource, /authProfile\.membership_status !== "active"/);
    assert.match(storeSource, /routeForMembershipStatus\(authProfile\.membership_status\)/);
    assert.match(storeSource, /syncStoredStudioSessionCookies\([\s\S]*?authProfile\.membership_status/);
  });
});
