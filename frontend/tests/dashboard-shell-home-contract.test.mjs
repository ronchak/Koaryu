import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layoutSource = source("../src/app/(dashboard)/layout.tsx");
const scopeSource = source("../src/components/dashboard-shell.tsx");
const sidebarSource = source("../src/components/sidebar.tsx");
const accountMenuSource = source("../src/components/account-menu.tsx");
const accountMenuStyles = source("../src/components/account-menu.module.css");
const homeSource = source("../src/components/dashboard/home/home-page.tsx");
const pageSource = source("../src/app/(dashboard)/dashboard/page.tsx");
const shellStyles = source("../src/components/dashboard-shell.module.css");
const routeTransitionSource = source("../src/components/dashboard-route-transition.tsx");
const sessionSource = source("../src/lib/store-session-cookies.ts");
const storeSource = source("../src/lib/store.tsx");

describe("dashboard shell and Home source contracts", () => {
  it("provides the skip target, icon-and-text navigation, and a non-duplicative scope band", () => {
    assert.match(layoutSource, /href="#main-content"/);
    assert.match(layoutSource, /id="main-content"/);
    assert.match(layoutSource, /data-koaryu-dashboard-shell="true"/);
    assert.match(sidebarSource, /<ul className=\{styles\.(?:mobileNav|spineList)\}>/);
    assert.match(sidebarSource, /aria-current=\{isActive \? "page" : undefined\}/);
    assert.match(sidebarSource, /const Icon = NAV_ICONS\[item\.icon\]/);
    assert.doesNotMatch(sidebarSource, /padStart|navIndex|\$\{String\(index \+ 1\)/);
    assert.doesNotMatch(scopeSource, /resolveDashboardRouteSlug|slugTitle|routeSlug/);
    assert.match(scopeSource, /aria-label="Current workspace scope"/);
    assert.match(homeSource, /titleId="dashboard-home-heading"/);
    assert.match(homeSource, /title=\{greeting\}/);
  });

  it("keeps Home identity readiness separate from its single payload", () => {
    assert.match(pageSource, /<HomePage/);
    assert.match(layoutSource, /identityReady/);
    assert.match(homeSource, /const shellReady = identityReady/);
    assert.match(homeSource, /const dataReady = shellReady && payload !== null/);
    assert.match(homeSource, /data-koaryu-dashboard-shell-ready=\{shellReady/);
    assert.match(homeSource, /data-koaryu-dashboard-data-ready=\{dataReady/);
    assert.match(homeSource, /data-koaryu-dashboard-ready=\{shellReady/);
    assert.match(homeSource, /useState\(\(\) =>[\s\S]*homeGreeting/);
    assert.match(homeSource, /markDashboardReadiness\("dashboard"/);
    assert.match(homeSource, /hasStaffPermission\(currentRole, "create_students"\)/);
    assert.match(homeSource, /hasStaffPermission\(currentRole, "take_attendance"\)/);
  });

  it("keeps shell responsiveness, focus, reduced-motion and target-size policies", () => {
    assert.match(routeTransitionSource, /styles\.routeTravel/);
    assert.doesNotMatch(routeTransitionSource, /koaryu-route-enter/);
    const routeTravelRule = shellStyles.match(/\.routeTravel\s*\{[\s\S]*?\}/)?.[0] ?? "";
    assert.match(routeTravelRule, /animation:[^;]*\bbackwards;/);
    assert.doesNotMatch(routeTravelRule, /\b(?:both|forwards)\b/);
    assert.match(
      shellStyles,
      /@media \(max-width: 1023px\)[\s\S]*\.shellRoot\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/,
    );
    assert.match(shellStyles, /--product-focus:\s*#2f5d8f/);
    assert.match(
      shellStyles,
      /:global\(\[data-theme="dark"\]\) \.shellRoot[\s\S]*--product-focus:\s*#85aedc/,
    );
    assert.match(
      shellStyles,
      /\.brandLink,[\s\S]*?\.mobileBrand\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/,
    );
    assert.match(accountMenuSource, /flex h-11 w-full cursor-pointer/);
    assert.match(accountMenuSource, /group flex min-h-11 items-center/);
    assert.match(accountMenuSource, /group flex h-11 w-full items-center/);
    const reducedShell = shellStyles.slice(
      shellStyles.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );
    assert.match(
      reducedShell,
      /\.skipLink\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?clip-path:\s*inset\(100%\);/,
    );
    assert.match(
      reducedShell,
      /\.skipLink:focus-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?clip-path:\s*inset\(0\);/,
    );
    assert.match(
      accountMenuStyles,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.root\[data-state="closed"\][\s\S]*?display:\s*none;[\s\S]*?visibility:\s*hidden;[\s\S]*?opacity:\s*0;/,
    );
  });

  it("owns authoritative studio identity in the split store and purges layouts at session cleanup", () => {
    assert.match(storeSource, /const \[currentStudioId, setCurrentStudioId\]/);
    assert.match(
      storeSource,
      /authProfile\.membership_status === "active" \? authProfile\.studio_id \?\? null : null/,
    );
    assert.match(storeSource, /setCurrentStudioId\(null\)/);
    assert.match(sessionSource, /purgeDashboardLayoutNamespace\(\)/);
    assert.match(sessionSource, /purgeHomePreferencesNamespace\(\)/);
    assert.doesNotMatch(sessionSource, /koaryu-theme/);
  });
});
