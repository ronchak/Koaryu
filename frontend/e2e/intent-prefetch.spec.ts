import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://localhost:4000";
const enabled = process.env.KOARYU_PREFETCH_PRODUCTION_E2E === "true";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("Prefetch tests require loopback preview.");
const check = enabled ? test : test.skip;

test.beforeEach(async ({ page }) => {
  const rate = Number(process.env.KOARYU_E2E_CPU_THROTTLE ?? "1");
  if (rate > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
  }
});

check(
  "a warmed static Billing navigation and local tab changes make no document or RSC requests",
  async ({ page }) => {
    const warm = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/billing" &&
        response.request().headers()["next-router-prefetch"] === "1",
    );
    await page.goto(`${origin}/dashboard`);
    await expect(page.locator("html")).toHaveAttribute(
      "data-koaryu-data-plane",
      "disposable-preview",
    );
    const response = await warm;
    expect(response.status()).toBe(200);
    await response.finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        request.isNavigationRequest() ||
        (new URL(request.url()).pathname === "/billing" && request.headers().rsc === "1")
      )
        requests.push(request.url());
    });
    await page
      .getByRole("link", { name: "Billing", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(`${origin}/billing`);
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
    await expect(page.locator("[data-billing-placeholder]")).toHaveCount(0, { timeout: 15_000 });
    for (const [name, tab] of [
      ["Tuition Plans", "plans"],
      ["Invoices", "invoices"],
      ["Setup", ""],
    ]) {
      const button = page
        .getByRole("navigation", { name: "Billing views" })
        .getByRole("button", { name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(new URL(page.url()).searchParams.get("tab") ?? "").toBe(tab);
    }
    expect(requests).toEqual([]);
  },
);

for (const connection of [
  { saveData: true, effectiveType: "4g" },
  { saveData: false, effectiveType: "2g" },
]) {
  check(
    `constrained connection ${JSON.stringify(connection)} skips automatic and intent requests but allows a forced miss`,
    async ({ page }) => {
      await page.addInitScript(
        (connection) =>
          Object.defineProperty(navigator, "connection", { configurable: true, value: connection }),
        connection,
      );
      const requests: {
        prefetch: string | undefined;
        rsc: string | undefined;
        document: boolean;
      }[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/billing")
          requests.push({
            prefetch: request.headers()["next-router-prefetch"],
            rsc: request.headers().rsc,
            document: request.isNavigationRequest(),
          });
      });
      await page.goto(`${origin}/dashboard`);
      await expect(page.locator("html")).toHaveAttribute(
        "data-koaryu-data-plane",
        "disposable-preview",
      );
      const link = page
        .getByRole("link", { name: "Billing", exact: true })
        .filter({ visible: true });
      await link.hover();
      await link.focus();
      await page.waitForTimeout(500);
      expect(requests).toHaveLength(0);
      await link.click();
      await expect(page).toHaveURL(`${origin}/billing`);
      await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
      await expect(page.locator("[data-billing-placeholder]")).toHaveCount(0, { timeout: 15_000 });
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) => request.prefetch === undefined && request.rsc === "1" && !request.document,
        ),
      ).toBe(true);
    },
  );
}
