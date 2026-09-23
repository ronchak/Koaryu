import { expect, test, type Page } from "@playwright/test";
import { parseCsvText } from "../src/lib/student-import-page-model";

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
];

test.use({ contextOptions: { reducedMotion: "reduce", hasTouch: true } });

async function openDocument(page: Page, path: string, canonicalPath = path.split("#")[0]) {
  await page.route("**/api/proxy/health", (route) => route.fulfill({ json: { status: "ok" } }));
  const response = await page.goto(`${origin}${path}`);
  expect(response?.ok(), path).toBeTruthy();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `https://koaryu.app${canonicalPath}`,
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
  await page.setViewportSize({ width: 320, height: 568 });
  await openDocument(page, "/features");
  await expect(
    page.locator("header").getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
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
  await menu.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/use-cases`);
  await expect(menu).not.toBeVisible();
});

test("document navigation and guide links work before JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 568 },
  });
  const page = await context.newPage();
  try {
    await openDocument(page, "/features");
    await page.locator('summary[aria-label="Navigation menu"]').click();
    const menu = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "Workflows", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/use-cases`);
    await expect(page.locator("h1")).toBeVisible();
    await page.locator('main a[href="/use-cases/spreadsheets-to-studio-crm"]').click();
    await expect(page).toHaveURL(`${origin}/use-cases/spreadsheets-to-studio-crm`);
    await expect(page.locator("main a[download]")).toBeVisible();
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
  await page.locator('a[href="/features/student-management"]:visible').click();
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

test("retired routes redirect permanently to their replacement answers", async ({
  page,
  request,
}) => {
  for (const [oldPath, destination] of [
    ["/explore", "/features"],
    ["/about", "/features#fit"],
    ["/studio-types/family-martial-arts-schools", "/features/student-management#families"],
  ]) {
    const response = await request.get(`${origin}${oldPath}`, { maxRedirects: 0 });
    expect(response.status(), oldPath).toBe(308);
    expect(new URL(response.headers().location, origin).href).toBe(`${origin}${destination}`);
    await openDocument(page, oldPath, destination.split("#")[0]);
    await expect(page).toHaveURL(`${origin}${destination}`);
    if (destination.includes("#")) {
      const section = page.locator(`#${destination.split("#")[1]}`);
      await expect(section).toBeInViewport();
      await expect(section.locator("h2,h3").first()).toBeVisible();
    }
  }
});

test("unknown marketing slugs return 404 rather than unrelated guide content", async ({
  request,
}) => {
  for (const path of [
    "/features/not-a-feature",
    "/use-cases/not-a-workflow",
    "/studio-types/not-a-school",
    "/studio-types/family-martial-arts-school",
  ]) {
    const response = await request.get(`${origin}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    expect(response.headers().location, path).toBeUndefined();
  }
});

test("every guide control reaches a distinct answer or provides the promised file", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 393, height: 800 });
  const inventory: Array<{ page: string; label: string; href: string; download: boolean }> = [];
  const destinations = new Map<string, string>();
  const retired = new Set(["/explore", "/about", "/studio-types/family-martial-arts-schools"]);
  for (const path of routes) {
    await openDocument(page, path);
    const controls = await page.locator("main a").evaluateAll((elements) =>
      elements.map((element) => ({
        label:
          element.textContent?.trim().replace(/\s+/g, " ") ||
          element.getAttribute("aria-label") ||
          "",
        href: element.getAttribute("href") || "",
        download: element.hasAttribute("download"),
      })),
    );
    // These guides provide worked examples and documents. They have no app action to simulate.
    await expect(page.locator("main button, main input, main select, main textarea")).toHaveCount(
      0,
    );
    const bodyDestinations = new Set<string>();
    for (const control of controls) {
      const destination = new URL(control.href, `${origin}${path}`);
      expect(control.label, `${path}: unnamed link`).not.toBe("");
      expect(control.href, `${path}: empty link`).not.toBe("");
      expect(retired.has(destination.pathname), `${path}: link through a retired page`).toBeFalsy();
      expect(
        bodyDestinations.has(destination.href),
        `${path}: repeated destination ${control.href}`,
      ).toBeFalsy();
      bodyDestinations.add(destination.href);
      inventory.push({ page: path, ...control });
      expect(destination.origin, `${path}: unexpected external action`).toBe(
        new URL(origin).origin,
      );
      if (control.download) {
        const response = await request.get(destination.href);
        expect(response.ok()).toBeTruthy();
        expect(response.headers()["content-type"]).toMatch(/csv|text\/plain|octet-stream/);
        const contents = await response.text();
        const [headers, ...rows] = parseCsvText(contents);
        expect(headers).toEqual(
          expect.arrayContaining([
            "First Name",
            "Last Name",
            "Date of Birth",
            "Guardian Name",
            "Guardian Email",
          ]),
        );
        for (const row of rows) expect(row).toHaveLength(headers.length);
        const records = rows.map((row) =>
          Object.fromEntries(headers.map((header, index) => [header, row[index]])),
        );
        expect(records).toEqual([
          expect.objectContaining({
            "First Name": "Alex",
            "Last Name": "Morgan",
            "Date of Birth": "2016-06-15",
            "Guardian Name": "Jordan Morgan",
            "Guardian Email": "jordan@example.com",
          }),
          expect.objectContaining({
            "First Name": "Sam",
            "Last Name": "Lee",
            "Date of Birth": "2017-03-08",
            "Guardian Name": "Taylor Lee",
            "Guardian Email": "taylor@example.com",
          }),
        ]);
        const downloadEvent = page.waitForEvent("download");
        await page.locator(`main a[href="${control.href}"]`).click();
        const download = await downloadEvent;
        expect(await download.failure()).toBeNull();
        expect(download.suggestedFilename()).toMatch(/\.csv$/);
      } else {
        destinations.set(destination.href, `${path}: ${control.label}`);
      }
    }
    expect(controls.filter(({ href }) => href === "/signup").length).toBeLessThanOrEqual(1);
    const navigation = await page
      .locator("header a, footer a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    for (const href of navigation)
      expect(retired.has(href || ""), `${path}: retired navigation`).toBeFalsy();
  }
  for (const [url, label] of destinations) {
    const destination = new URL(url);
    const response = await page.goto(url);
    expect(response?.ok(), label).toBeTruthy();
    if (destination.pathname === "/" && destination.hash) {
      await expect(page.locator("[data-active-chapter]"), label).toHaveAttribute(
        "data-active-chapter",
        destination.hash.slice(1),
      );
    } else if (destination.pathname === "/signup") {
      await expect(
        page.getByRole("heading", { name: "Create your account", exact: true }),
        label,
      ).toBeVisible();
      for (const field of ["Full name", "Email", "Password", "Confirm password"]) {
        await expect(page.getByLabel(field, { exact: true }), label).toBeVisible();
      }
      await expect(
        page.getByRole("button", { name: "Create account", exact: true }),
        label,
      ).toBeVisible();
    } else {
      await expect(page.locator("h1").first(), label).toBeVisible();
    }
    if (destination.hash && destination.pathname !== "/")
      await expect(
        page.locator(`[id="${decodeURIComponent(destination.hash.slice(1))}"]`),
        label,
      ).toBeInViewport();
  }
  await testInfo.attach("marketing-action-inventory", {
    body: JSON.stringify(inventory, null, 2),
    contentType: "application/json",
  });
});

test("the shared shell supports skip navigation and identifies the current page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDocument(page, "/features");
  const primary = page.getByRole("navigation", { name: "Primary navigation", exact: true });
  await expect(primary.getByRole("link", { name: "Features", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(primary.getByRole("link", { name: "Workflows", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  // Safari can exclude links from Tab order according to the host keyboard preference.
  // Start on the skip link, then exercise its native keyboard activation and target focus.
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link"),
  ).toHaveCount(4);
});
