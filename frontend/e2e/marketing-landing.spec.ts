import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const frontendTarget = new URL(FRONTEND_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(frontendTarget.hostname)) {
  throw new Error("Landing page checks may run only against loopback.");
}

const ROOT_URL = new URL("/", frontendTarget).toString();
const CHAPTERS = ["welcome", "the-problem", "product", "features", "pricing", "faq", "begin"];

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

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    for (const id of CHAPTERS) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await expect(page.locator("#begin").getByRole("link", { name: "Privacy" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

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

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => sceneProgress(page)).toBe(0);
});

test("reduced motion shows each chapter's still frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  await centerChapter(page, "product");
  await expect.poll(() => sceneProgress(page)).toBe(0.29);
  await centerChapter(page, "pricing");
  await expect.poll(() => sceneProgress(page)).toBe(0.66);
});

test("the masthead stays available and gains a ground once the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  const journey = page.locator("[data-scrolled]");
  await expect(journey).toHaveAttribute("data-scrolled", "false");
  await centerChapter(page, "features");
  await expect(journey).toHaveAttribute("data-scrolled", "true");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeInViewport();

  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Pricing" })
    .click();
  await expect(page).toHaveURL(`${ROOT_URL}#pricing`);
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

test("the product screenshot loads with its sample-data caption", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page, "#product");
  const image = page.locator("#product img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByText("Belt tracker, shown with sample studio data.")).toBeVisible();
});

test("the scene holds still while a chapter is read and moves only between chapters", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page);
  await centerChapter(page, "features");
  await expect.poll(() => sceneProgress(page)).toBe(0.52);
  // The progress attribute is rounded; let the camera finish its last fraction of easing.
  await page.waitForTimeout(800);

  // Reading within the chapter: the artwork receives no writes; only the
  // composited drift on the root changes, so the frame is alive but cheap.
  await page.evaluate(() => {
    const svg = document.querySelector("svg[data-scene-progress]")!;
    const tracker = window as unknown as { sceneWrites: number };
    tracker.sceneWrites = 0;
    new MutationObserver((records) => {
      tracker.sceneWrites += records.filter(
        (record) => !(record.target === svg && record.attributeName === "style"),
      ).length;
    }).observe(svg, { attributes: true, subtree: true });
  });
  const driftBefore = await page
    .locator("svg[data-scene-progress]")
    .first()
    .evaluate((svg) => (svg as SVGElement).style.transform);
  for (const step of [-120, 80, 120, -60]) {
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => (window as unknown as { sceneWrites: number }).sceneWrites),
  ).toBe(0);
  expect(await sceneProgress(page)).toBe(0.52);
  const driftAfter = await page
    .locator("svg[data-scene-progress]")
    .first()
    .evaluate((svg) => (svg as SVGElement).style.transform);
  expect(driftAfter).toMatch(/^scale\(/);
  // With snapping, small reading scrolls settle back onto the chapter, so the drift returns too.
  const snaps = await page.evaluate(
    () => getComputedStyle(document.documentElement).scrollSnapType !== "none",
  );
  if (!snaps) expect(driftAfter).not.toBe(driftBefore);

  // Scrolling into the gap after the chapter plays the next beat.
  await page.locator("[data-journey-interlude]").nth(3).scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const gap = document.querySelectorAll("[data-journey-interlude]")[3]!;
    const box = gap.getBoundingClientRect();
    window.scrollTo({
      top: box.top + window.scrollY + box.height / 2 - innerHeight / 2,
      behavior: "instant",
    });
  });
  await expect.poll(() => sceneProgress(page)).toBeGreaterThan(0.52);
  expect(await sceneProgress(page)).toBeLessThan(0.66);
});

test("on phones the masthead steps aside while reading down and returns on scroll up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page);
  const journey = page.locator("[data-masthead-hidden]");
  await page.mouse.move(195, 400);
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 200);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "true");
  await page.mouse.wheel(0, -120);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "false");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeInViewport();

  // The desktop masthead always stays.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 200);
  await expect(journey).toHaveAttribute("data-masthead-hidden", "false");
});

test("phones get the phone layout of the product", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page, "#product");
  const image = page.locator("#product img");
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.currentSrc))
    .toContain("belt-tracker-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.currentSrc))
    .toMatch(
      /belt-tracker\.webp|belt-tracker\.webp&|url=%2Fmarketing%2Fproduct%2Fbelt-tracker\.webp/,
    );
});
