import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const dashboardWidgetEnabled = process.env.KOARYU_DASHBOARD_WIDGET_E2E === "true";
const frontendTarget = new URL(FRONTEND_URL);
if (dashboardWidgetEnabled && !["localhost", "127.0.0.1"].includes(frontendTarget.hostname)) {
  throw new Error("KOARYU_DASHBOARD_WIDGET_E2E may run only against loopback.");
}
if (dashboardWidgetEnabled && process.env.KOARYU_E2E_DATA_PLANE !== "disposable-preview") {
  throw new Error("KOARYU_DASHBOARD_WIDGET_E2E requires KOARYU_E2E_DATA_PLANE=disposable-preview.");
}
const dashboardWidgetTest = dashboardWidgetEnabled ? test : test.skip;

async function signInToPreview(page: Page) {
  await page.goto(`${FRONTEND_URL}/login`);
  await expect(page.locator("html")).toHaveAttribute("data-koaryu-data-plane", "disposable-preview");
  await page.getByLabel("Email").fill("demo@koaryu.local");
  await page.getByLabel("Password").fill("preview-password");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  await expect(page.locator('[data-koaryu-dashboard-ready="true"]')).toBeVisible();
}

dashboardWidgetTest("keeps a lifted widget under the pointer and settles into its placeholder", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInToPreview(page);
  await page.getByRole("button", { name: "Customize", exact: true }).click();

  const widget = page.locator('[data-widget-id="student_pulse"]');
  const target = page.locator('[data-widget-id="attendance"]');
  const before = await widget.boundingBox();
  const targetBox = await target.boundingBox();
  expect(before).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!before || !targetBox) return;

  const grabX = before.x + 72;
  const grabY = before.y + 26;
  const destinationX = targetBox.x + 72;
  const destinationY = targetBox.y + 26;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(destinationX, destinationY, { steps: 6 });

  await expect(widget).toHaveAttribute("data-interaction", "move");
  await expect(page.locator('[data-widget-placeholder="student_pulse"]')).toHaveCount(1);
  await expect.poll(async () => widget.evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
  const lifted = await widget.boundingBox();
  const initialPlaceholder = await page.locator('[data-widget-placeholder="student_pulse"]').boundingBox();
  expect(lifted).not.toBeNull();
  expect(initialPlaceholder).not.toBeNull();
  if (lifted) {
    expect(Math.abs((lifted.x + 72) - destinationX)).toBeLessThan(8);
    expect(Math.abs((lifted.y + 26) - destinationY)).toBeLessThan(8);
  }
  if (initialPlaceholder) {
    expect(Math.abs(initialPlaceholder.x - before.x)).toBeLessThan(3);
  }
  await page.screenshot({ path: testInfo.outputPath("lifted-widget.png"), fullPage: true });
  await page.waitForTimeout(110);
  const settledPlaceholder = await page.locator('[data-widget-placeholder="student_pulse"]').boundingBox();
  expect(settledPlaceholder).not.toBeNull();
  if (settledPlaceholder) {
    expect(settledPlaceholder.x).toBeGreaterThan(before.x + 50);
  }

  await page.mouse.up();
  await expect(widget).not.toHaveAttribute("data-interaction", "move");
  await expect(page.locator('[data-widget-placeholder="student_pulse"]')).toHaveCount(0);
});

dashboardWidgetTest("previews corner resize continuously and persists a supported footprint", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInToPreview(page);
  await page.getByRole("button", { name: "Customize", exact: true }).click();

  const widget = page.locator('[data-widget-id="student_pulse"]');
  const storedLayoutBeforeSelection = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("koaryu:dashboard-layout:")));
  await widget.click({ position: { x: 80, y: 28 } });
  await expect(widget).not.toHaveAttribute("data-interaction", "move");
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith("koaryu:dashboard-layout:")))).toEqual(storedLayoutBeforeSelection);
  const handle = widget.getByRole("button", { name: /Resize Student Pulse/ });
  const before = await widget.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();
  if (!before || !handleBox) return;

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + before.width * 0.8, startY, { steps: 6 });

  await expect(widget).toHaveAttribute("data-interaction", "resize");
  await expect(page.locator('[data-widget-placeholder="student_pulse"]')).toHaveCount(1);
  const preview = await widget.boundingBox();
  expect(preview?.width ?? 0).toBeGreaterThan(before.width * 1.5);
  await page.screenshot({ path: testInfo.outputPath("resizing-widget.png"), fullPage: true });

  await page.mouse.up();
  await expect(widget).toHaveAttribute("data-size", "2x1");
  await expect(widget).not.toHaveAttribute("data-interaction", "resize");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(widget).toHaveAttribute("data-size", "2x1");
});
