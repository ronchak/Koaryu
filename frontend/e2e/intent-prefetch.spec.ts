import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_PREFETCH_PRODUCTION_E2E === "true";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Prefetch tests require loopback preview.");
const check = enabled ? test : test.skip;

for (const intent of ["hover", "focus"] as const) {
  check(`production navigation prefetches Billing on ${intent} without navigating`, async ({ page }) => {
    const requests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/billing") requests.push(request.url()); });
    await page.goto(`${origin}/dashboard`);
    await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
    const link = page.getByRole("link", { name: "Billing", exact: true }).filter({ visible: true });
    await expect(link).toBeVisible();
    expect(requests).toHaveLength(0);
    if (intent === "hover") await link.hover(); else await link.focus();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests.every(url => new URL(url).searchParams.has("_rsc"))).toBe(true);
    await expect(page).toHaveURL(`${origin}/dashboard`);
  });
}

check("data-saving mode skips speculative Billing requests", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true, effectiveType: "4g" } }));
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/billing") requests.push(request.url()); });
  await page.goto(`${origin}/dashboard`);
  await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
  await page.getByRole("link", { name: "Billing", exact: true }).filter({ visible: true }).hover();
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(0);
});
