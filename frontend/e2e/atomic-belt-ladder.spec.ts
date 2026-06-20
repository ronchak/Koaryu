import { test, expect } from "@playwright/test";

const FRONTEND_URL = "http://127.0.0.1:4000";
const liveStatefulE2eEnabled = process.env.KOARYU_LIVE_STATEFUL_E2E === "true";
const liveStatefulTest = liveStatefulE2eEnabled ? test : test.skip;

type SyncRankPayload = {
  id?: string;
  name: string;
  color_hex: string;
  min_classes: number;
  min_months: number;
  requires_approval: boolean;
  is_tip: boolean;
  tip_color_hex?: string | null;
};

type SyncResponse = {
  id: string;
  studio_id: string;
  name: string;
  sub_rank_term: string;
  ranks: Array<{
    id: string;
    name: string;
    display_order: number;
    color_hex: string;
    min_classes: number;
    min_months: number;
    requires_approval: boolean;
    is_tip: boolean;
    tip_color_hex?: string | null;
  }>;
};

liveStatefulTest("belt ladder sync stays single-request and preserves existing ranks", async ({ page }) => {
  test.setTimeout(90_000);

  const loginEmail = process.env.KOARYU_E2E_LOGIN_EMAIL;
  const password = process.env.KOARYU_E2E_LOGIN_PASSWORD;
  const studioName = process.env.KOARYU_E2E_STUDIO_NAME;
  expect(loginEmail, "expected KOARYU_E2E_LOGIN_EMAIL").toBeTruthy();
  expect(password, "expected KOARYU_E2E_LOGIN_PASSWORD").toBeTruthy();
  expect(studioName, "expected KOARYU_E2E_STUDIO_NAME for a disposable live test studio").toBeTruthy();
  const loginEmailValue = loginEmail!;
  const loginPassword = password!;
  const studioNameValue = studioName!;

  const syncRequests: Array<{ method: string; url: string; postData: string | null }> = [];
  const nonSyncBeltMutations: Array<{ method: string; url: string }> = [];

  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("/api/v1/belts/")) {
      return;
    }

    if (request.method() !== "GET") {
      const entry = {
        method: request.method(),
        url,
        postData: request.postData(),
      };
      if (url.includes("/ladders/") && url.endsWith("/sync")) {
        syncRequests.push(entry);
      } else {
        nonSyncBeltMutations.push({ method: request.method(), url });
      }
    }
  });

  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel("Email").fill(loginEmailValue);
  await page.getByLabel("Password").fill(loginPassword);
  await Promise.all([
    page.waitForURL("**/onboarding"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);

  await page.getByLabel("Studio name").fill(studioNameValue);
  await page.getByLabel("Timezone").selectOption("America/New_York");
  await Promise.all([
    page.waitForURL(`${FRONTEND_URL}/`),
    page.getByRole("button", { name: "Launch your dojo" }).click(),
  ]);

  await Promise.all([
    page.waitForURL("**/belt-tracker"),
    page.getByRole("link", { name: "Belt Tracker" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Belt Tracker" })).toBeVisible();
  await page.getByRole("button", { name: "Configure ladder" }).click();

  await page.getByRole("button", { name: "Add belt" }).click();
  await expect(page.getByRole("heading", { name: "Add belt" })).toBeVisible();
  await page.getByPlaceholder("e.g. Blue Belt").fill("White Belt");
  await page.getByRole("button", { name: "Save rank" }).click();
  await expect(page.getByRole("heading", { name: "Add belt" })).toBeHidden();
  await expect(page.getByText("White Belt")).toBeVisible();
  await expect(page.getByText("Unsaved changes to rank order.")).toBeVisible();

  const firstSyncPromise = page.waitForResponse((response) => {
    return (
      response.request().method() === "POST" &&
      response.url().includes("/api/v1/belts/ladders/") &&
      response.url().endsWith("/sync") &&
      response.status() === 200
    );
  });
  await page.getByRole("button", { name: "Save order" }).click();
  const firstSync = await firstSyncPromise;
  expect(firstSync.ok()).toBeTruthy();
  const firstResponse = (await firstSync.json()) as SyncResponse;
  const firstRequestBody = JSON.parse(syncRequests[0]!.postData ?? "{}") as {
    sub_rank_term?: string;
    ranks: SyncRankPayload[];
  };

  expect(firstResponse.ranks).toHaveLength(1);
  expect(firstResponse.ranks[0]?.name).toBe("White Belt");
  const preservedWhiteId = firstResponse.ranks[0]!.id;
  expect(preservedWhiteId).toBeTruthy();
  expect(syncRequests, "expected exactly one browser sync request").toHaveLength(1);
  expect(
    nonSyncBeltMutations.every(
      (request) => request.method === "POST" && request.url.endsWith("/api/v1/belts/ladders"),
    ),
    "expected browser belt mutations outside sync to be limited to one-time ladder creation",
  ).toBeTruthy();
  expect(nonSyncBeltMutations.length, "expected at most one ladder-creation mutation").toBeLessThanOrEqual(1);
  expect(firstRequestBody.ranks.map((rank) => rank.name)).toEqual(["White Belt"]);
  expect(firstRequestBody.ranks[0]?.id).toBeUndefined();
});
