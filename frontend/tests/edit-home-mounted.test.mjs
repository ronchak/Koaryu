import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { mountHome, flush, until, tick } from "./helpers/home-hook-mounted.mjs";
import { homePayload } from "./helpers/home-fixtures.mjs";
import {
  defaultHomePreferences,
  moveHomePanel,
  setHomePanelShown,
} from "../src/lib/dashboard/home-preferences.ts";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const defaults = () => defaultHomePreferences("admin");
const trigger = (page) => page.locator('[data-home-edit="trigger"]');
const sheet = (page) => page.getByRole("dialog", { name: "Edit Home", exact: true });
const rows = (page) => page.locator("[data-home-edit-panel]");
const panels = (page) => page.locator("[data-home-panel]");
const ids = (locator) =>
  locator.evaluateAll((nodes) =>
    nodes.map(
      (node) => node.getAttribute("data-home-edit-panel") ?? node.getAttribute("data-home-panel"),
    ),
  );
async function mount(options = {}) {
  const result = await mountHome(browser, { homePage: true, realApi: true, ...options });
  await result.page.evaluate(() => {
    const f = window.fixture;
    f.saves = [];
    f.api.put = async (path, body, headers, options) => {
      const record = { path, body, headers, options };
      f.saves.push(record);
      if (f.holdSave)
        return new Promise((resolve, reject) => Object.assign(record, { resolve, reject }));
      if (f.saveError)
        throw Object.assign(Error(f.saveError === 403 ? "STAFF_ARCHIVED" : "Access denied"), {
          status: f.saveError,
        });
      return f.saveResponse ?? body;
    };
  });
  return result;
}
async function deliver(page, role = "admin", preferences, index = 0) {
  await until(page, () => window.fixture.homeReads.length > 0);
  const payload = homePayload(role, { rich: true });
  if (preferences !== undefined) payload.preferences = preferences;
  await page.evaluate(({ payload, index }) => window.fixture.homeReads[index].resolve(payload), {
    payload,
    index,
  });
  await until(page, () => document.querySelector('[data-home-status="ready"]'));
  await tick(page, 40);
}
async function open(page) {
  await trigger(page).click();
  await tick(page, 20);
  assert.equal(await sheet(page).count(), 1);
}
async function saved(page, count = 1) {
  await until(page, () => window.fixture.saves.length > 0);
  assert.equal(await page.evaluate(() => window.fixture.saves.length), count);
}
async function announce(page, text) {
  assert.equal(await sheet(page).locator('[aria-live="polite"]').innerText(), text);
}
async function withPage(options, fn) {
  const { page, errors } = await mount(options);
  try {
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

test("Edit Home trigger is absent loading, below classes and above panels, never in Header, and survives all hidden", async () => {
  await withPage({}, async (page) => {
    assert.equal(await trigger(page).count(), 0);
    await deliver(page);
    assert.equal(await page.locator('header [data-home-edit="trigger"]').count(), 0);
    assert.equal(
      await page.evaluate(() => {
        const t = document.querySelector('[data-home-edit="trigger"]');
        return (
          Boolean(
            document.querySelector('[data-home-band="classes"]').compareDocumentPosition(t) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          Boolean(
            t.compareDocumentPosition(document.querySelector("[data-home-panel]")) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          )
        );
      }),
      true,
    );
    await open(page);
    for (const title of ["Follow-ups", "Ready to promote"])
      await sheet(page)
        .getByRole("switch", { name: `Show ${title}`, exact: true })
        .click();
    assert.equal(await panels(page).count(), 0);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(await trigger(page).isVisible(), true);
  });
});
for (const [role, expected] of [
  ["admin", ["followUps", "promotions", "newStudents"]],
  ["front_desk", ["followUps", "newStudents"]],
  ["instructor", ["promotions", "newStudents"]],
])
  test(`Edit Home ${role} has modal name, fixed rows without controls, ordered handles and switches, hidden row and disabled Reset`, async () => {
    await withPage({ role }, async (page) => {
      await deliver(page, role);
      await open(page);
      assert.equal(await sheet(page).getAttribute("aria-modal"), "true");
      assert.equal(await sheet(page).getAttribute("aria-describedby"), null);
      assert.deepEqual(await page.locator("[data-home-edit-band]").allTextContents(), [
        "At a glance",
        "Needs attention",
        "Today's classes",
      ]);
      assert.equal(
        await page.locator("[data-home-edit-band] button,[data-home-edit-band] input").count(),
        0,
      );
      assert.equal(await sheet(page).getByRole("heading", { name: "Always shown" }).count(), 1);
      assert.deepEqual(await ids(rows(page)), expected);
      for (const row of await rows(page).all()) {
        const title = (await row.locator("span").first().innerText()).trim();
        assert.equal(
          await row.getByRole("button", { name: `Move ${title}`, exact: true }).count(),
          1,
        );
        assert.equal(
          await row
            .getByRole("switch", { name: `Show ${title}`, exact: true })
            .getAttribute("aria-checked"),
          title === "New students" ? "false" : "true",
        );
      }
      assert.equal(
        await page.locator('[data-home-edit-panel="newStudents"]').getAttribute("data-shown"),
        "false",
      );
      assert.equal(
        await sheet(page).getByRole("button", { name: "Reset to defaults" }).isDisabled(),
        true,
      );
      assert.equal(
        await sheet(page).getByRole("button", { name: "Cancel", exact: true }).count(),
        0,
      );
    });
  });
test("focus trap cycles handles, switches and Done; ArrowUp/ArrowDown keep moved handle focused", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    const handle = sheet(page).getByRole("button", { name: "Move Follow-ups", exact: true });
    assert.equal(await handle.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await sheet(page)
        .getByRole("button", { name: "Done", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(await handle.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(
      await sheet(page)
        .getByRole("switch", { name: "Show Follow-ups", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await ids(rows(page)), ["promotions", "followUps", "newStudents"]);
    assert.equal(await handle.evaluate((node) => node === document.activeElement), true);
    await announce(page, "Follow-ups moved down");
    await page.keyboard.press("ArrowUp");
    assert.deepEqual(await ids(rows(page)), ["followUps", "promotions", "newStudents"]);
    assert.equal(await handle.evaluate((node) => node === document.activeElement), true);
    await announce(page, "Follow-ups moved up");
  });
});
test("live preview applies switches, order and Reset with shown, hidden, move and reset announcements", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    const toggle = sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true });
    await toggle.focus();
    await page.keyboard.press("Space");
    assert.deepEqual(await ids(panels(page)), ["promotions"]);
    await announce(page, "Follow-ups hidden");
    await page.keyboard.press("Space");
    assert.deepEqual(await ids(panels(page)), ["followUps", "promotions"]);
    await announce(page, "Follow-ups shown");
    await sheet(page)
      .getByRole("button", { name: "Move Follow-ups", exact: true })
      .press("ArrowDown");
    assert.deepEqual(await ids(panels(page)), ["promotions", "followUps"]);
    await announce(page, "Follow-ups moved down");
    await sheet(page).getByRole("switch", { name: "Show New students", exact: true }).click();
    assert.deepEqual(await ids(panels(page)), ["promotions", "followUps", "newStudents"]);
    await sheet(page).getByRole("button", { name: "Reset to defaults" }).click();
    assert.deepEqual(await ids(panels(page)), ["followUps", "promotions"]);
    await announce(page, "Reset to defaults");
    assert.equal(
      await sheet(page).getByRole("button", { name: "Reset to defaults" }).isDisabled(),
      true,
    );
    assert.equal(
      await sheet(page)
        .getByRole("button", { name: "Done", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
  });
});
for (const close of ["Done", "Escape", "backdrop"])
  test(`${close} closes, flushes pending PUT and returns focus to Edit Home`, async () => {
    await withPage({}, async (page) => {
      await deliver(page);
      await open(page);
      await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
      assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
      if (close === "Done")
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      else if (close === "Escape") await page.keyboard.press("Escape");
      else await page.locator(".koaryu-modal-backdrop").dispatchEvent("click");
      await flush(page);
      assert.equal(await sheet(page).count(), 0);
      await saved(page);
      assert.equal(await trigger(page).evaluate((node) => node === document.activeElement), true);
    });
  });
test("PUT uses exact preferences body and one 400ms debounce for a burst", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await tick(page, 200);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    await sheet(page).getByRole("switch", { name: "Show New students", exact: true }).click();
    await tick(page, 399);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    await tick(page, 1);
    await saved(page);
    assert.deepEqual(
      await page.evaluate(() => ({
        path: window.fixture.saves[0].path,
        body: window.fixture.saves[0].body,
      })),
      { path: "/dashboard/home/preferences", body: { ...defaults(), hidden: ["follow_ups"] } },
    );
  });
});
test("page hidden flushes immediately and unchanged opens/closes send no PUT", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await tick(page, 500);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await page.evaluate(() => window.fixture.visibility("hidden"));
    await saved(page);
  });
});
test("server preferences are adopted without pending edits and an older retained payload cannot revert a revisit", async () => {
  await withPage({}, async (page) => {
    const server = moveHomePanel(
      setHomePanelShown(defaults(), "recent_students", true),
      "recent_students",
      -2,
    );
    await deliver(page, "admin", server);
    assert.deepEqual(await ids(panels(page)), ["newStudents", "followUps", "promotions"]);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await saved(page);
    await flush(page);
    await page.evaluate(() => window.fixture.unmountHome());
    await flush(page);
    await page.evaluate(() => window.fixture.mountHome());
    await until(page, () => window.fixture.homeReads.length === 2);
    assert.deepEqual(await ids(panels(page)), ["newStudents", "promotions"]);
    // The revisit's own read started after the save, so the server already has it.
    await deliver(page, "admin", setHomePanelShown(server, "follow_ups", false), 1);
    assert.deepEqual(await ids(panels(page)), ["newStudents", "promotions"]);
  });
});
test("a read that started before a save lands late and is ignored; a read after it adopts a remote reset", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await page.evaluate(() => window.fixture.home.retry());
    await until(page, () => window.fixture.homeReads.length === 2);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await saved(page);
    await flush(page);
    // Started before the save: it carries the value the save replaced.
    await deliver(page, "admin", defaults(), 1);
    assert.deepEqual(await ids(panels(page)), ["promotions"]);
    // Started after the save: another device reset Home, and that is the server's value now.
    await page.evaluate(() => window.fixture.home.retry());
    await until(page, () => window.fixture.homeReads.length === 3);
    await deliver(page, "admin", defaults(), 2);
    assert.deepEqual(await ids(panels(page)), ["followUps", "promotions"]);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 1);
  });
});
test("a save does not trigger a fresh /dashboard/home re-read", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await saved(page);
    await tick(page, 1200);
    assert.equal(
      await page.evaluate(() => window.fixture.homeReads.length),
      1,
      "Preferences PUT must set marksDashboardFacts:false in the real API transport; saving a layout must not re-read Home facts.",
    );
  });
});
for (const status of [401, 402, 403])
  test(`preferences save ${status} follows the access error path`, async () => {
    await withPage({ saveError: status }, async (page) => {
      await deliver(page);
      await open(page);
      await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
      await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
      await saved(page);
      if (status === 402) {
        await until(page, () => window.fixture.store.subscriptionRequired);
        assert.ok(
          (await page.evaluate(() => window.fixture.redirects)).includes("/subscription-required"),
        );
      } else {
        await until(page, () => window.fixture.resumeEvents.length > 0);
        assert.deepEqual(await page.evaluate(() => window.fixture.resumeEvents[0]), {
          refreshData: false,
        });
      }
    });
  });
test("preferences save 409 suspends editing, hides retained Home, re-verifies identity and re-reads", async () => {
  await withPage({ saveError: 409 }, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await saved(page);
    await until(page, () => window.fixture.resumeEvents.length > 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.resumeEvents[0]), {
      refreshData: false,
    });
    // Like a refused Home read: nothing read before the refusal is shown, and Home re-reads.
    await until(page, () => window.fixture.homeReads.length === 2);
    assert.equal(
      await page.locator('[data-koaryu-dashboard-home="true"]').getAttribute("data-home-status"),
      "loading",
    );
    assert.equal(await panels(page).count(), 0);
    assert.equal(await trigger(page).count(), 0);
    await tick(page, 1000);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 1);
    // A read that started after the refusal succeeds: editing resumes and the edit is retried.
    await page.evaluate(() => {
      window.fixture.saveError = undefined;
    });
    await deliver(page, "admin", undefined, 1);
    assert.equal(await trigger(page).isDisabled(), false);
    assert.deepEqual(await ids(panels(page)), ["promotions"]);
    await tick(page, 400);
    await until(page, () => window.fixture.saves.length === 2);
    assert.deepEqual(await page.evaluate(() => window.fixture.saves[1].body.hidden), [
      "follow_ups",
      "recent_students",
    ]);
  });
});
const keyA = "koaryu:home-preferences:v1:user-a:studio-a";
const storedA = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), keyA);
for (const pending of ["debounced", "in flight"])
  test(`a direct account switch retires the previous user's ${pending} save and local copy`, async () => {
    await withPage({ holdSave: pending === "in flight" }, async (page) => {
      await deliver(page);
      await open(page);
      await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
      if (pending === "in flight") {
        await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
        await saved(page);
      }
      assert.notEqual(await page.evaluate((key) => localStorage.getItem(key), keyA), null);
      await page.evaluate(() =>
        window.fixture.emit("SIGNED_IN", {
          access_token: "token-b",
          user: { id: "user-b", email: "b@example.test", user_metadata: {} },
        }),
      );
      await until(
        page,
        () => window.fixture.store.identityReady && window.fixture.store.currentUserId === "user-b",
      );
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), keyA), null);
      if (pending === "in flight")
        await page.evaluate(() => window.fixture.saves[0].resolve(window.fixture.saves[0].body));
      await flush(page);
      await tick(page, 1000);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), keyA), null);
      assert.deepEqual(
        await page.evaluate(() => window.fixture.saves.map((save) => save.headers.Authorization)),
        pending === "in flight" ? ["Bearer token-a"] : [],
      );
    });
  });
for (const recovery of ["SIGNED_IN", "TOKEN_REFRESHED"])
  test(`same-user ${recovery} after a recoverable session-check reset keeps the unsaved edit and retries it`, async () => {
    await withPage({}, async (page) => {
      await deliver(page);
      await open(page);
      await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
      // The session check fails recoverably: identity is hidden, storage is kept.
      await page.evaluate(() => {
        const auth = window.fixture.supabase.auth;
        auth.realGetSession = auth.getSession;
        auth.getSession = async () => ({ data: { session: null }, error: Error("outage") });
        window.fixture.store.retryInitialization();
      });
      await until(
        page,
        () => !window.fixture.store.identityReady && window.fixture.store.identityLoadError,
      );
      // The debounce lands during the outage and is refused before anything is sent.
      await tick(page, 400);
      assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
      await page.evaluate((recovery) => {
        const f = window.fixture;
        f.supabase.auth.getSession = f.supabase.auth.realGetSession;
        f.emit(
          recovery,
          recovery === "TOKEN_REFRESHED" ? { ...f.session, access_token: "token-a2" } : f.session,
        );
      }, recovery);
      await until(
        page,
        () => window.fixture.store.identityReady && window.fixture.store.currentUserId === "user-a",
      );
      assert.deepEqual(await storedA(page), {
        preferences: setHomePanelShown(defaults(), "follow_ups", false),
        unsynced: true,
      });
      await until(page, () => window.fixture.homeReads.length === 2);
      await deliver(page, "admin", undefined, 1);
      assert.deepEqual(await ids(panels(page)), ["promotions"]);
      await page.evaluate(() => window.fixture.visibility("hidden"));
      await saved(page);
      assert.deepEqual(
        await page.evaluate(() => ({
          auth: window.fixture.saves[0].headers.Authorization,
          hidden: window.fixture.saves[0].body.hidden,
        })),
        {
          auth: recovery === "TOKEN_REFRESHED" ? "Bearer token-a2" : "Bearer token-a",
          hidden: ["follow_ups", "recent_students"],
        },
      );
    });
  });
test("an ordinary token refresh keeps the unsaved edit and saves it with the new token", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await page.evaluate(() => window.fixture.rotate("token-a2"));
    await flush(page);
    assert.equal(await page.evaluate(() => window.fixture.store.identityReady), true);
    assert.equal((await storedA(page))?.unsynced, true);
    assert.deepEqual(await ids(panels(page)), ["promotions"]);
    await tick(page, 400);
    await saved(page);
    assert.equal(
      await page.evaluate(() => window.fixture.saves[0].headers.Authorization),
      "Bearer token-a2",
    );
  });
});
test("save loader refuses another identity before sending and rejects a response after scope changes", async () => {
  await withPage({ holdSave: true }, async (page) => {
    await deliver(page);
    const mismatch = await page.evaluate(async (preferences) => {
      try {
        await window.fixture.store.saveDashboardHomePreferences(preferences, {
          userId: "other",
          studioId: "studio-a",
        });
        return null;
      } catch (error) {
        return error.message;
      }
    }, defaults());
    assert.match(mismatch, /scope changed/i);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    await page.evaluate((preferences) => {
      window.fixture.result = window.fixture.store
        .saveDashboardHomePreferences(preferences, { userId: "user-a", studioId: "studio-a" })
        .then(
          () => "accepted",
          (e) => e.message,
        );
    }, defaults());
    await saved(page);
    await page.evaluate(() => window.fixture.emit("SIGNED_OUT", null));
    await until(page, () => !window.fixture.store.identityReady);
    await page.evaluate(() => window.fixture.saves[0].resolve(window.fixture.saves[0].body));
    assert.match(await page.evaluate(() => window.fixture.result), /scope changed/i);
  });
});
test("sign-out purges every Home preferences key and keeps unrelated storage", async () => {
  await withPage({}, async (page) => {
    await deliver(page);
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await page.evaluate(() => {
      localStorage.setItem("koaryu-theme", "dark");
      localStorage.setItem("koaryu:home-preferences:v1:other:studio", "other");
      window.fixture.emit("SIGNED_OUT", null);
    });
    await until(page, () => !window.fixture.store.identityReady);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ["koaryu-theme"]);
  });
});
test("preview changes persist without a network request", async () => {
  await withPage({ preview: true }, async (page) => {
    await tick(page, 40);
    await until(page, () => document.querySelector('[data-home-status="ready"]'));
    await open(page);
    await sheet(page).getByRole("switch", { name: "Show Follow-ups", exact: true }).click();
    await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
    await tick(page, 500);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    assert.equal(await page.evaluate(() => window.fixture.saves.length), 0);
    assert.deepEqual(await ids(panels(page)), ["promotions"]);
  });
});
test("reduced motion skips settle animations while order and visibility still change", async () => {
  await withPage({}, async (page) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await deliver(page);
    await open(page);
    await page.evaluate(() => {
      window.fixture.animations = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        window.fixture.animations.push(args);
        return original.apply(this, args);
      };
    });
    await sheet(page)
      .getByRole("button", { name: "Move Follow-ups", exact: true })
      .press("ArrowDown");
    await sheet(page).getByRole("switch", { name: "Show New students", exact: true }).click();
    assert.deepEqual(await ids(panels(page)), ["promotions", "followUps", "newStudents"]);
    assert.deepEqual(await page.evaluate(() => window.fixture.animations), []);
  });
});
