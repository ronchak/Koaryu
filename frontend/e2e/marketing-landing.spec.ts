import { expect, test, type Page } from "@playwright/test";

import { MOMENTUM_STALL_MS } from "../src/components/marketing/journey/paging-model";
import { landingPageContent } from "../src/lib/landing-page-content";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const frontendTarget = new URL(FRONTEND_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(frontendTarget.hostname)) {
  throw new Error("Landing page checks may run only against loopback.");
}

const ROOT_URL = new URL("/", frontendTarget).toString();
/** The paged story's one-screen chapters, in order, and the still frame each rests on. */
const STORY = landingPageContent.story.map((chapter) => chapter.id);
const STILL: Record<string, number> = Object.fromEntries(
  landingPageContent.story.map((chapter) => [chapter.id, Math.round(chapter.scene * 100) / 100]),
);
/** The native page the story hands off to. */
const PAGE_SECTIONS = ["pricing", "try", "faq", "begin"];

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function openLanding(page: Page, hash = "") {
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto(`${ROOT_URL}${hash}`);
  await expect(page.locator("[data-enhanced]")).toHaveAttribute("data-enhanced", "true");
}

async function sceneProgress(page: Page) {
  return Number(
    await page.locator("svg[data-scene-progress]").first().getAttribute("data-scene-progress"),
  );
}

/** Waits until a paging animation has come to rest. */
async function settle(page: Page) {
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        const y = await page.evaluate(() => Math.round(window.scrollY));
        const still = y === previous;
        previous = y;
        return still;
      },
      { intervals: [200], timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * One deliberate gesture: a single wheel flick at the middle of the viewport,
 * after the pause a reader leaves between flicks. A flick sooner than that, no
 * larger than the last, is swallowed as the previous gesture's momentum tail.
 */
async function flick(page: Page, deltaY: number) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.waitForTimeout(MOMENTUM_STALL_MS + 100);
  await page.mouse.wheel(0, deltaY);
  await settle(page);
}

async function centerChapter(page: Page, id: string) {
  await page.evaluate((chapterId) => {
    const chapter = document.getElementById(chapterId)!;
    const box = chapter.getBoundingClientRect();
    window.scrollTo(0, box.top + window.scrollY + box.height / 2 - window.innerHeight / 2);
  }, id);
}

for (const [width, height] of [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
  [1440, 900],
]) {
  test(`every chapter is reachable by ordinary scrolling at ${width} × ${height}`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await page.setViewportSize({ width, height });
    await openLanding(page);
    const journey = page.locator("[data-enhanced]");

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    // Each wheel gesture pages to the next chapter of the story.
    for (const [index, id] of STORY.slice(1).entries()) {
      const reading = STORY[index]!;
      // The day timeline reads in its own panel first; the story moves on from its end.
      const panel = page.locator(`#${reading} [data-panel]`);
      const scrolls = await panel.evaluateAll((nodes) =>
        nodes.some((node) => node.scrollHeight > node.clientHeight + 4),
      );
      if (scrolls) {
        await flick(page, 240);
        await expect(journey).toHaveAttribute("data-active", reading);
        await expect.poll(() => panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        await panel.evaluate((node) =>
          node.scrollTo({ top: node.scrollHeight, behavior: "instant" }),
        );
      }
      await flick(page, 240);
      await expect(journey).toHaveAttribute("data-active", id);
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    // One more hands the story off to the native page, which scrolls like any document.
    await flick(page, 240);
    await expect(journey).toHaveAttribute("data-zone", "page");
    for (const id of PAGE_SECTIONS) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await expect(page.locator("#begin").getByRole("link", { name: "Privacy" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

test("wheel, keys and swipes each move exactly one chapter", async ({ browser }) => {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await openLanding(desktop);
  const journey = desktop.locator("[data-enhanced]");
  await flick(desktop, 120);
  await expect(journey).toHaveAttribute("data-active", STORY[1]!);
  await desktop.keyboard.press("ArrowDown");
  await settle(desktop);
  await expect(journey).toHaveAttribute("data-active", STORY[2]!);
  await desktop.keyboard.press("ArrowUp");
  await settle(desktop);
  await expect(journey).toHaveAttribute("data-active", STORY[1]!);
  await desktop.close();

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const phone = await context.newPage();
  await openLanding(phone);
  const cdp = await context.newCDPSession(phone);
  const swipe = async (distance: number) => {
    const x = 195;
    const start = 600;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: start }],
    });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: start - (distance * step) / 8 }],
      });
      await phone.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(phone);
  };
  const phoneJourney = phone.locator("[data-enhanced]");
  await swipe(260);
  await expect(phoneJourney).toHaveAttribute("data-active", STORY[1]!);
  await swipe(260);
  await expect(phoneJourney).toHaveAttribute("data-active", STORY[2]!);
  await swipe(-260);
  await expect(phoneJourney).toHaveAttribute("data-active", STORY[1]!);
  await context.close();
});

test("the scene follows the scroll position from the hills to the seated class", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page);
  expect(await sceneProgress(page)).toBe(0);

  await centerChapter(page, "features");
  await expect.poll(() => sceneProgress(page)).toBeCloseTo(0.5, 1);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => sceneProgress(page)).toBe(1);

  // The native page keeps scripted jumps out of the story; Home travels back to the hills.
  await page.keyboard.press("Home");
  await expect.poll(() => sceneProgress(page)).toBe(0);
});

test("reduced motion shows each chapter's still frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const id of STORY) {
    await openLanding(page, `#${id}`);
    await expect.poll(() => sceneProgress(page)).toBe(STILL[id]);
  }
  // The seated class stays behind the native page.
  await openLanding(page, "#pricing");
  await expect.poll(() => sceneProgress(page)).toBe(1);
});

test("the masthead stays available and gains a ground once the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  const journey = page.locator("[data-scrolled]");
  await expect(journey).toHaveAttribute("data-scrolled", "false");
  await flick(page, 240);
  await expect(journey).toHaveAttribute("data-scrolled", "true");
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeInViewport();

  const pricing = page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Pricing" });
  await pricing.click();
  await expect(page).toHaveURL(`${ROOT_URL}#pricing`);
  await expect(page.locator("#pricing h2")).toBeInViewport();

  // Following the same link again travels but adds no history entry.
  const entries = await page.evaluate(() => window.history.length);
  await pricing.click();
  await settle(page);
  expect(await page.evaluate(() => window.history.length)).toBe(entries);
  await page.goBack();
  await expect(page).not.toHaveURL(`${ROOT_URL}#pricing`);
});

test("the phone menu closes once its link starts travelling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page);
  await page.locator('summary[aria-label="Navigation menu"]').click();
  const menu = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Pricing" }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(`${ROOT_URL}#pricing`);
  await settle(page);
  await expect(page.locator("#pricing h2")).toBeInViewport();
});

test("retired chapter links land on the section that now carries their content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [legacy, current] of [
    ["studio-view", "product"],
    ["explore", "features"],
    ["about", "faq"],
    ["faq-roadmap", "faq-limits"],
  ]) {
    await openLanding(page, `#${legacy}`);
    await expect(page).toHaveURL(`${ROOT_URL}#${current}`);
    await expect(page.locator(`#${current}`)).toBeInViewport();
  }
});

test("FAQ answers open in place and are findable as ordinary text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page, "#faq");
  const question = page.getByText("What doesn't Koaryu do yet?");
  await question.click();
  await expect(page.getByText(/no multi-location dashboard/)).toBeVisible();
  await question.click();
  await expect(page.getByText(/no multi-location dashboard/)).toBeHidden();
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
]) {
  test(`the product chapter loads its desktop and phone screens at ${width} × ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openLanding(page, "#product");
    const { image } = landingPageContent.story.find((chapter) => chapter.kind === "product")!;
    for (const [screen, file] of [
      [page.getByAltText(image.alt), "belt-tracker.webp"],
      [page.getByAltText(image.mobile.alt), "belt-tracker-mobile.webp"],
    ] as const) {
      await expect(screen).toBeVisible();
      await expect
        .poll(() => screen.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      expect(
        decodeURIComponent(await screen.evaluate((node: HTMLImageElement) => node.currentSrc)),
      ).toContain(file);
    }
    await expect(page.getByText(image.caption)).toBeVisible();
  });
}

test("the scene holds still while a chapter is read and moves only between chapters", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page, "#product");
  await expect.poll(() => sceneProgress(page)).toBe(STILL.product);
  // The progress attribute is rounded; let the camera finish its last fraction of easing.
  await page.waitForTimeout(800);

  // Resting on a chapter, the artwork receives no writes.
  await page.evaluate(() => {
    const svg = document.querySelector("svg[data-scene-progress]")!;
    const tracker = window as unknown as { sceneWrites: number; progress: string[] };
    tracker.sceneWrites = 0;
    tracker.progress = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === svg && record.attributeName === "data-scene-progress") {
          tracker.progress.push(svg.getAttribute("data-scene-progress")!);
        } else if (!(record.target === svg && record.attributeName === "style")) {
          tracker.sceneWrites += 1;
        }
      }
    }).observe(svg, { attributes: true, subtree: true });
  });
  await page.waitForTimeout(1_000);
  expect(
    await page.evaluate(() => (window as unknown as { sceneWrites: number }).sceneWrites),
  ).toBe(0);
  expect(await sceneProgress(page)).toBe(STILL.product);

  // The next gesture plays the beat between this chapter and the next.
  await flick(page, 240);
  await expect(page.locator("[data-enhanced]")).toHaveAttribute("data-active", "features");
  await expect.poll(() => sceneProgress(page)).toBe(STILL.features);
  const travelled = await page.evaluate(() =>
    (window as unknown as { progress: string[] }).progress.map(Number),
  );
  expect(travelled.some((value) => value > STILL.product! && value < STILL.features!)).toBe(true);
});

test("on phones the masthead steps aside while reading down and returns on scroll up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = page.locator("[data-masthead-hidden]");

  // The story's one-screen chapters keep it in place.
  await openLanding(page);
  await flick(page, 240);
  await expect(journey).toHaveAttribute("data-active", STORY[1]!);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "false");

  // Reading down the native page lets it step aside; any scroll up brings it back.
  await openLanding(page, "#pricing");
  await page.mouse.move(195, 400);
  for (let step = 0; step < 3; step += 1) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(250);
  }
  await expect(journey).toHaveAttribute("data-masthead-hidden", "true");
  await page.mouse.wheel(0, -120);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "false");
  await expect(page.locator("[data-header-action]")).toBeInViewport();

  // The desktop masthead always stays.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, 200);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "false");
});
