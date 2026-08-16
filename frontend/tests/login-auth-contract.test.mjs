import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/(auth)/login/page.tsx", import.meta.url),
  "utf8"
);

describe("password login membership routing contract", () => {
  it("parses explicit AuthResponse membership state and synchronizes the committed session cookies", () => {
    assert.match(pageSource, /parseAuthProfileResponse\(await api\.get<unknown>\([\s\S]*"\/auth\/me"/);
    assert.match(pageSource, /syncStoredStudioSessionCookies\(/);
    assert.match(pageSource, /authProfile\.membership_status/);
    assert.match(pageSource, /authProfile\.studio_id/);
    assert.match(pageSource, /ACCOUNT_ARCHIVED_ROUTE/);
    assert.match(pageSource, /authProfile\.membership_status === "active"/);
    assert.match(pageSource, /: "\/onboarding"/);
  });
});
