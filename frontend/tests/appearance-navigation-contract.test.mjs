import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { NAV_ITEMS } from "../src/lib/constants.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const rootLayoutSource = source("../src/app/layout.tsx");
const providerSource = source("../src/components/theme-provider.tsx");
const dashboardLayoutSource = source("../src/app/(dashboard)/layout.tsx");
const personalizationSource = source("../src/app/(dashboard)/account/personalization/page.tsx");
const navigationSource = source("../src/components/sidebar.tsx");
const shellStyles = source("../src/components/dashboard-shell.module.css");

describe("Appearance preference contracts", () => {
  it("uses light consistently when the theme preference is missing, invalid, or unavailable", () => {
    assert.match(rootLayoutSource, /data-theme="light"/);
    assert.match(rootLayoutSource, /\? stored : "light"/);
    assert.match(rootLayoutSource, /catch \{[\s\S]*?dataset\.theme = "light";[\s\S]*?colorScheme = "light";/);
    assert.match(providerSource, /const DEFAULT_THEME: ThemePreference = "light"/);
    assert.match(providerSource, /useState<ResolvedTheme>\("light"\)/);
    assert.match(providerSource, /catch \{[\s\S]*?return DEFAULT_THEME;/);
  });

  it("continues to accept stored dark and system themes without replacing them", () => {
    for (const preference of ["dark", "light", "system"]) {
      assert.ok(rootLayoutSource.includes(`stored === "${preference}"`), preference);
      assert.ok(providerSource.includes(`stored === "${preference}"`), preference);
    }
    assert.match(providerSource, /localStorage\.setItem\(THEME_STORAGE_KEY, nextPreference\)/);
    assert.match(providerSource, /preference === "system" \? getSystemTheme\(\) : preference/);
  });

  it("owns a typed side-or-top navigation preference with safe fallback and tab synchronization", () => {
    assert.match(providerSource, /export type NavigationPlacement = "side" \| "top"/);
    assert.match(providerSource, /NAVIGATION_STORAGE_KEY = "koaryu-navigation-placement"/);
    assert.match(providerSource, /DEFAULT_NAVIGATION_PLACEMENT: NavigationPlacement = "side"/);
    assert.match(providerSource, /value === "side" \|\| value === "top" \? value : DEFAULT_NAVIGATION_PLACEMENT/);
    assert.match(providerSource, /catch \{[\s\S]*?return DEFAULT_NAVIGATION_PLACEMENT;/);
    assert.match(providerSource, /localStorage\.setItem\(NAVIGATION_STORAGE_KEY, nextPlacement\)/);
    assert.match(providerSource, /setNavigationPlacementState\(nextPlacement\)/);
    assert.match(providerSource, /addEventListener\("storage", handleStorageChange\)/);
    assert.match(providerSource, /event\.key === NAVIGATION_STORAGE_KEY[\s\S]*?parseNavigationPlacement\(event\.newValue\)/);
  });

  it("offers accessible, honest controls and reports the active navigation placement", () => {
    assert.match(personalizationSource, /\(\["side", "top"\] as NavigationPlacement\[\]\)/);
    assert.match(personalizationSource, /aria-pressed=\{selected\}/);
    assert.match(personalizationSource, /onClick=\{\(\) => setNavigationPlacement\(placement\)\}/);
    assert.match(personalizationSource, /"Top command bar" : "Side rail"/);
    assert.match(personalizationSource, /label="Current navigation"/);
    assert.match(personalizationSource, /Stored in this browser\/device/);
    assert.doesNotMatch(personalizationSource, /cloud|account sync|all devices/i);
  });
});

describe("authenticated navigation placement contracts", () => {
  it("uses one exact NAV_ITEMS mapping for mobile, side, and top route inventory", () => {
    assert.equal(navigationSource.match(/NAV_ITEMS\.map\(/g)?.length, 1);
    assert.equal(navigationSource.match(/<NavigationLinks pathname=\{pathname\} \/>/g)?.length, 3);
    assert.match(navigationSource, /prefetch=\{item\.prefetch\}/);
    assert.match(navigationSource, /pathname === href \|\| pathname\.startsWith\(`\$\{href\}\//);
    assert.equal(NAV_ITEMS.find(({ href }) => href === "/belt-tracker")?.icon, "MartialArtsBelt");
    assert.match(navigationSource, /import \{ MartialArtsBelt \} from "@\/components\/icons\/martial-arts-belt"/);
    assert.deepEqual(
      NAV_ITEMS.map(({ href, prefetch }) => [href, prefetch]),
      [
        ["/dashboard", undefined],
        ["/students", undefined],
        ["/belt-tracker", false],
        ["/leads", undefined],
        ["/schedule", undefined],
        ["/billing", false],
        ["/automations", false],
        ["/reports", false],
        ["/settings", false],
      ]
    );
  });

  it("keeps collapse controls exclusively in the side branch", () => {
    const topStart = navigationSource.indexOf('{placement === "top" ? (');
    const sideStart = navigationSource.indexOf(") : (", topStart);
    assert.ok(topStart >= 0 && sideStart > topStart);
    const topBranch = navigationSource.slice(topStart, sideStart);
    assert.match(topBranch, /styles\.commandBar/);
    assert.match(topBranch, /styles\.commandList/);
    assert.match(topBranch, /<AccountMenu/);
    assert.doesNotMatch(topBranch, /onToggleCollapsed|ToggleIcon|spineToggle|aria-expanded/);
    assert.match(dashboardLayoutSource, /data-navigation-placement=\{navigationPlacement\}/);
    assert.match(shellStyles, /data-navigation-placement="top"\] \.main \{[\s\S]*?margin-left:\s*0;/);
  });

  it("shows only the existing mobile shell below the desktop breakpoint", () => {
    assert.equal(navigationSource.match(/className=\{styles\.mobileSpine\}/g)?.length, 1);
    const mobileRules = shellStyles.slice(shellStyles.indexOf("@media (max-width: 1023px)"));
    assert.match(mobileRules, /\.spine\s*\{[\s\S]*?display:\s*none;/);
    assert.match(mobileRules, /\.commandBar\s*\{[\s\S]*?display:\s*none;/);
    assert.match(mobileRules, /\.mobileSpine\s*\{[\s\S]*?display:\s*block;/);
    assert.match(shellStyles, /\.mobileSpine\s*\{[\s\S]*?display:\s*none;/);
    assert.match(shellStyles, /\.commandList\s*\{[\s\S]*?overflow-x:\s*auto;/);
    assert.match(shellStyles, /\.navLink\s*\{[\s\S]*?min-height:\s*44px;/);
  });
});
