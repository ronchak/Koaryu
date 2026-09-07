import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_PREVIEW_SMOKE_E2E === "true";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
  throw new Error("Navigation performance tests require disposable loopback preview.");
}
const check = enabled ? test : test.skip;
type Sample = { elapsed: number; opacity: number; height: number; iconOpacity: number };

for (const placement of ["side", "collapsed", "top", "mobile"] as const) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    check(`navigation stays stable in ${placement} layout with motion ${reducedMotion}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      await page.setViewportSize({ width: placement === "mobile" ? 390 : 1280, height: 900 });
      await page.addInitScript(value => localStorage.setItem("koaryu-navigation-placement", value), placement === "top" ? "top" : "side");
      await page.goto(`${origin}/dashboard`);
      await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
      await expect(page.locator('[data-koaryu-dashboard-data-ready="true"]')).toBeVisible();
      if (placement === "collapsed") {
        await page.getByRole("button", { name: "Collapse product spine" }).filter({ visible: true }).click();
        await expect(page.locator('aside[data-collapsed="true"]')).toBeVisible();
        await page.locator('aside').evaluate(async element => {
          await Promise.all(element.getAnimations().map(animation => animation.finished));
        });
      }
      const link = page.getByRole("link", { name: "Billing", exact: true }).filter({ visible: true });
      await link.scrollIntoViewIfNeeded();
      const bounds = await link.boundingBox();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      // Hold the actual route read to measure pending feedback frame by frame.
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route(`${origin}/billing*`, async route => { await held; await route.continue(); });
      await page.evaluate(() => {
        const samples: Sample[] = [];
        Object.assign(window, { navigationSamples: samples });
        let started: number | undefined;
        const sample = (now: number) => {
          const indicator = Array.from(document.querySelectorAll<HTMLElement>('[data-koaryu-navigation-pending="true"]'))
            .find(element => element.getBoundingClientRect().width > 0);
          if (indicator) {
            started ??= now;
            samples.push({
              elapsed: now - started,
              opacity: Number(getComputedStyle(indicator).opacity),
              height: indicator.closest("a")!.getBoundingClientRect().height,
              iconOpacity: Number(getComputedStyle(indicator.parentElement!.querySelector("svg")!).opacity),
            });
          }
          if (started === undefined || now - started < 600) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      try {
        await link.click();
        const pending = link.locator('[data-koaryu-navigation-pending="true"]');
        await expect(pending).toHaveCount(1);
        await expect(pending).toHaveCSS("opacity", "1");
        expect(await link.boundingBox()).toEqual(bounds);
        if (reducedMotion === "reduce") await expect(pending).toHaveCSS("transform", "none");
        const samples = await page.evaluate(() => (window as unknown as { navigationSamples: Sample[] }).navigationSamples);
        const early = samples.filter(sample => sample.elapsed < 100);
        expect(early.length).toBeGreaterThan(0);
        expect(early.every(sample => sample.opacity === 0 && sample.iconOpacity > 0)).toBe(true);
        expect(samples.every(sample => sample.height === bounds?.height)).toBe(true);
        expect(samples.some(sample => sample.opacity === 1 && sample.iconOpacity === 0)).toBe(true);
      } finally {
        release();
      }
      await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
      await expect(page.locator('[data-koaryu-navigation-pending="true"]')).toHaveCount(0);
      expect(await link.boundingBox()).toEqual(bounds);
      expect(errors).toEqual([]);
    });
  }
}
