import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const rootLayoutSource = source("../src/app/layout.tsx");
const dashboardLayoutSource = source("../src/app/(dashboard)/layout.tsx");
const personalizationSource = source("../src/app/(dashboard)/account/personalization/page.tsx");
const navigationSource = source("../src/components/sidebar.tsx");
const shellStyles = source("../src/components/dashboard-shell.module.css");

function themeBundle() {
  const { add, modules } = createCommonJsPacker({});
  const react = add("react");
  const dom = add("react-dom/client");
  const theme = add("@/components/theme-provider");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const {ThemeProvider,useTheme}=require(${theme});function Observer(){const value=useTheme();window.fixture.theme=value;return React.createElement('output',null,value.preference+':'+value.resolvedTheme+':'+value.navigationPlacement)}require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(Observer)));})();`;
}

describe("appearance preference contracts", () => {
  it("loads, writes, and synchronizes real theme and navigation preferences", async () => {
    const compiledThemeBundle = themeBundle();
    const browser = await chromium.launch({ headless: true });
    try {
      for (const scenario of [
        { name: "missing", expected: "light:light:side" },
        { name: "invalid", theme: "sepia", navigation: "bottom", expected: "light:light:side" },
        { name: "dark", theme: "dark", navigation: "top", expected: "dark:dark:top" },
        { name: "system", theme: "system", expected: "system:dark:side" },
        { name: "blocked", blocked: true, expected: "light:light:side" },
      ]) {
        const page = await browser.newPage();
        await page.route("http://fixture.local/", (route) =>
          route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
        );
        await page.goto("http://fixture.local/");
        await page.evaluate(({ blocked, navigation, theme }) => {
          window.fixture = { storageReads: [] };
          window.matchMedia = () => ({
            addEventListener() {},
            matches: false,
            removeEventListener() {},
          });
          if (theme) localStorage.setItem("koaryu-theme", theme);
          if (navigation) localStorage.setItem("koaryu-navigation-placement", navigation);
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            window.fixture.storageReads.push(key);
            if (blocked) throw new DOMException("blocked", "SecurityError");
            return getItem.call(this, key);
          };
          if (blocked) {
            Storage.prototype.setItem = Storage.prototype.removeItem = () => {
              throw new DOMException("blocked", "SecurityError");
            };
          }
        }, scenario);
        await page.addScriptTag({ content: compiledThemeBundle });
        await page.waitForFunction(
          () =>
            window.fixture.storageReads.includes("koaryu-theme") &&
            window.fixture.storageReads.includes("koaryu-navigation-placement"),
        );
        await page.waitForFunction(
          (expected) => document.querySelector("output")?.textContent === expected,
          scenario.expected,
        );
        assert.deepEqual(
          await page.evaluate(() => [
            document.documentElement.dataset.theme,
            document.documentElement.style.colorScheme,
          ]),
          [scenario.expected.split(":")[1], scenario.expected.split(":")[1]],
        );

        if (scenario.name === "missing") {
          await page.evaluate(() => {
            window.fixture.theme.setTheme("dark");
            window.fixture.theme.setNavigationPlacement("top");
          });
          await page.waitForFunction(
            () => document.querySelector("output")?.textContent === "dark:dark:top",
          );
          assert.deepEqual(
            await page.evaluate(() => [
              localStorage.getItem("koaryu-theme"),
              localStorage.getItem("koaryu-navigation-placement"),
            ]),
            ["dark", "top"],
          );
          await page.evaluate(() => {
            window.dispatchEvent(
              new StorageEvent("storage", {
                key: "koaryu-navigation-placement",
                newValue: "side",
              }),
            );
          });
          await page.waitForFunction(
            () => document.querySelector("output")?.textContent === "dark:dark:side",
          );
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("keeps the bootstrap script's valid preferences and invalid light fallback", () => {
    assert.match(rootLayoutSource, /data-theme="light"/);
    for (const preference of ["dark", "light", "system"]) {
      assert.ok(rootLayoutSource.includes(`stored === "${preference}"`), preference);
    }
    assert.match(rootLayoutSource, /\? stored : "light"/);
    assert.match(
      rootLayoutSource,
      /catch \{[\s\S]*?dataset\.theme = "light";[\s\S]*?colorScheme = "light";/,
    );
  });

  it("offers accessible navigation placement controls", () => {
    assert.match(personalizationSource, /aria-pressed=\{selected\}/);
    assert.match(personalizationSource, /onClick=\{\(\) => setNavigationPlacement\(placement\)\}/);
    assert.match(personalizationSource, /label="Current navigation"/);
  });
});

describe("authenticated navigation placement contracts", () => {
  it("preserves route matching and keeps collapse controls in the side branch", () => {
    assert.match(navigationSource, /pathname === href \|\| pathname\.startsWith\(`\$\{href\}\//);
    const topStart = navigationSource.indexOf('{placement === "top" ? (');
    const sideStart = navigationSource.indexOf(") : (", topStart);
    assert.ok(topStart >= 0 && sideStart > topStart);
    assert.doesNotMatch(
      navigationSource.slice(topStart, sideStart),
      /onToggleCollapsed|ToggleIcon|spineToggle|aria-expanded/,
    );
    assert.match(dashboardLayoutSource, /data-navigation-placement=\{navigationPlacement\}/);
  });

  it("keeps the desktop placements hidden at the mobile breakpoint", () => {
    const mobileRules = shellStyles.slice(shellStyles.indexOf("@media (max-width: 1023px)"));
    assert.match(mobileRules, /\.spine\s*\{[\s\S]*?display:\s*none;/);
    assert.match(mobileRules, /\.commandBar\s*\{[\s\S]*?display:\s*none;/);
    assert.match(mobileRules, /\.mobileSpine\s*\{[\s\S]*?display:\s*block;/);
    assert.match(shellStyles, /\.mobileSpine\s*\{[\s\S]*?display:\s*none;/);
    assert.match(shellStyles, /\.commandList\s*\{[\s\S]*?overflow-x:\s*auto;/);
    assert.match(shellStyles, /\.navLink\s*\{[\s\S]*?min-height:\s*44px;/);
  });
});
