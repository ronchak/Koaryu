import { expect, test, type Page } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
  throw new Error("Mobile journey checks may run only against loopback.");
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
  await expect(page.locator("[data-journey-chapter]")).toHaveAttribute(
    "data-chapter-index",
    String(index),
  );
}
async function fits(page: Page, label: string) {
  const geometry = await page
    .locator("[data-mobile-stage] [data-journey-chapter]")
    .evaluate((section) => {
      const r = section.getBoundingClientRect(),
        content = section.firstElementChild!.getBoundingClientRect();
      const frame = document.querySelector("[data-enhanced]")!.getBoundingClientRect();
      return {
        clipped: Math.max(0, content.bottom - r.bottom, r.top - content.top),
        overflow: Math.max(0, section.scrollHeight - section.clientHeight),
        horizontal: Math.max(0, section.scrollWidth - section.clientWidth),
        smallestControl: Math.min(
          44,
          ...Array.from(
            section.querySelectorAll("a, button, select"),
            (control) => control.getBoundingClientRect().height,
          ),
        ),
        windowY: scrollY,
        frameTop: frame.top,
        frameBottom: frame.bottom,
        viewport: innerHeight,
      };
    });
  expect(geometry.clipped, `${label}: clipped content`).toBeLessThanOrEqual(1);
  expect(geometry.overflow, `${label}: internal scrolling`).toBeLessThanOrEqual(1);
  expect(geometry.horizontal, `${label}: horizontal overflow`).toBeLessThanOrEqual(1);
  expect(geometry.smallestControl, `${label}: touch target height`).toBeGreaterThanOrEqual(44);
  expect(geometry.windowY, label).toBe(0);
  expect(geometry.frameTop, label).toBe(0);
  expect(geometry.frameBottom, label).toBe(geometry.viewport);
}
async function inspectContent(page: Page, chapter: number) {
  const section = page.locator("[data-mobile-stage] section");
  await expect(section.getByRole("button")).toHaveCount(0);
  if (chapter === 2) {
    await expect(section.getByText("Illustrative studio morning", { exact: true })).toBeVisible();
    await expect(section.getByText("6 attendance gaps of 14+ days", { exact: true })).toBeVisible();
    await expect(section.getByText("Review attendance and notes.", { exact: true })).toBeVisible();
  } else if (chapter === 9) {
    for (const fact of [
      "No per-student tiers.",
      "Koaryu Payments: 0.5% per successful charge, plus Stripe fees.",
      "Tuition collection requires separate activation and is not generally available.",
    ])
      await expect(section.getByText(fact, { exact: true })).toBeVisible();
  } else if (chapter === 11) {
    const picker = section.getByRole("combobox", { name: "Choose a question", exact: true });
    const questions = await picker.locator("option").evaluateAll((options) =>
      options.map((option) => ({
        value: option.getAttribute("value")!,
        text: option.textContent!,
      })),
    );
    for (const question of questions) {
      await picker.selectOption(question.value);
      await expect(
        section.getByRole("heading", { name: question.text, exact: true }),
      ).toBeVisible();
      await expect(picker).toHaveValue(question.value);
      await fits(page, question.text);
    }
  }
}

for (const [width, height] of [
  [320, 480],
  [320, 568],
  [375, 667],
  [393, 617],
  [390, 844],
  [844, 390],
  [568, 320],
  [667, 375],
  [768, 1024],
]) {
  test(`every useful chapter and FAQ answer fits without scrolling at ${width} × ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openJourney(page);
    await expect(page.locator("html")).toHaveAttribute("data-koaryu-mobile-journey", "true");
    for (const index of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13]) {
      await chooseChapter(page, index);
      await fits(page, `chapter ${index + 1}`);
      await inspectContent(page, index);
    }
    expect(errors).toEqual([]);
  });
}

async function gesture(
  page: Page,
  options: { dx?: number; cancel?: boolean; multi?: boolean } = {},
) {
  return page.locator("[data-mobile-stage] section").evaluate((section, options) => {
    const target = section.firstElementChild!;
    type Contact = { clientX: number; clientY: number };
    const dispatch = (type: string, touches: Contact[], changedTouches: Contact[] = []) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: changedTouches },
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const start = { clientX: 170, clientY: 350 },
      end = { clientX: 170 + (options.dx ?? 0), clientY: 270 };
    dispatch("touchstart", options.multi ? [start, { clientX: 210, clientY: 350 }] : [start]);
    const prevented = dispatch("touchmove", [end]);
    if (options.cancel) dispatch("touchcancel", []);
    dispatch("touchend", [], [end]);
    return prevented;
  }, options);
}

test("vertical gestures advance directly, while horizontal, canceled and multi-touch gestures do not", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await openJourney(page, "#use-cases");
  await gesture(page, { dx: 160 });
  await gesture(page, { cancel: true });
  await gesture(page, { multi: true });
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "use-cases",
  );
  expect(await gesture(page)).toBe(true);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "signals-gather",
  );
  await fits(page, "after swipe");
});

test("native touch movement leaves the document fixed before and after changing chapters", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium supplies native touch input through CDP.");
  await page.setViewportSize({ width: 393, height: 617 });
  await openJourney(page, "#features");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 180, y: 340 }],
  });
  for (const y of [332, 316, 294, 264]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 180, y }] });
    expect(
      await page.evaluate(() => ({
        y: scrollY,
        top: document.querySelector("[data-enhanced]")!.getBoundingClientRect().top,
      })),
    ).toEqual({ y: 0, top: 0 });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "use-cases",
  );
  await fits(page, "native swipe");
});

test("wheel and keyboard navigation change chapters instead of scrolling a card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await openJourney(page, "#use-cases");
  await page.mouse.move(180, 350);
  await page.mouse.wheel(0, 120);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "signals-gather",
  );
  await page.locator("[data-journey-chapter]").focus();
  await page.keyboard.press("End");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
  await page.locator("[data-journey-chapter]").focus();
  await page.keyboard.press("Home");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "welcome",
  );
  await fits(page, "keyboard navigation");
});

test("mobile document lock cleans up on desktop resize and route exit", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await openJourney(page, "#features");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("html")).not.toHaveAttribute("data-koaryu-mobile-journey", "true");
  await expect(page.locator("[data-journey-chapter]")).toHaveCount(14);
  await expect(page.locator("svg image")).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe("fixed");
  await page.setViewportSize({ width: 393, height: 617 });
  await expect(page.locator("[data-mobile-stage]")).toBeVisible();
  await page.getByRole("link", { name: "Student records", exact: true }).click();
  await expect(page).toHaveURL(/\/features\/student-management$/);
  await expect(page.locator("html")).not.toHaveAttribute("data-koaryu-mobile-journey", "true");
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe("fixed");
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.goBack();
  await expect(page.locator("html")).toHaveAttribute("data-koaryu-mobile-journey", "true");
  await fits(page, "returned to journey");
});

test("FAQ deep links, question selection and landscape menu stay usable without scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await openJourney(page, "#faq-pricing");
  await expect(
    page.getByRole("heading", { name: "What does $27/month include?", exact: true }),
  ).toBeVisible();
  const picker = page.getByRole("combobox", { name: "Choose a question", exact: true });
  await picker.focus();
  await picker.selectOption("4:1");
  await expect(page).toHaveURL(/#faq-data$/);
  await expect(
    page.getByRole("heading", { name: "Can staff see billing records?", exact: true }),
  ).toBeVisible();
  await expect(picker).toBeFocused();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "Mobile", exact: true });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
  await menu.getByRole("link", { name: "Pricing", exact: true }).click();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "pricing",
  );
  await fits(page, "landscape pricing");
});

test("mobile animation settles after interruption and respects reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openJourney(page);
  await expect(page.locator("svg image")).toHaveCount(3);
  await chooseChapter(page, 8);
  await chooseChapter(page, 2);
  await expect(page.locator("svg[data-scene-progress]")).toHaveAttribute(
    "data-scene-progress",
    "0.24",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await chooseChapter(page, 3);
  await expect(page.locator("svg[data-scene-progress]")).toHaveAttribute(
    "data-scene-progress",
    "0.29",
  );
});

test("mobile has twelve stops and consistently normalizes the stillness hash", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openJourney(page, "#stillness");
  await expect(page).toHaveURL(/#begin$/);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
  const picker = page.getByRole("combobox", { name: "Choose chapter", exact: true });
  await expect(picker.locator("option")).toHaveCount(12);
  await expect(page.locator("[data-journey-chapter]")).toHaveAttribute(
    "aria-label",
    "Chapter 12 of 12",
  );
  await page.getByRole("button", { name: "Previous chapter", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute("data-active-chapter", "faq");
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
  await page.evaluate(() => {
    location.hash = "faq-pricing";
  });
  await expect(
    page.getByRole("heading", { name: "What does $27/month include?", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    location.hash = "stillness";
  });
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "stillness",
  );
  await expect(page.locator("[data-journey-chapter]")).toHaveCount(14);
  await page.setViewportSize({ width: 568, height: 320 });
  await expect(page).toHaveURL(/#begin$/);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "begin",
  );
});

test("every mobile guide choice reaches its document in one action", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 393, height: 617 });
  for (const hash of ["features", "use-cases", "about"]) {
    await openJourney(page, `#${hash}`);
    const links = await page.locator("[data-mobile-stage] a").evaluateAll((anchors) =>
      anchors.map((a) => ({
        label: a.textContent!.replace("→", "").trim(),
        href: a.getAttribute("href")!,
      })),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      await openJourney(page, `#${hash}`);
      await page
        .locator("[data-mobile-stage]")
        .getByRole("link", { name: link.label, exact: true })
        .click();
      await expect(page).toHaveURL(new URL(link.href, origin).toString());
      await expect(page.locator("html")).not.toHaveAttribute("data-koaryu-mobile-journey", "true");
    }
  }
});

test("mobile skips Guides in both directions and replaces its direct hash", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await openJourney(page, "#signals-gather");
  await page.getByRole("button", { name: "Next chapter", exact: true }).click();
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "class-ready",
  );
  await page.getByRole("button", { name: "Previous chapter", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "signals-gather",
  );
  await gesture(page);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "class-ready",
  );
  await page.locator("[data-journey-chapter]").focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "signals-gather",
  );
  const historyLength = await page.evaluate(() => {
    const expectedLength = history.length + 1;
    history.pushState(null, "", "#explore");
    dispatchEvent(new HashChangeEvent("hashchange"));
    return expectedLength;
  });
  await expect(page).toHaveURL(/#features$/);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "features",
  );
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.goBack();
  await expect(page).toHaveURL(/#signals-gather$/);
  await page.goForward();
  await expect(page).toHaveURL(/#features$/);
  await openJourney(page, "#explore");
  await expect(page).toHaveURL(/#features$/);
  await openJourney(page, "#patterns-form");
  await expect(page).toHaveURL(/#features$/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openJourney(page, "#explore");
  await expect(page).toHaveURL(/#explore$/);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "explore",
  );
  await expect(page.locator("[data-journey-chapter]")).toHaveCount(14);
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(page).toHaveURL(/#features$/);
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "features",
  );
});
