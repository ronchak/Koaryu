import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const source = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const accessibilityBundle = bundle("production", { rosterPresentation: true });

describe("records workspace policies", () => {
  it("does not expose promotion-history mutation controls", async () => {
    const detail = await source("../src/components/students/student-detail-sections.tsx");

    assert.doesNotMatch(detail, /onEditPromotion|onDeletePromotion|deletePromotion|editPromotion/);
  });

  it("keeps lead assignment and inspector access without exposing deletion", async () => {
    const add = await source("../src/components/leads/add-lead-modal.tsx");
    const detail = await source("../src/components/leads/lead-detail-modal.tsx");
    const controller = await source("../src/lib/leads-page-controller.ts");

    assert.match(add, /activeStaff\.map/);
    assert.match(add, /<select[\s\S]*name="assigned_staff_id"[\s\S]*activeStaff\.map/);
    assert.match(add, /assigned_staff_id:\s*\(formData\.get\("assigned_staff_id"\)/);
    assert.match(detail, /currentAssignedStaff\.status !== "active"/);
    assert.match(detail, /\$\{member\.status\}/);
    assert.match(detail, /ref=\{inspectorRef\}/);
    assert.match(detail, /tabIndex=\{-1\}/);
    assert.match(detail, /inspectorRef\.current\?\.focus\(\)/);
    assert.match(detail, /event\.key !== "Escape"[\s\S]*handleClose\(\)/);
    assert.match(detail, /\[data-lead-id=\"\$\{CSS\.escape\(lead\.id\)\}\"\]/);
    assert.doesNotMatch(
      `${add}\n${detail}\n${controller}`,
      /deleteLead|api\.delete|>\s*Delete\s*</,
    );
  });

  it("mounts keyboard, progress, retry, and loading announcement accessibility contracts", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent('<main id="root"></main>');
      await page.evaluate(() => {
        window.fixture = { changes: [], retries: 0 };
      });
      await page.addScriptTag({ content: accessibilityBundle });

      await page.evaluate(() => {
        window.fixture.renderSegmentedControl({
          activeValue: "eligibility",
          ariaLabel: "Belt workspace",
          idPrefix: "belt-tab",
          items: [
            { id: "eligibility", label: "Eligibility", controls: "eligibility-panel" },
            { id: "ladder", label: "Rank plan", controls: "ladder-panel" },
          ],
          mode: "tabs",
          onChange: (value) => window.fixture.changes.push(value),
        });
      });
      const tablist = page.getByRole("tablist", { name: "Belt workspace" });
      const eligibilityTab = tablist.getByRole("tab", { name: "Eligibility" });
      const ladderTab = tablist.getByRole("tab", { name: "Rank plan" });
      assert.equal(await eligibilityTab.getAttribute("aria-selected"), "true");
      assert.equal(await ladderTab.getAttribute("aria-selected"), "false");
      await eligibilityTab.focus();
      await eligibilityTab.press("ArrowRight");
      await page.waitForFunction(() => document.activeElement?.textContent === "Rank plan");
      await ladderTab.press("ArrowLeft");
      await page.waitForFunction(() => document.activeElement?.textContent === "Eligibility");
      assert.deepEqual(await page.evaluate(() => window.fixture.changes), [
        "ladder",
        "eligibility",
      ]);

      await page.evaluate(() =>
        window.fixture.renderProgressBars([
          { current: 4, label: "Class progress", required: 10, met: false },
          { current: 0, label: "Time progress", required: 0, met: true },
        ]),
      );
      const progress = page.getByRole("progressbar", { name: "Class progress" });
      await progress.waitFor({ state: "attached" });
      assert.equal(await progress.getAttribute("aria-valuenow"), "4");
      assert.equal(await progress.getAttribute("aria-valuetext"), "4 of 10");
      assert.equal(await page.getByRole("progressbar").count(), 1);
      await page.getByText("Not required", { exact: true }).waitFor();

      await page.evaluate(() =>
        window.fixture.renderLeadLedgerLoadError({
          error: "Lead roster unavailable.",
          onRetry: () => {
            window.fixture.retries += 1;
          },
        }),
      );
      const alert = page.getByRole("alert");
      await alert.getByText("Lead roster unavailable.", { exact: true }).waitFor();
      await alert.getByRole("button", { name: "Retry lead roster" }).click();
      assert.equal(await page.evaluate(() => window.fixture.retries), 1);

      await page.evaluate(() =>
        window.fixture.renderRecordsLoading({
          description: "Loading student records.",
          title: "Students",
          variant: "roster",
        }),
      );
      const statuses = page.locator('[role="status"]');
      await statuses.first().waitFor();
      assert.equal(await statuses.count(), 1);
      assert.equal(await page.locator('[aria-live="polite"]').count(), 1);
      assert.equal(await statuses.textContent(), "Loading student records.");
    } finally {
      await browser.close();
    }
  });
});
