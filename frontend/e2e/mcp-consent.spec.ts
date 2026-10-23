import { expect, test, type Page } from "@playwright/test";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("MCP consent checks may run only against loopback.");
}
const authorization = "10000000-0000-4000-8000-000000000001";
const path = `/connect/authorize?authorization_id=${authorization}`;
const permissions = {
  students: "Student roster and program memberships",
  schedule: "Classes and attendance",
  contacts: "Email addresses and phone numbers",
  notes: "Free-text notes",
};

async function signedIn(page: Page) {
  // Synthetic Supabase SSR session. All Auth/API traffic is intercepted below.
  const claims = { sub: authorization, exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "synthetic",
  ].join(".");
  const session = {
    access_token: token,
    refresh_token: "synthetic-refresh",
    token_type: "bearer",
    expires_at: claims.exp,
    expires_in: 3600,
    user: {
      id: authorization,
      aud: "authenticated",
      email: "owner@example.invalid",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    },
  };
  await page
    .context()
    .addCookies([
      {
        name: "sb-placeholder-auth-token",
        value: "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"),
        url: origin,
        sameSite: "Lax",
      },
    ]);
  await page.route("https://placeholder.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: session.user }),
  );
}

async function mockConsent(page: Page, decision: "approve" | "deny", fail = false) {
  const submissions: unknown[] = [];
  await page.route("**/api/v1/mcp/authorizations/**", async (route) => {
    const request = route.request();
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    expect(request.headers().authorization).toMatch(/^Bearer /);
    expect(request.headers()["x-studio-id"]).toBeUndefined();
    if (request.method() === "GET")
      return route.fulfill({
        headers,
        json: {
          authorization_id: authorization,
          client_name: "Synthetic assistant",
          redirect_uri: `${origin}/mcp-test-return`,
          identity_scope: "openid",
          permissions,
          default_permissions: ["students", "schedule"],
        },
      });
    expect(new URL(request.url()).pathname).toBe(
      `/api/v1/mcp/authorizations/${authorization}/${decision}`,
    );
    submissions.push(request.postDataJSON());
    return route.fulfill({
      headers,
      status: fail ? 400 : 200,
      json: fail
        ? { detail: "This connection request has expired. Start it again." }
        : { redirect_url: `${origin}/mcp-test-return?decision=${decision}` },
    });
  });
  await page.route(`${origin}/mcp-test-return**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Returned to assistant</h1>" }),
  );
  return submissions;
}

test("logged-out owner keeps the exact request through sign-in", async ({ page }) => {
  await page.goto(origin + path);
  await expect(page.getByRole("link", { name: "Sign in to Koaryu" })).toHaveAttribute(
    "href",
    `/login?next=${encodeURIComponent(path)}`,
  );
  await expect(page.getByRole("button", { name: "Allow selected reads" })).toHaveCount(0);
  await page.goto(origin + "/connect/authorize?authorization_id=invalid");
  await expect(page.getByRole("alert").filter({ hasText: "invalid" })).toContainText("invalid");
});

test("owner chooses sensitive permissions and expiry before approval", async ({ page }) => {
  await signedIn(page);
  const submitted = await mockConsent(page, "approve");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + path);
  await expect(page.getByText("Synthetic assistant", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: permissions.students })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: permissions.contacts })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: permissions.notes })).not.toBeChecked();
  await page.getByRole("checkbox", { name: permissions.contacts }).check();
  await page.getByLabel("Access expires after").selectOption("7");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Allow selected reads" }).click();
  await expect(page.getByRole("heading", { name: "Returned to assistant" })).toBeVisible();
  expect(submitted).toEqual([
    { permissions: ["students", "schedule", "contacts"], expires_days: 7 },
  ]);
});

test("decline returns to the assistant without granting data", async ({ page }) => {
  await signedIn(page);
  const submitted = await mockConsent(page, "deny");
  await page.goto(origin + path);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("heading", { name: "Returned to assistant" })).toBeVisible();
  expect(submitted).toEqual([{}]);
});

test("failed consent stays visible and an empty selection cannot approve", async ({ page }) => {
  await signedIn(page);
  await mockConsent(page, "approve", true);
  await page.goto(origin + path);
  await page.getByRole("button", { name: "Allow selected reads" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "expired" })).toContainText("expired");
  await page.getByRole("checkbox", { name: permissions.students }).uncheck();
  await page.getByRole("checkbox", { name: permissions.schedule }).uncheck();
  await expect(page.getByRole("button", { name: "Allow selected reads" })).toBeDisabled();
});
