import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { mountSettings, effects, response, flush } from "./helpers/settings-clear-mounted.mjs";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const button = (p, reset = false) =>
  p.getByRole("button", { name: reset ? "Load demo studio" : "Clear studio data", exact: true });
async function confirm(p, reset = false) {
  await button(p, reset).click();
  await p
    .getByRole("alertdialog")
    .getByRole("button", { name: reset ? "Load demo studio" : "Clear studio data", exact: true })
    .click();
}
for (const reset of [false, true]) {
  test(`${reset ? "reset" : "clear"} confirms once, preserves nine effects and dismisses explicitly`, async () => {
    const { p, errors } = await mountSettings(browser);
    try {
      await button(p, reset).click();
      const dialog = p.getByRole("alertdialog");
      await expect(dialog).toContainText("original operation history, including saved details");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      assert.equal(await p.evaluate(() => f.dataWrites.length), 0);
      await confirm(p, reset);
      await p.waitForFunction(() => f.dataWrites.length === 1);
      const request = await p.evaluate(() => {
        const { method, path, body, token, options } = f.dataWrites[0];
        return { method, path, body, token, options };
      });
      assert.equal(request.method, reset ? "POST" : "DELETE");
      assert.equal(request.path, reset ? "/demo/reset" : "/demo/data");
      assert.equal(request.token, "token-1");
      assert.equal(request.options.timeoutMs, 60000);
      assert.deepEqual(request.options.headers, {
        "X-Koaryu-Destructive-Action": reset ? "demo-reset" : "clear-studio-data",
      });
      if (reset) assert.deepEqual(request.body, {});
      await expect(button(p, !reset)).toBeDisabled();
      await p.evaluate((value) => f.dataWrites[0].resolve(value), response());
      const result = p.getByRole("status", { name: "Studio data result" });
      await expect(result).toContainText(reset ? "Seeded: 10 students" : "Removed: 10 students");
      assert.deepEqual(await result.locator("dd").allTextContents(), [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "Yes",
      ]);
      await p.waitForTimeout(3600);
      await expect(result).toBeVisible();
      await result.getByRole("button", { name: "Dismiss result" }).click();
      await expect(result).toHaveCount(0);
      assert.deepEqual(errors, []);
    } finally {
      await p.close();
    }
  });
  test(`${reset ? "reset" : "clear"} rejects malformed success without applying or repeating`, async () => {
    const { p, errors } = await mountSettings(browser);
    try {
      const old = await p.evaluate(() => ({
        name: f.store.studioName,
        leads: f.store.leads.length,
      }));
      await confirm(p, reset);
      await p.evaluate((value) => f.dataWrites[0].resolve(value), response(null));
      await expect(p.getByRole("alert")).toContainText("could not be confirmed");
      assert.deepEqual(
        await p.evaluate(() => ({ name: f.store.studioName, leads: f.store.leads.length })),
        old,
      );
      await expect(p.getByRole("status", { name: "Studio data result" })).toHaveCount(0);
      await flush(p);
      assert.equal(await p.evaluate(() => f.dataWrites.length), 1);
      assert.deepEqual(errors, []);
    } finally {
      await p.close();
    }
  });
}

test("live zeros remain zero and false; preview labels sample effects without mutation requests", async () => {
  for (const preview of [false, true]) {
    const { p, errors } = await mountSettings(browser, { preview });
    try {
      await confirm(p);
      if (!preview)
        await p.evaluate(
          (value) => f.dataWrites[0].resolve(value),
          response(
            Object.fromEntries(
              Object.keys(effects).map((key) => [
                key,
                key === "attendance_rule_paused" ? false : 0,
              ]),
            ),
          ),
        );
      const result = p.getByRole("status", { name: "Studio data result" });
      await expect(result).toBeVisible();
      if (preview) {
        await expect(result).toContainText("sample numbers");
        assert.equal(await p.evaluate(() => f.dataWrites.length), 0);
      } else
        assert.deepEqual(await result.locator("dd").allTextContents(), [
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "0",
          "No",
        ]);
      assert.deepEqual(errors, []);
    } finally {
      await p.close();
    }
  }
});

for (const replacement of ["studio", "user", "role", "identity", "unmount"])
  test(`held completion cannot update ${replacement} replacement`, async () => {
    const { p, errors } = await mountSettings(browser);
    try {
      await confirm(p);
      await p.evaluate((replacement) => {
        if (replacement === "unmount") {
          f.showPage(false);
          return;
        }
        if (replacement === "studio") f.auth.studio_id = "other-studio";
        if (replacement === "user") {
          f.auth.user = { ...f.auth.user, id: "other-user" };
          f.session = { ...f.session, user: { ...f.session.user, id: "other-user" } };
        }
        if (replacement === "role") f.auth.role = "instructor";
        f.emit("USER_UPDATED", f.session);
      }, replacement);
      await flush(p);
      if (replacement === "unmount") {
        await p.evaluate(() => f.showPage(true));
        await flush(p);
      }
      if (replacement !== "role") {
        await expect(button(p)).toBeVisible();
        await confirm(p, true);
        await p.waitForFunction(() => f.dataWrites.length === 2);
      }
      await p.evaluate((value) => f.dataWrites[0].resolve(value), response());
      await flush(p);
      await expect(p.getByRole("status", { name: "Studio data result" })).toHaveCount(0);
      if (replacement !== "role") await expect(button(p)).toBeDisabled();
      assert.deepEqual(errors, []);
    } finally {
      await p.close();
    }
  });

test("capability and confirmation belong to the current identity", async () => {
  const { p } = await mountSettings(browser, { holdCapability: true });
  try {
    await p.waitForFunction(() => f.capabilities.length === 1);
    await p.evaluate(() => f.emit("USER_UPDATED", f.session));
    await p.waitForFunction(() => f.capabilities.length === 2);
    await p.evaluate(() => f.capabilities[0].resolve({ enabled: true }));
    await flush(p);
    await expect(button(p)).toHaveCount(0);
    await p.evaluate(() => f.capabilities[1].resolve({ enabled: true }));
    await button(p).click();
    await p.evaluate(() => f.emit("USER_UPDATED", f.session));
    await flush(p);
    await expect(p.getByRole("alertdialog")).toHaveCount(0);
    assert.equal(await p.evaluate(() => f.dataWrites.length), 0);
  } finally {
    await p.close();
  }
});

test("token renewal still rejects a malformed held success", async () => {
  const { p, errors } = await mountSettings(browser);
  try {
    await confirm(p);
    await p.evaluate(() => {
      f.session = { ...f.session, access_token: "renewed" };
      f.emit("TOKEN_REFRESHED", f.session);
    });
    await flush(p);
    await p.evaluate((value) => f.dataWrites[0].resolve(value), response(null));
    await expect(p.getByRole("alert")).toContainText("could not be confirmed");
    await expect(p.getByRole("status", { name: "Studio data result" })).toHaveCount(0);
    assert.equal(await p.evaluate(() => f.dataWrites.length), 1);
    assert.deepEqual(errors, []);
  } finally {
    await p.close();
  }
});

test("a new explicit command clears the prior success before an unknown result", async () => {
  const { p, errors } = await mountSettings(browser);
  try {
    await confirm(p);
    await p.evaluate((value) => f.dataWrites[0].resolve(value), response());
    await expect(p.getByRole("status", { name: "Studio data result" })).toBeVisible();
    await confirm(p, true);
    await expect(p.getByRole("status", { name: "Studio data result" })).toHaveCount(0);
    const malformed = response();
    delete malformed.automation;
    await p.evaluate((value) => f.dataWrites[1].resolve(value), malformed);
    await expect(p.getByRole("alert")).toContainText("could not be confirmed");
    await expect(p.getByRole("status", { name: "Studio data result" })).toHaveCount(0);
    assert.equal(await p.evaluate(() => f.dataWrites.length), 2);
    assert.deepEqual(errors, []);
  } finally {
    await p.close();
  }
});

test("dialog traps focus and Escape cancels without dispatch", async () => {
  const { p } = await mountSettings(browser);
  try {
    await p.setViewportSize({ width: 375, height: 812 });
    await button(p).click();
    const dialog = p.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await p.keyboard.press("Shift+Tab");
    await expect(
      dialog.getByRole("button", { name: "Clear studio data", exact: true }),
    ).toBeFocused();
    await p.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await p.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button(p)).toBeFocused();
    assert.equal(await p.evaluate(() => f.dataWrites.length), 0);
  } finally {
    await p.close();
  }
});

test("two synchronous confirmation clicks dispatch once", async () => {
  const { p } = await mountSettings(browser);
  try {
    await button(p).click();
    await p
      .getByRole("alertdialog")
      .getByRole("button", { name: "Clear studio data", exact: true })
      .evaluate((el) => {
        el.click();
        el.click();
      });
    await flush(p);
    assert.equal(await p.evaluate(() => f.dataWrites.length), 1);
    await p.evaluate((value) => f.dataWrites[0].resolve(value), response());
    await expect(p.getByRole("status", { name: "Studio data result" })).toBeVisible();
  } finally {
    await p.close();
  }
});

test("preview reset labels explicit sample effects without live mutation", async () => {
  const { p } = await mountSettings(browser, { preview: true });
  try {
    await confirm(p, true);
    const result = p.getByRole("status", { name: "Studio data result" });
    await expect(result).toContainText("sample numbers");
    await expect(result).toContainText("Seeded:");
    assert.equal(await result.locator("dd").count(), 9);
    assert.equal(await p.evaluate(() => f.dataWrites.length), 0);
  } finally {
    await p.close();
  }
});
