import path from "node:path";
import { expect, test } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const previewImportE2eEnabled = process.env.KOARYU_PREVIEW_E2E === "true";
const previewImportTest = previewImportE2eEnabled ? test : test.skip;

previewImportTest("keeps import enabled after reviewing, backing up, and reviewing unchanged CSV settings", async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/students/import`);
  await expect(page.getByRole("heading", { name: "Import Students" })).toBeVisible();

  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(process.cwd(), "public/demo-students.csv"));

  const reviewButton = page.getByRole("button", { name: /Review \d+ rows/ });
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();

  const importButton = page.getByRole("button", { name: /Import \d+ students/ });
  await expect(importButton).toBeEnabled();

  await page.getByRole("button", { name: "Back to mapping" }).click();
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();
  await expect(importButton).toBeEnabled();
});
