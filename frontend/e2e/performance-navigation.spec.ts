import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_PREVIEW_SMOKE_E2E === "true";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
  throw new Error("Navigation performance tests require disposable loopback preview.");
}
const check = enabled ? test : test.skip;

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  check(`navigation feedback preserves the shell with motion ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/dashboard`);
    await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
    await expect(page.locator('[data-koaryu-dashboard-data-ready="true"]')).toBeVisible();
    const shell = page.locator('[data-koaryu-dashboard-shell="true"]');
    const shellBounds = await shell.boundingBox();
    // This lab test deliberately intercepts the RSC read, so its HTTP cache is disabled.
    // The delay makes the pending interval observable without slowing the click handler.
    await page.route(`${origin}/billing*`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(() => {
      document.addEventListener("click", () => performance.mark("lab.navigation.click"), { capture: true, once: true });
      const observer = new MutationObserver(() => {
        const indicator = Array.from(document.querySelectorAll('[data-koaryu-navigation-pending="true"]'))
          .find((element) => element.getBoundingClientRect().width > 0);
        if (indicator) {
          performance.mark("lab.navigation.feedback");
          observer.disconnect();
        }
      });
      observer.observe(document, { subtree: true, childList: true });
    });
    await page.getByRole("link", { name: "Billing", exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
    const elapsed = await page.evaluate(() => {
      const start = performance.getEntriesByName("lab.navigation.click")[0];
      const feedback = performance.getEntriesByName("lab.navigation.feedback")[0];
      return start && feedback ? feedback.startTime - start.startTime : null;
    });
    expect(elapsed, "pending feedback should be committed within 100ms in this unthrottled loopback lab").not.toBeNull();
    if (elapsed === null) throw new Error("Navigation feedback was not observed.");
    expect(elapsed).toBeLessThan(100);
    const afterBounds = await shell.boundingBox();
    expect(afterBounds?.x).toBe(shellBounds?.x);
    expect(afterBounds?.width).toBe(shellBounds?.width);
    await expect(page.locator('[data-koaryu-navigation-pending="true"]')).toHaveCount(0);
  });
}
