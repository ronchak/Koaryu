import { expect, test, type Page } from "@playwright/test";

const FRONTEND_URL = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const frontendTarget = new URL(FRONTEND_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(frontendTarget.hostname)) {
  throw new Error("Marketing journey history checks may run only against loopback.");
}

const ROOT_URL = new URL("/", frontendTarget).toString();
const ABOUT_URL = new URL("/about", frontendTarget).toString();

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectJourneyChapter(page: Page, hash: string, chapter: string) {
  await expect(page).toHaveURL(new URL(hash, ROOT_URL).toString());
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    chapter
  );
}

async function expectHealthyPage(page: Page, pageErrors: string[]) {
  await expect(
    page.locator(
      "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay"
    )
  ).toHaveCount(0);
  expect(pageErrors, "expected no uncaught browser page errors").toEqual([]);
}

test("explicit landing links preserve Back, Forward, and duplicate history", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(ROOT_URL);

  const journey = page.locator("[data-active-chapter]");
  await expect(journey).toHaveAttribute("data-enhanced", "true");
  await expect(journey).toHaveAttribute("data-active-chapter", "welcome");
  const initialHistoryLength = await page.evaluate(() => window.history.length);

  await page
    .getByRole("link", { name: "See how it works", exact: true })
    .click();
  await expectJourneyChapter(page, "#studio-view", "studio-view");
  await expect
    .poll(() => page.evaluate(() => window.history.length))
    .toBe(initialHistoryLength + 1);

  const pricingLink = page
    .getByRole("link", { name: "Pricing", exact: true })
    .filter({ visible: true });
  await expect(pricingLink).toHaveCount(1);
  await pricingLink.click();
  await expectJourneyChapter(page, "#pricing", "pricing");
  await expect
    .poll(() => page.evaluate(() => window.history.length))
    .toBe(initialHistoryLength + 2);

  await page.goBack();
  await expectJourneyChapter(page, "#studio-view", "studio-view");
  await page.goForward();
  await expectJourneyChapter(page, "#pricing", "pricing");

  const historyLengthBeforeRepeat = await page.evaluate(
    () => window.history.length
  );
  await pricingLink.click();
  await expectJourneyChapter(page, "#pricing", "pricing");
  expect(await page.evaluate(() => window.history.length)).toBe(
    historyLengthBeforeRepeat
  );

  await expectHealthyPage(page, pageErrors);
});

test("passive chapter movement replaces the current landing entry", async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(ABOUT_URL);

  await Promise.all([
    page.waitForURL(ROOT_URL),
    page
      .getByRole("link", { name: "Return to Koaryu home", exact: true })
      .first()
      .click(),
  ]);
  const journey = page.locator("[data-active-chapter]");
  await expect(journey).toHaveAttribute("data-enhanced", "true");
  await expect(journey).toHaveAttribute("data-active-chapter", "welcome");
  const landingHistoryLength = await page.evaluate(() => window.history.length);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("ArrowDown");
  await expectJourneyChapter(page, "#the-problem", "the-problem");
  expect(await page.evaluate(() => window.history.length)).toBe(
    landingHistoryLength
  );

  await page.goBack();
  await expect(page).toHaveURL(ABOUT_URL);
  await expectHealthyPage(page, pageErrors);
});
