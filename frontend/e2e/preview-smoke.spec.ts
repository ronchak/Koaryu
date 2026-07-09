import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const previewSmokeEnabled = process.env.KOARYU_PREVIEW_SMOKE_E2E === "true";
const previewSmokeTest = previewSmokeEnabled ? test : test.skip;

function expectNoPageErrors(pageErrors: string[]) {
  expect(pageErrors, "expected no uncaught browser page errors").toEqual([]);
}

previewSmokeTest("preview login opens the dashboard and core navigation", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel("Email").fill("demo@koaryu.local");
  await page.getByLabel("Password").fill("preview-password");

  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);

  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Students", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Billing", exact: true }).first()).toBeVisible();
  expectNoPageErrors(pageErrors);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  previewSmokeTest(`public marketing pages render on ${viewport.name}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto(`${FRONTEND_URL}/features`);
    await expect(
      page.getByRole("heading", { name: /operating pieces behind a calmer martial arts studio/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore", exact: true }).first()).toBeVisible();

    await page.goto(`${FRONTEND_URL}/explore`);
    await expect(
      page.getByRole("heading", { name: /find the page that matches what you need to understand/i }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Compare features", exact: true }).first()).toBeVisible();

    expectNoPageErrors(pageErrors);
  });
}
