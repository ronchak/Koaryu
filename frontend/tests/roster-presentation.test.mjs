import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { getRankColorTreatment, prefersDarkRankText } from "../src/lib/rank-color-treatment.ts";
import { bundle } from "./helpers/store-browser-harness.mjs";

const presentationBundle = bundle("production", { rosterPresentation: true });
const rosterStyles = await readFile(new URL("../src/components/students/student-records.module.css", import.meta.url), "utf8");

function row(id, firstName) {
  const student = {
    id, studio_id: "studio-1", legal_first_name: firstName, legal_last_name: "Student",
    preferred_name: null, email: `${id}@example.test`, phone: null, date_of_birth: null,
    is_minor: false, status: "active", program_id: null, membership_start_date: "2026-01-02",
    guardians: [], tags: [], notes: null, photo_url: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  return {
    student, programs: [], displayName: `${firstName} Student`, contact: student.email,
    search: { name: firstName.toLowerCase(), email: student.email, programs: "" },
    visibleTags: [], hiddenTagCount: 0,
  };
}

function rosterProps() {
  return {
    filtered: [row("student-a", "Ada"), row("student-b", "Bea")],
    sortDir: "asc",
    sortKey: "name",
  };
}

describe("roster presentation behavior", () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });

  it("uses one luminance rule for light, dark, short, and malformed rank colors", () => {
    for (const color of ["#FFFFFF", "#EAB308", "#767676", "#fff"]) {
      assert.equal(prefersDarkRankText(color), true, color);
      assert.equal(getRankColorTreatment(color).color, "#000000", color);
    }
    for (const color of ["#111111", "malformed"]) {
      assert.equal(prefersDarkRankText(color), false, color);
      assert.equal(getRankColorTreatment(color).color, "#ffffff", color);
    }
  });

  it("mounts mobile sort, responsive quick view, keyboard, open, selection, and both tip badges", async () => {
    const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
    await page.setContent(`<style>*{box-sizing:border-box}.px-4{padding-left:1rem;padding-right:1rem}${rosterStyles}</style><main id="root"></main>`);
    await page.evaluate(() => { window.fixture = { opened: [], selected: [], sorts: [] }; });
    await page.addScriptTag({ content: presentationBundle });
    await page.evaluate((props) => window.fixture.renderRoster(props), rosterProps());

    const sort = page.getByLabel("Sort students by");
    await sort.waitFor();
    assert.equal(await sort.isVisible(), true);
    assert.equal(await page.locator("thead").isVisible(), false);
    assert.equal(await page.locator("aside").isVisible(), false);
    await sort.selectOption("status");
    await page.evaluate((props) => window.fixture.renderRoster(props), { ...rosterProps(), sortKey: "status" });
    await page.getByRole("button", { name: "Sort descending" }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.sorts), ["status", "status"]);

    const beaRow = page.locator('[data-student-id="student-b"]');
    await beaRow.hover();
    assert.match(await page.getByLabel("Student quick view").textContent(), /Hover over or focus/);
    await beaRow.getByRole("button", { name: "Open Bea Student profile" }).focus();
    assert.match(await page.locator("aside").textContent(), /Bea Student/);
    await beaRow.getByRole("checkbox").click();
    await beaRow.getByRole("button", { name: "Open Bea Student profile" }).click();
    assert.deepEqual(await page.evaluate(() => ({ opened: window.fixture.opened, selected: window.fixture.selected })), {
      opened: ["student-b"], selected: ["student-b"],
    });

    await page.setViewportSize({ width: 601, height: 900 });
    await page.locator(".rosterToolbar").evaluate((toolbar) => { toolbar.style.width = "521px"; });
    const overlaps = await page.locator(".rosterToolbar").evaluate((toolbar) => {
      const controls = [...toolbar.querySelectorAll("input, select, button")].filter((control) => {
        const style = getComputedStyle(control);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      return controls.flatMap((control, index) => controls.slice(index + 1).flatMap((other) => {
        const a = control.getBoundingClientRect();
        const b = other.getBoundingClientRect();
        const intersects = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return intersects ? [[control.getAttribute("aria-label") ?? control.tagName, other.getAttribute("aria-label") ?? other.tagName]] : [];
      }));
    });
    assert.deepEqual(overlaps, []);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator(".rosterToolbar").evaluate((toolbar) => { toolbar.style.width = "auto"; });
    assert.equal(await sort.isVisible(), false);
    assert.equal(await page.locator("thead").isVisible(), true);
    await page.locator('[data-student-id="student-a"]').hover();
    assert.equal(await page.locator("aside").isVisible(), true);
    assert.match(await page.locator("aside").textContent(), /Ada Student/);

    await page.evaluate(() => window.fixture.renderBadges());
    const badges = page.locator("#root > div > span");
    assert.equal(await badges.count(), 2);
    for (const badge of await badges.all()) {
      assert.equal(await badge.evaluate((node) => getComputedStyle(node).color), "rgb(0, 0, 0)");
      assert.equal(await badge.locator('span[style*="rgb(34, 197, 94)"]').count(), 1);
    }
  });
});
