import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const previewE2eEnabled = process.env.KOARYU_PREVIEW_E2E === "true";
const previewTest = previewE2eEnabled ? test : test.skip;

previewTest("updates present and unmarked counters immediately after an attendance toggle", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("koaryu:attendance");
  });
  await page.goto(`${FRONTEND_URL}/schedule`);

  await page.getByRole("button", { name: "Open Kids BJJ Fundamentals at 4:00 PM" }).click();

  const presentCount = page.getByTestId("attendance-present-count");
  const absentCount = page.getByTestId("attendance-absent-count");
  const unmarkedCount = page.getByTestId("attendance-unmarked-count");
  const initialPresent = Number(await presentCount.textContent());
  const initialAbsent = Number(await absentCount.textContent());
  const initialUnmarked = Number(await unmarkedCount.textContent());

  expect(initialUnmarked).toBeGreaterThan(0);

  await page.getByRole("button").filter({ hasText: "Check in" }).first().click();

  await expect(presentCount).toHaveText(String(initialPresent + 1));
  await expect(absentCount).toHaveText(String(initialAbsent));
  await expect(unmarkedCount).toHaveText(String(initialUnmarked - 1));
});
