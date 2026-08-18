import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resolveDashboardRouteSlug } from "../src/lib/dashboard-shell-route.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layoutSource = source("../src/app/(dashboard)/layout.tsx");
const sidebarSource = source("../src/components/sidebar.tsx");
const homeSource = source("../src/components/dashboard/dashboard-home.tsx");
const contentSource = source("../src/components/dashboard/dashboard-page-content.tsx");
const controllerSource = source("../src/lib/dashboard-page-controller.ts");
const shellStyles = source("../src/components/dashboard-shell.module.css");
const routeTransitionSource = source("../src/components/dashboard-route-transition.tsx");
const sessionSource = source("../src/lib/store-session-cookies.ts");
const storeSource = source("../src/lib/store.tsx");

describe("dashboard shell and Home source contracts", () => {
  it("provides the skip target, indexed semantic navigation, and route scope", () => {
    assert.match(layoutSource, /href="#main-content"/);
    assert.match(layoutSource, /id="main-content"/);
    assert.match(layoutSource, /data-koaryu-dashboard-shell="true"/);
    assert.match(sidebarSource, /<ol className=\{styles\.(?:mobileNav|spineList)\}>/);
    assert.match(sidebarSource, /aria-current=\{isActive \? "page" : undefined\}/);
    assert.equal(resolveDashboardRouteSlug("/dashboard"), "Dashboard / My Home");
    assert.equal(resolveDashboardRouteSlug("/students/123"), "Students / Record");
    assert.equal(resolveDashboardRouteSlug("/help/contact"), "Help / Contact");
  });

  it("hydrates storage only in an effect after identity and exposes complete controls", () => {
    const effectIndex = homeSource.indexOf("useEffect(() =>");
    const readIndex = homeSource.indexOf("readDashboardLayout(");
    assert.ok(effectIndex >= 0 && readIndex > effectIndex);
    assert.doesNotMatch(homeSource.slice(0, effectIndex), /localStorage|readDashboardLayout\(/);
    for (const label of ["Add panels", "Customize", "Cancel", "Done", "Reset", "Earlier", "Later", "Resize", "Remove"]) {
      assert.ok(homeSource.includes(label), label);
    }
    assert.match(homeSource, /aria-live="polite"/);
    assert.match(homeSource, /event\.key === "Escape"/);
    assert.match(homeSource, /500/);
    assert.match(homeSource, /elementFromPoint/);
    assert.match(homeSource, /window\.scrollBy/);
    assert.match(homeSource, /onPointerCancel=\{onPointerCancel\}/);
    assert.match(homeSource, /clearDragSession\(\);[\s\S]*snapshotRef\.current = null/);
    assert.match(homeSource, /viewModels\[entry\.id\]\?\.state !== "unavailable"/);
    assert.match(homeSource, /This browser could not save your arrangement/);
    assert.match(homeSource, /isCustomizing && !catalog\.fixed/);
    assert.match(homeSource, /activeDragWidgetId === item\.widget_id/);
    assert.match(homeSource, /role="dialog" aria-modal="true"/);
    assert.match(homeSource, /ref=\{libraryHeadingRef\} tabIndex=\{-1\}/);
    assert.match(homeSource, /libraryHeadingRef\.current\?\.focus\(\)/);
    assert.match(homeSource, /addPanelsTriggerRef\.current\?\.focus\(\)/);
    assert.match(homeSource, /focusTarget/);
    assert.doesNotMatch(homeSource, /Open source/);
    assert.match(homeSource, /isMaterialState\(model\.state\)/);
    assert.match(homeSource, /data-koaryu-dashboard-ready=\{layoutResolved \? "true" : "false"\}/);
    assert.match(homeSource, /aria-busy=\{!layoutResolved\}/);
    assert.match(homeSource, /disabled=\{!layoutResolved\}/);
    assert.match(homeSource, /identityReady && identity|!identityReady \|\| !identity/);
    assert.match(homeSource, /getBoundingClientRect\(\)/);
    assert.match(homeSource, /node\.animate\(\[/);
    assert.match(homeSource, /prefers-reduced-motion: reduce/);
  });

  it("mounts Home on authoritative identity and owns authenticated material and motion semantics", () => {
    assert.match(controllerSource, /const isDashboardIdentityReady = Boolean\(/);
    assert.match(controllerSource, /normalizeDashboardWidgetRole\(currentRole\)/);
    assert.match(contentSource, /if \(!isDashboardIdentityReady\)/);
    assert.match(contentSource, /identityReady=\{isDashboardIdentityReady\}/);
    for (const token of [
      "--product-ground",
      "--product-paper",
      "--product-card-stock",
      "--product-lifted",
      "--product-motion-travel-duration",
      "--product-motion-open-duration",
      "--product-motion-gather-duration",
      "--product-motion-settle-duration",
      "--product-motion-change-duration",
    ]) {
      assert.ok(shellStyles.includes(token), token);
    }
    assert.match(routeTransitionSource, /styles\.routeTravel/);
    assert.doesNotMatch(routeTransitionSource, /koaryu-route-enter/);
    const routeTravelRule = shellStyles.match(/\.routeTravel\s*\{[\s\S]*?\}/)?.[0] ?? "";
    assert.match(routeTravelRule, /animation:[^;]*\bbackwards;/);
    assert.doesNotMatch(routeTravelRule, /\b(?:both|forwards)\b/);
    const darkProductRule = shellStyles.match(/:global\(\[data-theme="dark"\]\) \.shellRoot\s*\{[\s\S]*?\}/)?.[0] ?? "";
    for (const token of [
      "--product-ground",
      "--product-paper",
      "--product-card-stock",
      "--product-lifted",
      "--product-ink",
      "--product-soft-ink",
      "--product-rule",
      "--product-rule-soft",
      "--product-cobalt",
      "--product-vermilion",
      "--product-shadow-card",
      "--product-shadow-lifted",
    ]) {
      assert.ok(darkProductRule.includes(token), token);
    }
    assert.doesNotMatch(darkProductRule, /#f2ece0|#fbf8f0|#fffdf8|#fffefb/);
    assert.match(shellStyles, /\.spine,[\s\S]*?background: #302719;[\s\S]*?color: #fffaf0;/);
  });

  it("owns authoritative studio identity in the split store and purges layouts at session cleanup", () => {
    assert.match(storeSource, /const \[currentStudioId, setCurrentStudioId\]/);
    assert.match(storeSource, /authProfile\.membership_status === "active" \? authProfile\.studio_id \?\? null : null/);
    assert.match(storeSource, /setCurrentStudioId\(null\)/);
    assert.match(sessionSource, /purgeDashboardLayoutNamespace\(\)/);
    assert.doesNotMatch(sessionSource, /koaryu-theme/);
  });
});
