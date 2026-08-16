import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const actionSource = source("../src/lib/store-staff-actions.ts");
const legalNameAction = actionSource.slice(
  actionSource.indexOf("  const updateStaffLegalName"),
  actionSource.indexOf("  const updateStaffRole")
);

describe("staff legal-name action contract", () => {
  it("normalizes invite data before sending the exact staff invite payload", () => {
    assert.match(actionSource, /const payload = normalizeStaffInvite\(data\);/);
    assert.match(
      actionSource,
      /api\.post<StaffMember>\("\/staff\/invitations", payload, liveRequest\.token\)/
    );
    assert.doesNotMatch(actionSource, /api\.post<StaffMember>\("\/staff\/invitations", data,/);
  });

  it("targets another member by user id with the exact endpoint, payload, and live coordinator", () => {
    assert.match(legalNameAction, /const payload: StaffLegalNameUpdate = \{/);
    assert.match(legalNameAction, /legal_first_name: firstName/);
    assert.match(legalNameAction, /legal_last_name: lastName/);
    assert.match(legalNameAction, /const liveRequest = beginLiveAuthRequest\(\);/);
    assert.match(
      legalNameAction,
      /api\.patch<StaffLegalNameResponse>\(\s*`\/staff\/\$\{userId\}\/legal-name`,\s*payload,\s*liveRequest\.token\s*\)/
    );
    assert.doesNotMatch(legalNameAction, /full_name|updateUserLegalName/);
  });

  it("protects state from stale responses and merges only returned legal fields", () => {
    assert.match(
      legalNameAction,
      /if \(!liveRequest\.isCurrent\(\)\) \{\s*return response;\s*\}/
    );
    assert.match(
      legalNameAction,
      /setStaffMembers\(\(current\) => mergeStaffLegalNameResponse\(current, response\)\.members\)/
    );
    assert.match(
      legalNameAction,
      /const previewUpdate = applyStaffLegalNameUpdate\(staffMembers, userId, firstName, lastName\);[\s\S]*?if \(!previewUpdate\.updated\) \{[\s\S]*?throw new Error\("Staff member not found\."/
    );
  });
});
