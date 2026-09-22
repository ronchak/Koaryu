import { expect, test, type Page } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Marketing page checks may run only against loopback.");
}

const routes = [
  "/features",
  "/features/student-management",
  "/features/belt-tracking",
  "/features/attendance",
  "/features/billing",
  "/use-cases",
  "/use-cases/spreadsheets-to-studio-crm",
  "/use-cases/student-retention",
  "/use-cases/trial-to-enrollment",
  "/use-cases/tuition-cleanup",
  "/use-cases/belt-test-readiness",
  "/explore",
  "/about",
  "/studio-types/family-martial-arts-schools",
];

test.use({ contextOptions: { reducedMotion: "reduce", hasTouch: true } });

async function openDocument(page: Page, path: string) {
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  const response = await page.goto(`${origin}${path}`);
  expect(response?.ok(), path).toBeTruthy();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `https://koaryu.app${path}`,
  );
}

async function expectDocumentFits(page: Page, label: string, checkTargets = true) {
  const issues = await page.locator("main").evaluate((main) => {
    const visible = (element: Element) =>
      element.getClientRects().length > 0 &&
      !element.closest('[aria-hidden="true"]') &&
      !element.closest("details:not([open]) > :not(summary)") &&
      getComputedStyle(element).visibility !== "hidden";
    const describe = (element: Element) =>
      `${element.tagName}: ${(element.textContent || "").trim().slice(0, 70)}`;
    return {
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      // Inspect children as well: overflow-x: clip on a shell can conceal a broken layout.
      clipped: [...main.querySelectorAll("h1,h2,h3,p,a,button,summary,figure,dl,li,table")]
        .filter(visible)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
        })
        .map(describe),
      smallTargets: [...main.querySelectorAll("a,button:not([disabled]),summary")]
        .filter(visible)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width < 43 || box.height < 43;
        })
        .map(describe),
      brokenAnchors: [...main.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
        .filter((link) => !document.getElementById(decodeURIComponent(link.hash.slice(1))))
        .map((link) => link.hash),
    };
  });
  expect(issues.documentOverflow, `${label}: document overflow`).toBeLessThanOrEqual(1);
  expect(issues.clipped, `${label}: clipped content`).toEqual([]);
  if (checkTargets) expect(issues.smallTargets, `${label}: touch targets`).toEqual([]);
  expect(issues.brokenAnchors, `${label}: section links`).toEqual([]);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 393, height: 617 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 1440, height: 900 },
]) {
  test(`all marketing guides remain readable at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const path of routes) {
      await openDocument(page, path);
      await expectDocumentFits(page, path);
      // Expand native FAQs to check the answer, not only the collapsed overview.
      const summaries = page.locator("main details > summary");
      for (let index = 0; index < (await summaries.count()); index += 1) {
        const summary = summaries.nth(index);
        if ((await summary.locator("..").getAttribute("open")) !== null) await summary.click();
        await summary.click();
        await expect(summary.locator("..")).toHaveAttribute("open", "");
        await expectDocumentFits(page, `${path} answer ${index}`);
        await summary.click();
      }
      await page.locator("footer").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => scrollY),
        `${path}: ordinary document scrolling`,
      ).toBeGreaterThan(0);
      // Revealing footer links starts Next prefetches. Let this document finish
      // before the next hard goto; WebKit otherwise reports cancelled RSC reads
      // from the outgoing page as access-control errors. Keep all pageerrors.
      await page.waitForLoadState("networkidle");
    }
    expect(errors).toEqual([]);
  });
}

test("mobile document navigation dismisses, restores focus, and follows routes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await openDocument(page, "/explore");
  // Summary semantics differ between engines; use the native element as the stable target.
  const summary = page.locator('summary[aria-label="Navigation menu"]');
  const menu = page.getByRole("navigation", { name: "Mobile navigation" });
  await summary.click();
  await expect(menu).toBeVisible();
  const box = await summary.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
  await menu.getByRole("link", { name: "Features", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(summary).toBeFocused();
  await summary.click();
  await page.locator("main").click({ position: { x: 4, y: 10 } });
  await expect(menu).not.toBeVisible();
  await summary.click();
  await menu.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/about`);
  await expect(menu).not.toBeVisible();
});

test("document navigation and guide links work before JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 568 },
  });
  const page = await context.newPage();
  try {
    await openDocument(page, "/explore");
    await page.locator('summary[aria-label="Navigation menu"]').click();
    const menu = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "About", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/about`);
    await expect(page.locator("h1")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a marketing detail releases the landing lock and Back restores the journey", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 617 });
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto(`${origin}/#features`);
  await expect(page.locator("[data-enhanced]")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("button", { name: "Student CRM", exact: true }).click();
  await page.getByRole("link", { name: "Explore this feature", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/features/student-management`);
  await expect(page.locator("html")).not.toHaveAttribute("data-koaryu-mobile-journey", "true");
  await page.locator("footer").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/#features`);
  await expect(page.locator("html")).toHaveAttribute("data-koaryu-mobile-journey", "true");
  await expect(page.locator("[data-active-chapter]")).toHaveAttribute(
    "data-active-chapter",
    "features",
  );
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("legal pages retain readable documents and shared navigation", async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/privacy", "/terms"]) {
      await openDocument(page, path);
      // Legal prose retains normal inline links; the shared menu remains touch-sized.
      await expectDocumentFits(page, `${path} at ${width}`, false);
      await expect(page.getByRole("navigation", { name: "Footer navigation" })).toBeVisible();
      if (width === 320) {
        await page.locator('summary[aria-label="Navigation menu"]').click();
        await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
    }
  }
});
