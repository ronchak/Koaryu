import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const actionSource = source("../src/lib/store-studio-actions.ts");
const typesSource = source("../src/types/index.ts");
const legalNameAction = actionSource.slice(
  actionSource.indexOf("  const updateUserLegalName"),
  actionSource.indexOf("  const resetDemoData")
);

describe("current-user legal-name action contract", () => {
  it("exports the generated legal-name request and response aliases", () => {
    assert.match(typesSource, /export type StaffLegalNameUpdate = ApiContracts\.ApiStaffLegalNameUpdate;/);
    assert.match(typesSource, /export type StaffLegalNameResponse = ApiContracts\.ApiStaffLegalNameResponse;/);
  });

  it("requires identity before the live request and uses the exact endpoint, payload, and coordinator token", () => {
    assert.match(
      legalNameAction,
      /if \(!activeUserId\) \{[\s\S]*?throw new Error\("Current user identity is required\."\);[\s\S]*?\}\n\n    const payload: StaffLegalNameUpdate = \{/
    );
    assert.match(
      legalNameAction,
      /api\.patch<StaffLegalNameResponse>\(\s*`\/staff\/\$\{activeUserId\}\/legal-name`,\s*payload,\s*liveRequest\.token\s*\)/
    );
    assert.match(legalNameAction, /legal_first_name: firstName/);
    assert.match(legalNameAction, /legal_last_name: lastName/);
    assert.match(legalNameAction, /if \(!liveRequest\.isCurrent\(\)\) \{[\s\S]*?return;/);
  });

  it("commits normalized legal names to the current user and matching roster row only", () => {
    assert.match(
      legalNameAction,
      /setCurrentUser\(\(current\) => current && current\.id === response\.user_id[\s\S]*?legal_first_name: response\.legal_first_name,[\s\S]*?legal_last_name: response\.legal_last_name/
    );
    assert.match(legalNameAction, /setStaffProfilesAvailable\(true\);/);
    assert.match(
      legalNameAction,
      /setStaffMembers\(\(current\) => current\.map\(\(member\) =>[\s\S]*?member\.user_id === response\.user_id[\s\S]*?legal_first_name: response\.legal_first_name,[\s\S]*?legal_last_name: response\.legal_last_name/
    );
    assert.match(legalNameAction, /if \(isPreviewMode\) \{[\s\S]*?setCurrentUser[\s\S]*?setStaffMembers[\s\S]*?return;/);
    assert.doesNotMatch(legalNameAction, /full_name|supabase/);
  });
});
