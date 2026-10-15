import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { mountHome, until, flush, tick, resolveHome, state } from "./helpers/home-hook-mounted.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

for (const membership of [
  "none",
  "archived",
  "active",
  "active-other-studio",
  "persistent-denial",
  "profile-failure",
]) {
  test(`cold workspace recovers stale active selector: ${membership}`, async (t) => {
    const { page, errors } = await mountHome(browser, { holdSession: true, homeMounted: false });
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await page.evaluate((membership) => {
      const f = fixture,
        get = f.api.get;
      document.cookie = "koaryu-studio-state=" + encodeURIComponent("user-a|1|active") + "; Path=/";
      document.cookie = "koaryu-active-studio=studio-a; Path=/";
      f.workspaceAttempts = 0;
      f.profileAttempts = 0;
      f.api.get = async (path, token, options) => {
        if (path === "/dashboard/workspace") {
          f.workspaceAttempts++;
          if (f.workspaceAttempts === 1 || membership === "persistent-denial") {
            f.requests.push({ path, token, options });
            throw Object.assign(Error("You do not have access to the requested studio."), {
              status: 403,
            });
          }
          if (
            membership === "active-other-studio" &&
            !document.cookie.includes("koaryu-active-studio=studio-b")
          )
            throw Error("Selector was not corrected before retry");
        }
        if (path === "/auth/me") {
          f.profileAttempts++;
          f.requests.push({ path, token, options });
          if (
            options?.omitStudioHeader !== true ||
            document.cookie.includes("koaryu-active-studio=")
          )
            throw Error("Profile recovery leaked stale selector");
          if (membership === "profile-failure") throw Error("Profile unavailable");
          if (membership === "none" || membership === "archived")
            return { ...f.profile(), membership_status: membership, studio_id: null, role: null };
          if (membership === "active-other-studio") f.studioId = "studio-b";
          return f.profile();
        }
        return get(path, token, options);
      };
      f.holdSession = false;
      f.releaseSession();
    }, membership);
    const failed = ["persistent-denial", "profile-failure"].includes(membership);
    await until(
      page,
      () => fixture.store.identityReady || Boolean(fixture.store.identityLoadError),
    );
    const result = await page.evaluate(() => ({
      workspace: fixture.workspaceAttempts,
      profile: fixture.profileAttempts,
      cookie: decodeURIComponent(document.cookie),
      redirects: fixture.redirects,
      ready: fixture.store.identityReady,
      studio: fixture.store.currentStudioId,
      bootstrap: fixture.requests.filter((r) => r.path.startsWith("/dashboard/bootstrap")).length,
    }));
    assert.equal(result.profile, 1);
    assert.equal(
      result.workspace,
      ["none", "archived", "profile-failure"].includes(membership) ? 1 : 2,
    );
    assert.equal(result.bootstrap, 0);
    if (membership === "none" || membership === "archived") {
      assert.ok(
        result.redirects.includes(membership === "none" ? "/onboarding" : "/account-archived"),
      );
      assert.match(result.cookie, new RegExp(`koaryu-studio-state=user-a\\|0\\|${membership}`));
      assert.equal(result.cookie.includes("koaryu-active-studio="), false);
      assert.equal(result.studio, null);
    } else if (!failed) {
      assert.equal(result.ready, true);
      assert.equal(result.studio, membership === "active-other-studio" ? "studio-b" : "studio-a");
      await page.evaluate(() => fixture.mountHome());
      await until(page, () => fixture.homeReads.length === 1);
      await resolveHome(page);
      assert.equal((await state(page)).status, "ready");
    } else assert.equal(result.ready, false);
    await tick(page, 1000);
    await flush(page);
    assert.equal(
      await page.evaluate(() => fixture.workspaceAttempts),
      result.workspace,
      "no automatic retry loop",
    );
    assert.equal(await page.evaluate(() => fixture.profileAttempts), 1);
    t.diagnostic(
      `${membership}: ${result.workspace} workspace requests, 1 selector-free profile, no feature bootstrap`,
    );
  });
}
