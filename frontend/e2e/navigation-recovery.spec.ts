import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_PREVIEW_SMOKE_E2E === "true";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Recovery tests require loopback preview.");
const check = enabled ? test : test.skip;

check("Try again navigates to the failed destination with its filters", async ({ page }) => {
  await page.goto(`${origin}/503?returnTo=${encodeURIComponent("/schedule?view=week")}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(`${origin}/schedule?view=week`);
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
});

check("a restored older build offers refresh while preserving the open form", async ({ page }) => {
  // The loopback server must embed a synthetic build SHA; external I/O is replaced.
  await page.route(`${origin}/api/version`, route => route.fulfill({ json: {
    service: "koaryu-frontend", environment: "production", commit_sha: "b".repeat(40),
  } }));
  await page.goto(`${origin}/schedule`);
  await page.getByRole("button", { name: "Add class", exact: true }).click();
  const input = page.getByRole("textbox").first();
  await input.fill("Unsaved class");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByText("Koaryu has been updated.", { exact: false })).toBeVisible();
  await expect(input).toHaveValue("Unsaved class");
  await expect(page).toHaveURL(`${origin}/schedule`);
});
