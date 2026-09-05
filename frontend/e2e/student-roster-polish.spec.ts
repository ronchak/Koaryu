import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const rosterUiEnabled = process.env.KOARYU_STUDENT_ROSTER_E2E === "true";
const frontendTarget = new URL(FRONTEND_URL);

if (rosterUiEnabled && !["localhost", "127.0.0.1"].includes(frontendTarget.hostname)) {
  throw new Error("KOARYU_STUDENT_ROSTER_E2E may run only against loopback.");
}
if (rosterUiEnabled && process.env.KOARYU_E2E_DATA_PLANE !== "disposable-preview") {
  throw new Error("KOARYU_STUDENT_ROSTER_E2E requires KOARYU_E2E_DATA_PLANE=disposable-preview.");
}

const rosterUiTest = rosterUiEnabled ? test : test.skip;

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

async function openRoster(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await signInToPreview(page);
  await page.goto(`${FRONTEND_URL}/students`);
  await expect(page.getByRole("heading", { name: "Students", exact: true })).toBeVisible();
  await expect(page.getByRole("row")).not.toHaveCount(0);
}

rosterUiTest("keeps desktop search, rows, and zero-fetch quick view composed", async ({ page }, testInfo) => {
  await openRoster(page, 1440);

  const search = page.getByRole("textbox", { name: "Search students" });
  const searchGeometry = await search.evaluate((input) => {
    const icon = input.parentElement?.querySelector("svg");
    const inputBox = input.getBoundingClientRect();
    const iconBox = icon?.getBoundingClientRect();
    return {
      iconRight: iconBox?.right ?? 0,
      textStart: inputBox.left + Number.parseFloat(getComputedStyle(input).paddingLeft),
    };
  });
  expect(searchGeometry.iconRight).toBeLessThanOrEqual(searchGeometry.textStart - 4);
  await expect(page.getByText("Select all visible students", { exact: true }).first()).toBeHidden();

  const hoverRequests: string[] = [];
  const navigationPaths = new Set([
    "/", "/dashboard", "/students", "/belt-tracker", "/leads", "/schedule",
    "/billing", "/automations", "/reports", "/settings",
  ]);
  page.on("request", (request) => {
    if (!["fetch", "xhr"].includes(request.resourceType())) return;
    const url = new URL(request.url());
    const headers = request.headers();
    const isNavigationPrefetch = url.origin === frontendTarget.origin
      && navigationPaths.has(url.pathname)
      && url.searchParams.has("_rsc")
      && headers.rsc === "1"
      && headers["next-router-prefetch"] === "1";
    // Router prefetch warms the existing navigation links; quick view must not read data.
    if (!isNavigationPrefetch) hoverRequests.push(request.url());
  });
  const firstStudentRow = page.locator("tbody tr").first();
  await firstStudentRow.hover();
  await expect(page.getByLabel("Student quick view")).toHaveCount(0);
  await expect(page.getByText("Quick view", { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  expect(hoverRequests).toEqual([]);

  const workbenchGeometry = await page.locator("table").evaluate((table) => {
    const ledger = table.getBoundingClientRect();
    const rail = document.querySelector("aside[aria-labelledby='student-reading-title']")?.getBoundingClientRect();
    return { ledgerRight: ledger.right, railLeft: rail?.left ?? 0 };
  });
  expect(workbenchGeometry.ledgerRight).toBeLessThan(workbenchGeometry.railLeft);
  await page.screenshot({ path: testInfo.outputPath("students-desktop.png"), fullPage: true });
});

rosterUiTest("collapses the quick view before it can overlap the roster", async ({ page }, testInfo) => {
  await openRoster(page, 1200);
  await expect(page.getByText("Quick view", { exact: true })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("students-medium.png"), fullPage: true });
});

rosterUiTest("renders an uncramped mobile roster", async ({ page }, testInfo) => {
  await openRoster(page, 390);
  await expect(page.getByText("Select all visible students", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Quick view", { exact: true })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("students-mobile.png"), fullPage: true });
});
