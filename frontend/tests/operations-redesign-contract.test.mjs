import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const accountRoutes = [
  "src/app/(dashboard)/account/page.tsx",
  "src/app/(dashboard)/account/profile/page.tsx",
  "src/app/(dashboard)/account/settings/page.tsx",
  "src/app/(dashboard)/account/personalization/page.tsx",
  "src/app/(dashboard)/account/notifications/page.tsx",
  "src/app/(dashboard)/account/data/page.tsx",
];

const helpRoutes = [
  "src/app/(dashboard)/help/page.tsx",
  "src/app/(dashboard)/help/get-started/page.tsx",
  "src/app/(dashboard)/help/release-notes/page.tsx",
  "src/app/(dashboard)/help/downloads/page.tsx",
  "src/app/(dashboard)/help/contact/page.tsx",
];

describe("operations surface route coverage", () => {
  it("joins all 21 owned destinations and four loading states to the scoped surface", () => {
    const directOwners = [
      ["/schedule", "src/components/schedule/schedule-page-content.tsx", /OperationsSurface page="schedule"/],
      ["/billing", "src/components/billing/billing-page-chrome.tsx", /OperationsSurface page="billing"/],
      ["/reports", "src/app/(dashboard)/reports/page.tsx", /OperationsSurface page="reports"/],
      ["/automations", "src/app/(dashboard)/automations/page.tsx", /OperationsSurface page="automations"/],
      ["/settings", "src/app/(dashboard)/settings/page.tsx", /OperationsSurface page="settings"/],
      ["/subscription-required", "src/app/(dashboard)/subscription-required/page.tsx", /OperationsSurface page="subscription-required"/],
      ["/onboarding", "src/app/onboarding/page.tsx", /FocusedOperationsSheet page="onboarding"/],
      ["/account-archived", "src/app/account-archived/page.tsx", /FocusedOperationsSheet page="account-archived"/],
      ["/access-denied", "src/app/access-denied/page.tsx", /FocusedOperationsSheet page="access-denied"/],
      ["/billing/connect/refresh", "src/app/billing/connect/refresh/page.tsx", /FocusedOperationsSheet page="connect-refresh"/],
    ];
    assert.equal(directOwners.length + accountRoutes.length + helpRoutes.length, 21);
    for (const [route, file, pattern] of directOwners) {
      assert.match(source(file), pattern, route);
    }
    for (const file of accountRoutes) assert.match(source(file), /<AccountPageShell/);
    for (const file of helpRoutes) {
      assert.match(source(file), /<AccountPageShell/);
      assert.match(source(file), /family="help"/);
    }
    const shell = source("src/components/account-page-shell.tsx");
    assert.match(shell, /<OperationsSurface page=\{family\}>/);

    for (const page of ["schedule", "billing", "reports", "settings"]) {
      const loading = source(`src/app/(dashboard)/${page}/loading.tsx`);
      assert.match(loading, new RegExp(`OperationsLoading[\\s\\S]*page="${page}"`));
    }
  });

  it("keeps styling local, opaque, reduced-motion safe, and print aware", () => {
    const css = source("src/components/operations/operations-surface.module.css");
    assert.doesNotMatch(css, /gradient|backdrop-filter|backdrop-blur/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /@media print/);
    assert.match(css, /data-print-hide/);
    assert.match(css, /--operations-cobalt:\s*var\(--product-cobalt\);/);
    assert.match(css, /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\) \{\s*min-height: 44px;/);
    assert.doesNotMatch(css, /\.surface :global\(button\) \{\s*min-height: 44px;/);
    assert.match(css, /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\),\s*\.surface :global\(\[data-print-hide="true"\]\)/);
    assert.doesNotMatch(css, /\.surface :global\(button\),\s*\.surface :global\(\[data-print-hide="true"\]\)/);
    assert.doesNotMatch(css, /\.surface > :global\(header\),/);
    assert.match(css, /\.surface > :global\(header\) \{[\s\S]*?position: static !important;[\s\S]*?display: flex !important;/);
    assert.match(css, /a\[href="#main-content"\]/);
    assert.match(css, /\[class\*="bg-surface"\][\s\S]*?background: #fff !important;/);
  });
});

describe("operations behavior proof", () => {
  it("makes schedule time, overlap, internal overflow, and immediate attendance commit truth explicit", () => {
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    const attendance = source("src/components/schedule/session-detail-modal.tsx");
    assert.match(schedule, /data-schedule-time-canvas="week"/);
    assert.match(schedule, /data-schedule-time-canvas="day"/);
    assert.match(schedule, /style=\{\{ top, height,[\s\S]{0,200}?data-time-canvas-block="template"/);
    assert.match(schedule, /style=\{\{\s*top,\s*height,[\s\S]{0,300}?data-time-canvas-block="session"/);
    assert.match(schedule, /data-overlap=\{block\.overlaps/);
    assert.match(schedule, /data-schedule-scroll-owner="internal"/);
    assert.match(schedule, /role="region"/);
    assert.match(attendance, /Saved as marked\. Each row saves immediately\./);
    assert.match(attendance, /Saving \$\{pendingAttendanceStudentIds\.size\}/);
    assert.match(attendance, /rolled back/);
    assert.match(attendance, /data-attendance-commit-state/);
  });

  it("keeps Month responsive while Week remains the sole horizontal schedule canvas", () => {
    const month = source("src/components/schedule/month-schedule-view.tsx");
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    assert.doesNotMatch(month, /overflow-x-auto|min-w-\[980px\]/);
    assert.match(month, /grid grid-cols-2 xl:grid-cols-7/);
    assert.match(month, /hidden grid-cols-7[^"\n]*xl:grid/);
    assert.doesNotMatch(month, /lg:grid-cols-7|lg:grid|lg:hidden/);
    assert.match(month, /MONTH_DAY_NAMES\[day\.date\.getDay\(\)\]/);
    assert.match(schedule, /overflow-x-auto overscroll-x-contain/);
    assert.match(schedule, /data-schedule-scroll-owner="internal"/);
    assert.match(schedule, /min-w-\[1040px\]/);
  });

  it("keeps six billing books, negative capabilities, and the connected Admin reset gate", () => {
    const chrome = source("src/components/billing/billing-page-chrome.tsx");
    const sections = source("src/components/billing/billing-page-sections.tsx");
    const controller = source("src/lib/billing-page-controller.ts");
    const negativeCopy = [
      source("src/components/billing/billing-plans-tab.tsx"),
      source("src/components/billing/billing-families-tab.tsx"),
      source("src/components/billing/billing-invoices-tab.tsx"),
      source("src/components/billing/billing-reports-tab.tsx"),
    ].join("\n");
    for (const label of ["Setup", "Tuition Plans", "Families", "Student Billing", "Invoices", "Advanced"]) {
      assert.match(chrome, new RegExp(`label: "${label}"`));
    }
    assert.match(chrome, /data-billing-money-band|data-billing-register-context/);
    assert.match(sections, /Reset Stripe connection\?/);
    assert.match(sections, /onConnectReset/);
    assert.match(controller, /!isPreviewMode[\s\S]*canManageKoaryuSubscription[\s\S]*hasStripeConnectedAccount[\s\S]*connectOnboardingEnabled/);
    assert.match(negativeCopy, /Creating or syncing plans is currently unavailable/);
    assert.match(negativeCopy, /Creating or syncing payers and changing autopay are currently unavailable/);
    assert.match(negativeCopy, /Creating, finalizing, retrying, or voiding provider invoices is currently unavailable/);
    assert.match(negativeCopy, /New CSV exports are currently unavailable/);
  });

  it("keeps automations read-only and settings indexed behind the Admin boundary", () => {
    const automations = source("src/app/(dashboard)/automations/page.tsx");
    const settings = source("src/app/(dashboard)/settings/page.tsx");
    const programs = source("src/components/settings/programs-section.tsx");
    const staff = source("src/components/settings/staff-roles-section.tsx");
    assert.equal((automations.match(/href: "\/(?:leads|dashboard|belt-tracker|billing)"/g) || []).length, 4);
    assert.equal((automations.match(/^  \["/gm) || []).length, 5);
    assert.doesNotMatch(automations, /<form|<input|<select|onChange=|\bapi\./);
    assert.match(automations, /data-automations-readonly="true"/);
    assert.match(settings, /canAccessSettings\(currentRole\) \? <AdminSettingsContent \/> : <SettingsAccessNotice \/>/);
    for (const id of ["studio", "programs", "staff-roles", "data-controls"]) {
      assert.match(settings, new RegExp(`(?:href="#${id}"|id="${id}")`));
    }
    for (const marker of ["createProgram", "updateProgram", "archiveProgram", "restoreProgram", "is_system", "usage"]) {
      assert.match(programs, new RegExp(marker));
    }
    for (const marker of ["inviteEmail", "inviteFullName", "inviteLegalFirstName", "inviteLegalLastName", 'useState<StaffRoleName>("instructor")', "matchesStaffDeletionConfirmation", "archiveStaff", "unarchiveStaff", "scheduleStaffDeletion", "showArchived"]) {
      assert.match(staff, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("adds the typed deletion gate and complete support context/inbox states without new APIs", () => {
    const account = source("src/app/(dashboard)/account/settings/page.tsx");
    const contact = source("src/app/(dashboard)/help/contact/page.tsx");
    assert.match(account, /Type DELETE to continue/);
    assert.match(account, /deletionConfirmation !== "DELETE"/);
    assert.match(account, /interface confirmation[\s\S]*API does not require this phrase/);
    assert.match(account, /Checking account deletion status/);
    assert.match(account, /const isPreviewMode = process\.env\.NEXT_PUBLIC_PREVIEW_MODE === "true"/);
    assert.match(account, /useState\(!isPreviewMode\)/);
    assert.match(account, /if \(!isAdmin \|\| staffLoaded\) return;/);
    assert.match(account, /\[isAdmin, refreshStaff, staffLoaded\]/);
    for (const label of ["Current page", "Expected result", "Actual result"]) assert.match(contact, new RegExp(label));
    assert.match(contact, /page_url: currentPage\.trim\(\) \|\| null/);
    assert.match(contact, /expected_result: expectedResult\.trim\(\)/);
    assert.match(contact, /actual_result: actualResult\.trim\(\)/);
    assert.match(contact, /Subject must be between 3 and 160 characters/);
    assert.match(contact, /Details must be between 10 and 5,000 characters/);
    assert.match(contact, /initialTopic[\s\S]*return "billing"/);
    assert.match(contact, /useState<SupportTicketSeverity>\("normal"\)/);
    for (const state of ["loading", "ready", "error"]) assert.match(contact, new RegExp(`"${state}"`));
    assert.match(contact, /Retry recent requests/);
  });

  it("preserves transition effect owners and fail-closed copy", () => {
    const onboarding = source("src/app/onboarding/page.tsx");
    const archived = source("src/app/account-archived/page.tsx");
    const denied = source("src/app/access-denied/page.tsx");
    const refresh = source("src/app/billing/connect/refresh/page.tsx");
    const legal = source("src/components/account/legal-name-blocking-screen.tsx");
    assert.equal((onboarding.match(/^  "(?:America|Pacific|Europe|Asia|Australia)\//gm) || []).length, 17);
    assert.match(onboarding, /useState\("America\/New_York"\)/);
    assert.match(onboarding, /studioName\.trim\(\)/);
    assert.match(onboarding, /"Idempotency-Key"/);
    assert.doesNotMatch(archived, /useStudioStore|\/studios|\/bootstrap/);
    assert.match(archived, /No studio data is loaded on this page/);
    assert.doesNotMatch(denied, /useStudioStore|\bapi\./);
    assert.match(denied, /No protected billing information was loaded/);
    assert.match(refresh, /acknowledgeConnectOnboardingBeforeNavigation/);
    assert.match(legal, /updateUserLegalName/);
    assert.match(legal, /Save legal name/);
    assert.match(legal, /Sign out/);
  });
});
