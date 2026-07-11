import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const previewE2eEnabled = process.env.KOARYU_PREVIEW_E2E === "true";
const previewTest = previewE2eEnabled ? test : test.skip;

async function openKidsSession(page: Page) {
  await page.goto(`${FRONTEND_URL}/schedule`);
  await page.getByRole("button", { name: "Open Kids BJJ Fundamentals at 4:00 PM" }).click();
  await expect(page.getByTestId("attendance-summary")).toHaveAttribute("aria-busy", "false");
}

previewTest("updates present and unmarked counters immediately after an attendance toggle", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("koaryu:attendance");
  });
  await openKidsSession(page);

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

previewTest("serializes two same-tick attendance toggles from the latest committed state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("koaryu:attendance");
  });
  await openKidsSession(page);

  const presentCount = page.getByTestId("attendance-present-count");
  const unmarkedCount = page.getByTestId("attendance-unmarked-count");
  const initialPresent = Number(await presentCount.textContent());
  const initialUnmarked = Number(await unmarkedCount.textContent());
  const firstUnmarkedStudent = page
    .locator("[data-attendance-student-id]")
    .filter({ hasText: "Check in" })
    .first();
  const studentId = await firstUnmarkedStudent.getAttribute("data-attendance-student-id");
  expect(studentId).toBeTruthy();
  const unmarkedStudent = page.locator(`[data-attendance-student-id="${studentId}"]`);

  await unmarkedStudent.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Expected an attendance button");
    }
    button.click();
    button.click();
  });

  await expect(unmarkedStudent).toContainText("late");
  await expect(presentCount).toHaveText(String(initialPresent + 1));
  await expect(unmarkedCount).toHaveText(String(initialUnmarked - 1));
});

previewTest("clearing attendance removes all duplicate rows and stays cleared after reopen", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("koaryu:attendance", JSON.stringify([
      {
        id: "stale-aiko-present",
        studio_id: "mock-studio",
        session_id: "sess-1",
        student_id: "mock-1",
        status: "present",
        checked_in_at: "2026-07-10T19:00:00.000Z",
        is_cross_program: false,
        counts_toward_eligibility: true,
        student_name: "Aiko Tanaka",
      },
      {
        id: "current-aiko-absent",
        studio_id: "mock-studio",
        session_id: "sess-1",
        student_id: "mock-1",
        status: "absent",
        checked_in_at: "2026-07-10T20:00:00.000Z",
        is_cross_program: false,
        counts_toward_eligibility: true,
        student_name: "Aiko Tanaka",
      },
    ]));
  });
  await openKidsSession(page);

  const absentCount = page.getByTestId("attendance-absent-count");
  const unmarkedCount = page.getByTestId("attendance-unmarked-count");
  const initialAbsent = Number(await absentCount.textContent());
  const initialUnmarked = Number(await unmarkedCount.textContent());
  const aiko = page.getByRole("button").filter({ hasText: "Aiko Tanaka" });
  await expect(aiko).toContainText("absent");

  await aiko.click();

  await expect(aiko).toContainText("Check in");
  await expect(absentCount).toHaveText(String(initialAbsent - 1));
  await expect(unmarkedCount).toHaveText(String(initialUnmarked + 1));
  await expect.poll(async () => page.evaluate(() => {
    const rows = JSON.parse(window.localStorage.getItem("koaryu:attendance") || "[]");
    return rows.filter((row: { session_id?: string; student_id?: string }) =>
      row.session_id === "sess-1" && row.student_id === "mock-1"
    ).length;
  })).toBe(0);

  await page.getByRole("button", { name: "Close session details" }).click();
  const busyOnReopen = await page
    .getByRole("button", { name: "Open Kids BJJ Fundamentals at 4:00 PM" })
    .evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected a session button");
      }
      button.click();
      return new Promise<string | null | undefined>((resolve) => {
        window.requestAnimationFrame(() => {
          resolve(
            document
              .querySelector('[data-testid="attendance-summary"]')
              ?.getAttribute("aria-busy")
          );
        });
      });
    });
  expect(busyOnReopen, "same-session reopen must render pending before refresh effects settle").toBe("true");
  await expect(page.getByTestId("attendance-summary")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button").filter({ hasText: "Aiko Tanaka" })).toContainText("Check in");
});
