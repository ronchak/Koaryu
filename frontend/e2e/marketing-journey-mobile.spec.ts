import { expect, test, type Page } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Mobile journey checks may run only against loopback.");
}

test.use({ contextOptions: { reducedMotion: "reduce", hasTouch: true } });

async function openJourney(page: Page, hash = "") {
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto(`${origin}/${hash}`);
  await expect(page.locator("[data-enhanced]")).toHaveAttribute("data-enhanced", "true");
}

async function chooseChapter(page: Page, index: number) {
  await page
    .getByRole("combobox", { name: "Choose chapter", exact: true })
    .selectOption(String(index));
  await expect(page.locator('[data-journey-chapter][aria-hidden="false"]')).toHaveAttribute(
    "data-chapter-index",
    String(index),
  );
}

for (const [width, height] of [
  [320, 568],
  [375, 667],
  [390, 844],
  [393, 665],
  [844, 390],
  [768, 1024],
]) {
  test(`all chapters remain readable at ${width} × ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openJourney(page);
    for (let index = 0; index < 14; index++) {
      if (index) await page.getByRole("button", { name: "Next chapter", exact: true }).click();
      const chapter = page.locator('[data-journey-chapter][aria-hidden="false"]');
      await expect(chapter).toHaveAttribute("data-chapter-index", String(index));
      const geometry = await chapter.evaluate((element) => {
        const panel = element as HTMLElement;
        const bounds = panel.getBoundingClientRect();
        const content = panel.firstElementChild as HTMLElement;
        const start = content.getBoundingClientRect();
        panel.scrollTop = panel.scrollHeight;
        const end = content.getBoundingClientRect();
        const pager = document
          .querySelector('[aria-label="Journey controls"]')!
          .getBoundingClientRect();
        return {
          horizontalOverflow: panel.scrollWidth - panel.clientWidth,
          startVisible: start.top >= bounds.top - 1,
          endReachable: end.bottom <= bounds.bottom + 1,
          clearsPager: bounds.bottom <= pager.top,
          hiddenCopy: [...panel.querySelectorAll("p")].filter(
            (p) => getComputedStyle(p).display === "none",
          ).length,
          documentOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry, `chapter ${index + 1}`).toEqual({
        horizontalOverflow: 0,
        startVisible: true,
        endReachable: true,
        clearsPager: true,
        hiddenCopy: 0,
        documentOverflow: false,
      });
    }
    expect(errors).toEqual([]);
  });
}

async function gesture(
  page: Page,
  options: { scroll?: boolean; dx?: number; cancel?: boolean; multi?: boolean } = {},
) {
  await page.locator('[data-journey-chapter][aria-hidden="false"]').evaluate((panel, options) => {
    const target = panel.firstElementChild!;
    type Contact = { identifier: number; clientX: number; clientY: number };
    // WebKit exposes Touch but disallows constructing it. These events exercise
    // boundary decisions; the separate wheel test covers native scrolling.
    const dispatchTouch = (type: string, touches: Contact[], changedTouches: Contact[] = []) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: changedTouches },
      });
      target.dispatchEvent(event);
    };
    const start = { identifier: 1, clientX: 170, clientY: 450 };
    const second = { identifier: 2, clientX: 230, clientY: 450 };
    dispatchTouch("touchstart", options.multi ? [start, second] : [start]);
    if (options.scroll) panel.scrollTop = panel.scrollHeight;
    if (options.cancel) dispatchTouch("touchcancel", []);
    const end = { identifier: 1, clientX: 170 + (options.dx ?? 0), clientY: 370 };
    dispatchTouch("touchend", [], [end]);
  }, options);
}

test("reading scroll, horizontal swipes, canceled touches and pinches never skip a chapter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openJourney(page, "#use-cases");
  const journey = page.locator("[data-active-chapter]");
  await gesture(page, { scroll: true });
  await expect(journey).toHaveAttribute("data-active-chapter", "use-cases");
  await gesture(page, { dx: 160 });
  await gesture(page, { cancel: true });
  await gesture(page, { multi: true });
  await expect(journey).toHaveAttribute("data-active-chapter", "use-cases");
  await gesture(page);
  await expect(journey).toHaveAttribute("data-active-chapter", "signals-gather");
});

test("native wheel scrolling reaches the bottom without skipping, and mobile FAQ has one scroll area", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openJourney(page, "#use-cases");
  await page.mouse.move(170, 450);
  await page.mouse.wheel(0, 180);
  await expect
    .poll(() => page.locator("#use-cases").evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "use-cases",
  );
  await chooseChapter(page, 11);
  await page.getByRole("combobox", { name: "Question topic", exact: true }).selectOption("3");
  await page
    .getByRole("button", { name: "Do I have to use Koaryu for payments?", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Do I have to use Koaryu for payments?", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    await page.locator("[data-faq-scroll]").evaluate((e) => getComputedStyle(e).overflowY),
  ).toBe("visible");
});

test("desktop keeps the original scene materials and chapter geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openJourney(page);
  await expect(page.locator("[data-compact]")).toHaveAttribute("data-compact", "false");
  expect(
    await page
      .locator("#welcome")
      .evaluate((e) => ({ height: e.clientHeight, overflow: getComputedStyle(e).overflowY })),
  ).toEqual({ height: 900, overflow: "clip" });
  await expect(page.locator("svg image")).toHaveCount(0);
  await page.getByRole("link", { name: "See how it works", exact: true }).click();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "studio-view",
  );
});

test("mobile animation settles after interruption and uses the baked materials", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openJourney(page);
  await expect(page.locator("svg image")).toHaveCount(3);
  await chooseChapter(page, 7);
  await chooseChapter(page, 2);
  await expect(page.locator("svg[data-scene-progress]")).toHaveAttribute(
    "data-scene-progress",
    "0.24",
  );
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "studio-view",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expect(page.locator("svg[data-scene-progress]")).toHaveAttribute(
    "data-scene-progress",
    "0.29",
  );
});

test("Home and End navigate short compact chapters but scroll long chapters", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openJourney(page, "#studio-view");
  await expect(page.locator("#studio-view")).toBeVisible();
  await page.locator("#studio-view").focus();
  await expect(page.locator("#studio-view")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
  await expect(page.locator("#begin")).toBeVisible();
  await page.locator("#begin").focus();
  await expect(page.locator("#begin")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "welcome",
  );
  await chooseChapter(page, 5);
  await expect(page.locator("#use-cases")).toBeVisible();
  await page.locator("#use-cases").focus();
  await expect(page.locator("#use-cases")).toBeFocused();
  await page.keyboard.press("End");
  await expect
    .poll(() => page.locator("#use-cases").evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "use-cases",
  );
  await page.keyboard.press("Home");
  await expect.poll(() => page.locator("#use-cases").evaluate((e) => e.scrollTop)).toBe(0);
});

test("mobile framing keeps balanced margins, contrast and readable topic controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 665 });
  await openJourney(page, "#studio-view");
  const framing = await page.locator("#studio-view article").evaluate((card) => {
    const r = card.getBoundingClientRect();
    const header = document.querySelector("header")!;
    return {
      left: r.left,
      right: innerWidth - r.right,
      top: r.top - header.getBoundingClientRect().bottom,
      color: getComputedStyle(header).color,
      background: getComputedStyle(header).backgroundColor,
    };
  });
  expect(Math.abs(framing.left - framing.right)).toBeLessThan(1);
  expect(framing.top).toBeGreaterThanOrEqual(16);
  expect(framing.top).toBeLessThanOrEqual(24);
  expect(framing.color).not.toBe(framing.background);
  await chooseChapter(page, 4);
  expect(await page.locator("header").evaluate((e) => getComputedStyle(e).color)).toBe(
    framing.color,
  );
  await expect(
    page.getByRole("navigation", { name: "Journey chapters", exact: true }),
  ).toBeHidden();
  await page.locator("#features").evaluate((e) => (e.scrollTop = e.scrollHeight));
  await chooseChapter(page, 7);
  await chooseChapter(page, 4);
  expect(await page.locator("#features").evaluate((e) => e.scrollTop)).toBe(0);
  await chooseChapter(page, 11);
  await page.getByRole("combobox", { name: "Question topic", exact: true }).selectOption("4");
  await expect(page).toHaveURL(/#faq-data$/);
  await expect(
    page.getByRole("button", { name: "Who owns the studio data?", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("combobox", { name: "Question topic", exact: true })).toBeHidden();
  await expect(page.getByRole("link", { name: "Data & Access", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("landscape mobile navigation opens and fits above the chapter controls", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openJourney(page);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "Mobile", exact: true });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate(
      (e) =>
        e.getBoundingClientRect().bottom <=
        document.querySelector('[aria-label="Journey controls"]')!.getBoundingClientRect().top,
    ),
  ).toBe(true);
  await menu.getByRole("link", { name: "Pricing", exact: true }).click();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "pricing",
  );
  await expect(menu).toBeHidden();
});
