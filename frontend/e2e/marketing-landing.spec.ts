import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const frontendTarget = new URL(FRONTEND_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(frontendTarget.hostname)) {
  throw new Error("Landing page checks may run only against loopback.");
}

const ROOT_URL = new URL("/", frontendTarget).toString();
const SECTIONS = [
  "welcome",
  "the-problem",
  "studio",
  "product",
  "features",
  "pricing",
  "faq",
  "begin",
];

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function openLanding(page: Page, hash = "") {
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto(`${ROOT_URL}${hash}`);
  await expect(page.locator("#studio [data-step]")).toBeAttached();
}

/** Scrolls to a fraction (0 to 1) of the way through a tall, sticky section. */
async function scrollThrough(page: Page, id: string, fraction: number) {
  await page.evaluate(
    ([sectionId, amount]) => {
      const section = document.getElementById(sectionId as string)!;
      const top = section.getBoundingClientRect().top + window.scrollY;
      const range = section.offsetHeight - window.innerHeight;
      window.scrollTo({ top: top + range * (amount as number), behavior: "instant" });
    },
    [id, fraction],
  );
}

for (const [width, height] of [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
  [1440, 900],
]) {
  test(`every section is reachable by ordinary scrolling at ${width} × ${height}`, async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page);
    await page.setViewportSize({ width, height });
    await openLanding(page);

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    for (const id of SECTIONS) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await expect(page.locator("#begin").getByRole("link", { name: "Privacy" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

test("stepping inside: the doors open, then the class is marked and a student is ready", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page);
  const stage = page.locator("#studio [data-step]");
  const door = page.locator('#studio [data-side="left"]');

  await scrollThrough(page, "studio", 0);
  await expect(stage).toHaveAttribute("data-step", "0");
  await expect(page.getByText("0 of 5 present")).toBeAttached();
  const closed = await door.evaluate((node) => node.getBoundingClientRect().right);
  expect(closed).toBeGreaterThan(600);

  await scrollThrough(page, "studio", 0.3);
  await expect
    .poll(() => door.evaluate((node) => node.getBoundingClientRect().right))
    .toBeLessThanOrEqual(1);

  await scrollThrough(page, "studio", 0.55);
  await expect(stage).toHaveAttribute("data-step", "3");
  await expect(page.getByText("3 of 5 present")).toBeVisible();

  await scrollThrough(page, "studio", 0.9);
  await expect(stage).toHaveAttribute("data-step", "6");
  await expect(page.getByText("5 of 5 present")).toBeVisible();
  await expect(page.getByText("Maya Chen is ready to test for Yellow belt.")).toBeVisible();
  await expect(page.locator('#studio li[data-ready="true"]')).toHaveCount(1);

  // Scrolling back up un-marks the class: the demo follows the reader both ways.
  await scrollThrough(page, "studio", 0.4);
  await expect(stage).toHaveAttribute("data-step", "1");
});

test("the paperwork gathers into one card as the problem scrolls by", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page);
  const scrap = page.locator("#the-problem [data-kind]").first();
  const card = page.getByText("One place for all of it.");

  await scrollThrough(page, "the-problem", 0);
  const scattered = await scrap.boundingBox();
  expect(
    Number(await card.evaluate((node) => getComputedStyle(node.parentElement!).opacity)),
  ).toBeLessThan(0.2);

  await scrollThrough(page, "the-problem", 0.9);
  await expect
    .poll(() => scrap.evaluate((node) => Number(getComputedStyle(node).opacity)))
    .toBeLessThan(0.05);
  await expect(card).toBeVisible();
  const gathered = await scrap.boundingBox();
  expect(Math.abs((gathered?.x ?? 0) - (scattered?.x ?? 0))).toBeGreaterThan(100);
});

test("reduced motion shows every state still, with the doors already open", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  await expect(page.locator('#studio [data-side="left"]')).toBeHidden();
  await expect(page.getByText("One place for all of it.")).toBeAttached();
  await scrollThrough(page, "studio", 0.9);
  await expect(page.getByText("5 of 5 present")).toBeVisible();
});

test("the masthead stays available and links into the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLanding(page);
  await scrollThrough(page, "studio", 0.5);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeInViewport();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Pricing" })
    .click();
  await expect(page).toHaveURL(`${ROOT_URL}#pricing`);
  await expect(page.locator("#pricing h2")).toBeInViewport();
});

test("retired section links land on the section that now carries their content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [legacy, current] of [
    ["studio-view", "studio"],
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

test("the real product loads: both screens on desktop, the phone layout on phones", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLanding(page, "#product");
  const images = page.locator("#product img");
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) {
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
  }
  await expect(page.getByText("Belt tracker, shown with sample studio data.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(images.first()).toBeHidden();
  await expect(images.last()).toBeVisible();
});
