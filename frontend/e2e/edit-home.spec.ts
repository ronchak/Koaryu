import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_EDIT_HOME_E2E === "true";
const target = new URL(FRONTEND_URL);
if (enabled && !["localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error("KOARYU_EDIT_HOME_E2E may run only against loopback.");
}
if (enabled && process.env.KOARYU_E2E_DATA_PLANE !== "disposable-preview") {
  throw new Error("KOARYU_EDIT_HOME_E2E requires KOARYU_E2E_DATA_PLANE=disposable-preview.");
}
const editHomeTest = enabled ? test : test.skip;
const namespace = "koaryu:home-preferences:v1:";
const sheet = (page: Page) => page.getByRole("dialog", { name: "Edit Home", exact: true });
const rowIds = (page: Page) =>
  page
    .locator("[data-home-edit-panel]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-home-edit-panel")));
const panelIds = (page: Page) =>
  page
    .locator("[data-home-panel]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-home-panel")));

async function signIn(page: Page, theme: "light" | "dark") {
  await page.addInitScript((theme) => localStorage.setItem("koaryu-theme", theme), theme);
  // Keep this explicitly local even if the preview accidentally tries external I/O.
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return ["localhost", "127.0.0.1"].includes(hostname) ? route.continue() : route.abort();
  });
  await page.goto(`${FRONTEND_URL}/login`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-koaryu-data-plane",
    "disposable-preview",
  );
  await page.getByLabel("Email").fill("demo@koaryu.local");
  await page.getByLabel("Password").fill("preview-password");
  await Promise.all([
    page.waitForURL("**/dashboard"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  await expect(page.locator('[data-koaryu-dashboard-data-ready="true"]')).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function tabTo(page: Page, label: string) {
  for (let i = 0; i < 80; i++) {
    if (
      await page.evaluate((label) => {
        const node = document.activeElement;
        return node?.getAttribute("aria-label") === label || node?.textContent?.trim() === label;
      }, label)
    )
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab could not reach ${label}`);
}
async function drag(page: Page, touch: boolean, acrossAllRows = false) {
  const handle = sheet(page).getByRole("button", { name: "Move Follow-ups", exact: true });
  const target = page.locator(
    touch || !acrossAllRows
      ? '[data-home-edit-panel="promotions"]'
      : '[data-home-edit-panel="newStudents"]',
  );
  // Geometry must be measured after the opening/settle animation, as a real
  // pointer action would wait for a stable handle before pressing it.
  await handle.click({ trial: true });
  // A trial click can resolve before the sheet's opening animation has moved the
  // handle; wait for every running animation in the sheet to finish first.
  await sheet(page).evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => null))),
  );
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  if (!from || !to) throw new Error("Drag rows must have geometry");
  const x = from.x + from.width / 2,
    y = from.y + from.height / 2;
  const destination = to.y + (touch ? 2 : to.height - 2);
  const scrollBefore = await page.evaluate(() => ({
    window: scrollY,
    main: document.querySelector("#main-content")?.scrollTop,
    sheet: document.querySelector('[data-home-edit="sheet"]')?.children[1]?.scrollTop,
  }));
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      await expect(page.locator('[data-home-edit-panel="followUps"]')).toHaveAttribute(
        "data-dragging",
        "true",
      );
      for (let i = 1; i <= 8; i++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y + ((destination - y) * i) / 8, id: 1 }],
        });
      await expect.poll(() => rowIds(page)).toEqual(["followUps", "promotions", "newStudents"]);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(page.locator('[data-home-edit-panel="followUps"]')).toHaveAttribute(
      "data-dragging",
      "true",
    );
    await page.mouse.move(x, destination, { steps: 8 });
    await expect
      .poll(() => rowIds(page), {
        message:
          "A single drag must reach its insertion slot across every row, including hidden rows; losing pointer capture after the first reorder must not end the gesture.",
      })
      .toEqual(
        acrossAllRows
          ? ["promotions", "newStudents", "followUps"]
          : ["promotions", "followUps", "newStudents"],
      );
    await page.mouse.up();
  }
  await expect
    .poll(() => rowIds(page))
    .toEqual(
      touch
        ? ["followUps", "promotions", "newStudents"]
        : acrossAllRows
          ? ["promotions", "newStudents", "followUps"]
          : ["promotions", "followUps", "newStudents"],
    );
  if (touch)
    expect(
      await page.evaluate(() => ({
        window: scrollY,
        main: document.querySelector("#main-content")?.scrollTop,
        sheet: document.querySelector('[data-home-edit="sheet"]')?.children[1]?.scrollTop,
      })),
    ).toEqual(scrollBefore);
  await expect(sheet(page).locator('[aria-live="polite"]')).toHaveText(
    touch ? "Follow-ups moved up" : "Follow-ups moved down",
  );
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    editHomeTest(
      `Edit Home single mouse drag crosses two rows at ${width} in ${theme}`,
      async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await signIn(page, theme);
        await page.locator('[data-home-edit="trigger"]').click();
        await drag(page, false, true);
        await expect.poll(() => panelIds(page)).toEqual(["promotions", "followUps"]);
      },
    );
    editHomeTest(
      `Edit Home mouse and touch drag, Reset, reload and sign-out at ${width} in ${theme}`,
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await signIn(page, theme);
        await page.locator('[data-home-edit="trigger"]').click();
        await expect(sheet(page)).toBeVisible();
        await drag(page, false);
        await drag(page, true);
        await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
        await sheet(page)
          .getByRole("button", { name: "Move Ready to promote", exact: true })
          .press("ArrowUp");
        await sheet(page).getByRole("switch", { name: "Show New students", exact: true }).click();
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await expect.poll(() => panelIds(page)).toEqual(["promotions", "newStudents"]);
        await page.reload();
        await expect(page.locator('[data-koaryu-dashboard-data-ready="true"]')).toBeVisible();
        await expect.poll(() => panelIds(page)).toEqual(["promotions", "newStudents"]);
        await page.locator('[data-home-edit="trigger"]').click();
        await expect.poll(() => rowIds(page)).toEqual(["promotions", "followUps", "newStudents"]);
        await expect(
          sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }),
        ).toHaveAttribute("aria-checked", "false");
        await sheet(page).getByRole("button", { name: "Reset to defaults" }).click();
        await expect.poll(() => panelIds(page)).toEqual(["followUps", "promotions"]);
        await expect(sheet(page).locator('[aria-live="polite"]')).toHaveText("Reset to defaults");
        await expect(sheet(page).getByRole("button", { name: "Reset to defaults" })).toBeDisabled();
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              (namespace) =>
                Object.keys(localStorage).filter((key) => key.startsWith(namespace)).length,
              namespace,
            ),
          )
          .toBe(1);
        await page
          .getByRole("button", { name: "Open account menu", exact: true })
          .filter({ visible: true })
          .click();
        await page.getByRole("button", { name: "Log out", exact: true }).click();
        await page.waitForURL("**/login");
        expect(
          await page.evaluate(
            (namespace) => Object.keys(localStorage).filter((key) => key.startsWith(namespace)),
            namespace,
          ),
        ).toEqual([]);
        expect(errors, "preview must produce no console or uncaught errors").toEqual([]);
      },
    );
    editHomeTest(`Edit Home keyboard only at ${width} in ${theme}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signIn(page, theme);
      await tabTo(page, "Edit Home");
      await page.keyboard.press("Enter");
      await expect(
        sheet(page).getByRole("button", { name: "Move Follow-ups", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => rowIds(page)).toEqual(["promotions", "followUps", "newStudents"]);
      await expect(
        sheet(page).getByRole("button", { name: "Move Follow-ups", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      await expect(
        sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }),
      ).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => panelIds(page)).toEqual(["promotions"]);
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.locator('[data-home-edit="trigger"]')).toBeFocused();
      await page.keyboard.press("Enter");
      await tabTo(page, "Reset to defaults");
      await page.keyboard.press("Enter");
      await expect(sheet(page).getByRole("button", { name: "Done", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        sheet(page).getByRole("button", { name: "Move Follow-ups", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await expect.poll(() => panelIds(page)).toEqual(["followUps", "promotions"]);
      expect(errors, "keyboard preview must produce no console or uncaught errors").toEqual([]);
    });
  }
