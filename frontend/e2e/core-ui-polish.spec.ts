import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const coreUiEnabled = process.env.KOARYU_CORE_UI_E2E === "true";
const frontendTarget = new URL(FRONTEND_URL);
if (coreUiEnabled && !["localhost", "127.0.0.1"].includes(frontendTarget.hostname)) {
  throw new Error("KOARYU_CORE_UI_E2E is preview-stateful and may run only against loopback.");
}
if (coreUiEnabled && process.env.KOARYU_E2E_DATA_PLANE !== "disposable-preview") {
  throw new Error("KOARYU_CORE_UI_E2E requires KOARYU_E2E_DATA_PLANE=disposable-preview.");
}
const coreUiTest = coreUiEnabled ? test : test.skip;

async function signInToPreview(page: Page) {
  await page.goto(`${FRONTEND_URL}/login`);
  await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
  await page.getByLabel("Email").fill("demo@koaryu.local");
  await page.getByLabel("Password").fill("preview-password");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
}

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectHealthyPage(page: Page, pageErrors: string[]) {
  await expect(page.locator("body")).not.toHaveText("");
  await expect(page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay")).toHaveCount(0);
  expect(pageErrors, "expected no uncaught browser page errors").toEqual([]);
}

coreUiTest("renders selected program colors, month-first schedule, and card-level follow-up cues", async ({ page }, testInfo) => {
  const pageErrors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInToPreview(page);

  await page.goto(`${FRONTEND_URL}/settings`);
  const amberProgramSwatch = page.getByRole("button", { name: "Use #F59E0B" });
  await amberProgramSwatch.scrollIntoViewIfNeeded();
  await amberProgramSwatch.click();
  await expect(amberProgramSwatch).toHaveAttribute("aria-pressed", "true");
  await expect(amberProgramSwatch).toHaveAttribute("title", "#F59E0B selected");

  await page.goto(`${FRONTEND_URL}/schedule`);
  await expect(page.getByRole("button", { name: "Show month schedule view" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Open .+, .+ \d{1,2}, \d{4}$/ }).first()).toBeVisible();

  await page.goto(`${FRONTEND_URL}/leads`);
  await expect(page.locator('[data-follow-up-state="due-today"]')).not.toHaveCount(0);
  await expect(page.locator('[data-follow-up-state="overdue"]')).not.toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Follow-up today", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("lead-card-follow-up-cues.png"), fullPage: true });

  await expectHealthyPage(page, pageErrors);
});

coreUiTest("formats student contact phone numbers while typing", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await signInToPreview(page);

  await page.goto(`${FRONTEND_URL}/students`);
  await page.getByRole("button", { name: "Add student", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add student", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Contact", exact: true }).click();
  await page.getByLabel("Phone", { exact: true }).fill("5551234567");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue("(555) 123-4567");

  await page.getByLabel("Emergency phone", { exact: true }).fill("4155550100");
  await expect(page.getByLabel("Emergency phone", { exact: true })).toHaveValue("(415) 555-0100");
  await page.getByRole("button", { name: "Close add student dialog" }).click();

  await expectHealthyPage(page, pageErrors);
});

coreUiTest("prepopulates standard belt names and exposes working drag handles", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await signInToPreview(page);

  await page.goto(`${FRONTEND_URL}/belt-tracker`);
  await page.getByRole("button", { name: "Rank Plan", exact: true }).click();
  await page.getByRole("button", { name: "Add belt", exact: true }).click();

  await page.getByRole("button", { name: "Use Brown for belt color" }).click();
  await expect(page.getByLabel("Rank name")).toHaveValue("Brown Belt");
  await page.getByLabel("Belt color", { exact: true }).fill("#ABCDEF");
  await expect(page.getByLabel("Rank name")).toHaveValue("Brown Belt");
  await page.getByRole("button", { name: "Close rank form" }).click();

  const beltHandles = page.locator("[data-belt-drag-handle]");
  expect(await beltHandles.count()).toBeGreaterThan(1);
  await expect(beltHandles.first()).toHaveAttribute("draggable", "true");
  const firstHandleId = await beltHandles.first().getAttribute("data-belt-drag-handle");
  await beltHandles.first().dragTo(beltHandles.nth(1));
  await expect.poll(async () => beltHandles.first().getAttribute("data-belt-drag-handle")).not.toBe(firstHandleId);
  await expect(page.getByRole("button", { name: "Save ranks", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();

  await expectHealthyPage(page, pageErrors);
});

coreUiTest("adds a program student at the starting belt and refreshes eligibility", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await signInToPreview(page);

  await page.goto(`${FRONTEND_URL}/students`);
  await page.getByRole("button", { name: "Add student", exact: true }).click();
  await page.getByLabel("Legal first name *").fill("Eligibility");
  await page.getByLabel("Legal last name *").fill("Check");
  await page.getByRole("checkbox", { name: "Brazilian Jiu-Jitsu Core" }).check();
  await page.locator("form").getByRole("button", { name: "Add student", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add student", exact: true })).toHaveCount(0);

  await page.goto(`${FRONTEND_URL}/belt-tracker`);
  const studentRow = page.getByRole("row").filter({ hasText: "Eligibility Check" });
  await expect(studentRow).toBeVisible();
  await expect(studentRow).toContainText("White Belt");
  await expect(studentRow).toContainText("Red Tip 1");

  await expectHealthyPage(page, pageErrors);
});
