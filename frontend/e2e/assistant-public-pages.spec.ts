import { expect, test } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4102";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Public assistant-page checks may run only on loopback.");
}

for (const width of [390, 1280]) {
  test(`public assistant guide and support work without sign-in at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/v1\/|\/auth\/v1\//.test(request.url())) apiRequests.push(request.url());
    });
    await page.goto(origin + "/ai-connections");
    await expect(page.getByRole("heading", { name: "Your studio. Your questions." })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose what leaves your studio" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Get help", exact: true })).toHaveAttribute(
      "href",
      "/support",
    );
    await expect(page.getByRole("link", { name: "official OpenAI instructions" })).toHaveAttribute(
      "href",
      "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("link", { name: "Get help", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Get help with Koaryu." })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "koaryu@outlook.com", exact: true }),
    ).toHaveAttribute("href", "mailto:koaryu@outlook.com");
    await expect(page.getByText(/Do not include passwords/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(apiRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("public support and assistant content are readable without browser JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(origin + "/support");
    await expect(page.getByRole("heading", { name: "Get help with Koaryu." })).toBeVisible();
    await page.getByRole("link", { name: "assistant connection guide", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your studio. Your questions." })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose what leaves your studio" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
