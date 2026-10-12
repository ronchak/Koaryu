import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function demoBundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "@/components/icons/martial-arts-belt": `exports.MartialArtsBelt=()=>null;`,
    "next/link": `module.exports=({children,...props})=>require('react').createElement('a',props,children);`,
    "./try-demo.module.css": `module.exports={};`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add("@/components/marketing/try/try-demo");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(require(${subject}).TryDemo));})();`;
}

test("demo keeps new follow-ups in due-date order through stage changes and reset", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: demoBundle() });
    const leadsTab = page
      .getByRole("navigation", { name: "Demo navigation" })
      .getByRole("button", { name: /Leads/ });
    await leadsTab.click();
    await page.getByRole("button", { name: "Add lead", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add lead" })
      .getByRole("button", { name: "Add lead", exact: true })
      .click();
    const upcoming = page.locator('[data-band="upcoming"] ol > li');
    await expect(upcoming).toHaveCount(2);
    await expect(upcoming.nth(0)).toContainText(/Jordan Rivera[\s\S]*Due Wed/);
    await expect(upcoming.nth(1)).toContainText(/Tyler Brooks[\s\S]*Due Thu/);
    for (let step = 0; step < 4; step += 1) {
      await page.getByRole("button", { name: "Move Jordan Rivera to the next stage" }).click();
    }
    await expect(upcoming).toHaveCount(1);
    await expect(page.locator('[data-band="done"]')).toContainText("Jordan Rivera");
    await page.getByRole("button", { name: "Move Jordan Rivera to the previous stage" }).click();
    await expect(upcoming.nth(0)).toContainText("Jordan Rivera");
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await leadsTab.click();
    await expect(upcoming).toHaveCount(1);
    await expect(upcoming.nth(0)).toContainText("Tyler Brooks");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
