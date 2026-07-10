import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const previewSmokeEnabled = process.env.KOARYU_PREVIEW_SMOKE_E2E === "true";
const previewSmokeTest = previewSmokeEnabled ? test : test.skip;

function expectNoPageErrors(pageErrors: string[]) {
  expect(pageErrors, "expected no uncaught browser page errors").toEqual([]);
}

async function signInToPreview(page: Page) {
  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel("Email").fill("demo@koaryu.local");
  await page.getByLabel("Password").fill("preview-password");

  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  previewSmokeTest(`preview dashboard navigation works on ${viewport.name}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await signInToPreview(page);

    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    if (viewport.name === "mobile") {
      await expect(page.locator("aside")).toBeHidden();
    } else {
      await expect(page.locator("aside")).toBeVisible();
    }

    const studentsLink = page
      .getByRole("link", { name: "Students", exact: true })
      .filter({ visible: true });
    await expect(studentsLink).toHaveCount(1);
    await Promise.all([
      page.waitForURL("**/students"),
      studentsLink.click(),
    ]);
    await expect(page.getByRole("heading", { name: "Students", exact: true })).toBeVisible();
    expectNoPageErrors(pageErrors);
  });
}

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
