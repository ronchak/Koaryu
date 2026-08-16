import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const staffSource = source("../src/components/settings/staff-roles-section.tsx");
const legalSaveSource = staffSource.slice(
  staffSource.indexOf("  async function handleLegalNameSave"),
  staffSource.indexOf("  if (!canManageStaff)")
);
const deletionSource = staffSource.slice(
  staffSource.indexOf("  async function runScheduleDeletion"),
  staffSource.indexOf("  function handleEditLegalName")
);

describe("staff invite UI contract", () => {
  it("requires and submits display plus both legal names", () => {
    for (const label of ["Display name", "Legal first name", "Legal last name"]) {
      assert.match(staffSource, new RegExp(`label=\\"${label}\\"`));
    }
    assert.match(staffSource, /const fullName = normalizeLegalName\(inviteFullName\);/);
    assert.match(staffSource, /normalizeLegalNameDraft\(\{\s*firstName: inviteLegalFirstName,/);
    assert.match(staffSource, /if \(!fullName\) \{[\s\S]*?Display name is required/);
    assert.match(staffSource, /if \(!normalizedInviteLegalName\.firstName\) \{[\s\S]*?Legal first name is required/);
    assert.match(staffSource, /if \(!normalizedInviteLegalName\.lastName\) \{[\s\S]*?Legal last name is required/);
    assert.match(
      staffSource,
      /inviteStaff\(\{\s*email,\s*role: inviteRole,\s*full_name: fullName,\s*legal_first_name: normalizedInviteLegalName\.firstName,\s*legal_last_name: normalizedInviteLegalName\.lastName/
    );
  });
});

describe("staff legal-name roster UI contract", () => {
  it("keeps legal read/edit UI capability-gated and renders missing names neutrally", () => {
    assert.match(staffSource, /staffProfilesAvailable \? \(/);
    assert.match(staffSource, /<p className=\"text-\[11px\] uppercase tracking-normal text-muted\">Legal name<\/p>/);
    assert.match(staffSource, /: \"Not provided\"/);
    assert.match(staffSource, /staffProfilesAvailable && isLegalNameEditing/);
    assert.match(staffSource, /staffProfilesAvailable && member\.status === "active" && hasUserId && !isLegalNameEditing/);
    assert.doesNotMatch(staffSource, /legal_first_name[^\n]*split|split\([^)]*full_name/);
  });

  it("uses the accepted self action for admins and user-targeted action for other members", () => {
    assert.match(staffSource, /const canManageStaff = currentRole === \"admin\";/);
    assert.match(legalSaveSource, /if \(target\.user_id === currentUserId\) \{/);
    assert.match(legalSaveSource, /await updateUserLegalName\(/);
    assert.match(legalSaveSource, /await updateStaffLegalName\(\s*target\.user_id,/);
    assert.match(staffSource, /const hasUserId = member\.user_id !== null && member\.user_id !== undefined/);
  });

  it("supports normalization, pending/error/cancel states, and leaves display names untouched", () => {
    assert.match(staffSource, /const normalizedLegalNameDraft = normalizeLegalNameDraft/);
    assert.match(legalSaveSource, /if \(pendingLegalNameUserId !== null\) return;/);
    assert.match(legalSaveSource, /setPendingLegalNameUserId\(target\.user_id\)/);
    assert.match(legalSaveSource, /catch \(error\)/);
    assert.match(legalSaveSource, /setLegalNameError\(error instanceof Error/);
    assert.match(staffSource, /onClick=\{onLegalNameCancel\}/);
    assert.match(staffSource, /aria-live=\"polite\"/);
    assert.doesNotMatch(legalSaveSource, /full_name|router|reload\(/);
  });
});

describe("staff lifecycle roster UI contract", () => {
  it("keeps the default roster active-only and serializes explicit archived refreshes", () => {
    assert.match(staffSource, /Show archived/);
    assert.match(staffSource, /void refreshRoster\(false\)/);
    assert.match(staffSource, /await refreshRoster\(false\)/);
    assert.match(staffSource, /await refreshRoster\(nextShowArchived\)/);
    assert.match(staffSource, /const previousShowArchived = showArchived/);
    assert.match(staffSource, /setShowArchived\(previousShowArchived\)/);
    assert.match(staffSource, /disabled=\{isStaffRefreshPending\}/);
    assert.match(staffSource, /filterStaffMembersForDisplay\(staffMembers, showArchived\)/);
    assert.match(staffSource, /data-staff-status=\{member\.status\}/);
    assert.match(staffSource, /member\.archived_at \|\| member\.updated_at/);
  });

  it("uses the backend-owned identity and keeps lifecycle endpoints separated by status", () => {
    assert.match(staffSource, /getDisplayedStaffIdentity\(member\)/);
    assert.match(staffSource, /getDisplayedStaffIdentity\(deleteTarget\)/);
    assert.match(staffSource, /member\.status === "pending"/);
    assert.match(staffSource, /await removeStaff\(member\.id\)/);
    assert.match(staffSource, /await archiveStaff\(member\.id\)/);
    assert.match(staffSource, /await unarchiveStaff\(member\.id\)/);
    assert.match(staffSource, /const unarchivedMember = await unarchiveStaff\(member\.id\)/);
    assert.match(staffSource, /unarchivedMember\.status === "active"/);
    assert.match(staffSource, /studio access is restored/);
    assert.match(staffSource, /membership remains pending/);
    assert.match(staffSource, /scheduleStaffDeletion\(\s*deleteTarget\.id,\s*deletionConfirmationInput/);
    assert.match(
      staffSource,
      /\{hasUserId \? \([\s\S]*?onScheduleDeletion\(member\)[\s\S]*?No linked account to delete[\s\S]*?\)\}/
    );
    assert.match(staffSource, /status === "archived"/);
    assert.match(staffSource, /Archive staff access/);
    assert.match(staffSource, /revoke studio access immediately/);
    assert.match(staffSource, /staff row.*preserved/i);
    assert.doesNotMatch(staffSource, /member\.full_name \|\| member\.email/);
    assert.doesNotMatch(deletionSource, /legal_/);
  });

  it("gates archived deletion on exact normalized confirmation and preserves the row", () => {
    assert.match(staffSource, /matchesStaffDeletionConfirmation\(deleteTarget, deletionConfirmationInput\)/);
    assert.match(staffSource, /disabled=\{!deletionCanSubmit\}/);
    assert.match(staffSource, /existing 30-day lifecycle/);
    assert.match(staffSource, /It is not immediate/);
    assert.match(staffSource, /audit history is retained/);
    assert.match(staffSource, /response\.scheduled_for/);
    assert.match(staffSource, /setMessage\(\s*`Permanent account\/profile deletion/);
    assert.match(staffSource, /archived membership\/profile remains until the existing worker completes the scheduled deletion/);
    assert.match(staffSource, /frozen audit history remains retained/);
    assert.doesNotMatch(deletionSource, /staff row remains preserved/);
    assert.doesNotMatch(staffSource, /setStaffMembers/);
  });

  it("protects the last active admin using active roster facts only", () => {
    assert.match(staffSource, /countActiveAdminMembers\(staffMembers\)/);
    assert.match(staffSource, /isLastActiveAdmin\(staffMembers, member\)/);
    assert.match(staffSource, /disabled=\{isLifecyclePending \|\| isLastActiveAdmin\}/);
    assert.doesNotMatch(staffSource, /ownerUserId/);
  });
});
