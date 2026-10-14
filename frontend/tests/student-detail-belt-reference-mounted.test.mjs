import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const source = bundle("development", { detailController: true });

async function mount(t) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.evaluate(() => {
    const f = (window.fixture = {
      pathname: "/students/student-1",
      requests: [],
      observations: [],
      details: [],
      metadata: [],
      holdDetails: false,
    });
    history.replaceState(null, "", f.pathname);
    f.session = {
      access_token: "synthetic-a",
      user: { id: "user-a", email: "owner@example.test" },
    };
    f.auth = {
      user: f.session.user,
      studio_id: "studio-a",
      membership_status: "active",
      role: "admin",
      staff_profiles_available: true,
    };
    f.student = (id) => ({
      id,
      studio_id: f.auth.studio_id,
      legal_first_name: id,
      legal_last_name: "Student",
      status: "active",
      tags: [],
      guardians: [],
      programs: [],
    });
    f.supabase = {
      auth: {
        getSession: async () => ({ data: { session: f.session } }),
        onAuthStateChange: (callback) => {
          f.emit = (event, session) => {
            f.session = session;
            callback(event, session);
          };
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    };
    f.api = {
      get: async (path, token) => {
        f.requests.push({ path, token });
        if (path === "/dashboard/workspace")
          return { auth: f.auth, studio: { name: "Synthetic", timezone: "UTC" } };
        if (path.startsWith("/dashboard/bootstrap"))
          return {
            auth: f.auth,
            studio_name: "Synthetic",
            students: [],
            leads: [],
            programs: [],
            belt_ladders: [],
            primary_belt_ladder: null,
          };
        if (path.startsWith("/programs")) return [];
        if (path === "/belts/ladders")
          return new Promise((resolve, reject) => f.metadata.push({ resolve, reject, token }));
        if (path.includes("/belts/promotions") || path.startsWith("/belts/eligibility?")) return [];
        if (path.startsWith("/students/")) {
          if (f.holdDetails) return new Promise((resolve) => f.details.push(resolve));
          return f.student(path.split("/").at(-1));
        }
        throw Error(`Unexpected read ${path}`);
      },
    };
    f.navigate = (id) => {
      f.studentId = id;
      f.pathname = `/students/${id}`;
      history.pushState(null, "", f.pathname);
      window.dispatchEvent(new Event("fixture:navigate"));
    };
  });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.store?.identityReady);
  await page.evaluate(() => fixture.mountDetail());
  await page.waitForFunction(() => fixture.metadata.length === 1);
  return page;
}

for (const empty of [false, true]) {
  test(`student details share ${empty ? "loaded empty" : "populated"} belt metadata without eligibility or edit readiness`, async (t) => {
    const page = await mount(t);
    await page.evaluate((empty) => {
      fixture.rows = empty
        ? []
        : [
            { id: "metadata-ladder", name: "Karate", sub_rank_term: "Stripe", ranks: [] },
            { id: "other-ladder", name: "Judo", sub_rank_term: "Tip", ranks: [] },
          ];
      // Concurrent display consumers share the detail's pending metadata read.
      fixture.extraRead = fixture.store.refreshBeltLadders({ ifNeeded: true });
      fixture.metadata[0].resolve(fixture.rows);
    }, empty);
    await page.evaluate(() => fixture.extraRead);
    await page.waitForFunction(() => !fixture.detail.isLoadingBeltData);
    assert.deepEqual(
      await page.evaluate(() => fixture.store.beltLadders),
      await page.evaluate(() => fixture.rows),
    );
    assert.equal(
      await page.evaluate(() => fixture.store.currentLadderId),
      null,
      "Metadata must not select a ladder",
    );
    await page.evaluate(() => fixture.unmountDetail());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => {
      fixture.holdDetails = true;
      fixture.navigate("student-2");
      fixture.mountDetail();
    });
    await page.waitForFunction(
      () => fixture.details.length > 0 && !fixture.detail.isLoadingBeltData,
    );
    assert.equal(
      await page.evaluate(() => fixture.detail.detailReady),
      false,
      "Shared metadata cannot verify a student for edits",
    );
    await page.evaluate(() => {
      fixture.holdDetails = false;
      fixture.details.forEach((resolve) => resolve(fixture.student("student-2")));
    });
    await page.waitForFunction(() => fixture.detail.detailReady);
    await page.evaluate(() => fixture.unmountDetail());
    await page.waitForFunction(() => document.querySelector("output") !== null);
    await page.evaluate(() => {
      fixture.navigate("student-3");
      fixture.mountDetail();
    });
    await page.waitForFunction(
      () =>
        fixture.detail.student?.id === "student-3" &&
        fixture.detail.detailReady &&
        !fixture.detail.isLoadingBeltData,
    );
    assert.equal(await page.evaluate(() => fixture.metadata.length), 1);
    assert.equal(
      await page.evaluate(
        () => fixture.requests.filter((r) => r.path.startsWith("/belts/eligibility")).length,
      ),
      0,
    );
    // Fresh verification callers still perform a new metadata read.
    await page.evaluate(() => {
      fixture.fresh = fixture.store.refreshBeltLadders();
    });
    await page.waitForFunction(() => fixture.metadata.length === 2);
    await page.evaluate(() => fixture.metadata[1].resolve([]));
    assert.deepEqual(await page.evaluate(() => fixture.fresh), { ladders: [] });
  });
}

test("shared belt metadata retries failed display loads and fences renewed tokens and replaced identities", async (t) => {
  const page = await mount(t);
  await page.evaluate(() => fixture.metadata[0].reject(Error("Synthetic metadata failure")));
  await page.waitForFunction(() => fixture.detail.beltLoadError === "Synthetic metadata failure");
  await page.evaluate(() => {
    fixture.unmountDetail();
  });
  await page.evaluate(() => {
    fixture.navigate("student-2");
    fixture.mountDetail();
  });
  await page.waitForFunction(() => fixture.metadata.length === 2);
  await page.evaluate(() => {
    fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "synthetic-renewed" });
    fixture.metadata[1].resolve([{ id: "old-token", ranks: [] }]);
  });
  await page.waitForFunction(() => fixture.metadata.length === 3);
  assert.equal(await page.evaluate(() => fixture.metadata[2].token), "synthetic-renewed");
  await page.evaluate(() => fixture.metadata[2].resolve([]));
  await page.waitForFunction(() => !fixture.detail.isLoadingBeltData);
  assert.deepEqual(await page.evaluate(() => fixture.store.beltLadders), []);
  await page.evaluate(() => {
    fixture.oldRead = fixture.store.refreshBeltLadders().then(
      () => "unexpected success",
      (error) => error.message,
    );
  });
  await page.waitForFunction(() => fixture.metadata.length === 4);
  await page.evaluate(() => {
    const session = { ...fixture.session, user: { ...fixture.session.user, id: "user-b" } };
    fixture.auth = { ...fixture.auth, user: session.user, studio_id: "studio-b" };
    fixture.emit("SIGNED_IN", session);
  });
  await page.waitForFunction(
    () => fixture.store.currentStudioId === "studio-b" && fixture.store.identityReady,
  );
  await page.waitForFunction(() => fixture.metadata.length === 5);
  await page.evaluate(() => fixture.metadata[3].resolve([{ id: "stale-studio", ranks: [] }]));
  assert.match(await page.evaluate(() => fixture.oldRead), /workspace changed/);
  assert.deepEqual(await page.evaluate(() => fixture.store.beltLadders), []);
  await page.evaluate(() => fixture.metadata[4].resolve([{ id: "current-studio", ranks: [] }]));
  await page.waitForFunction(() => fixture.store.beltLadders[0]?.id === "current-studio");
});

test("a newer ladder selection supersedes an older metadata read", async (t) => {
  const page = await mount(t);
  await page.evaluate(() => {
    fixture.select = fixture.store.setCurrentLadder("selected");
  });
  await page.waitForFunction(() => fixture.metadata.length === 2);
  await page.evaluate(() =>
    fixture.metadata[1].resolve([
      { id: "selected", name: "Current", sub_rank_term: "Stripe", ranks: [] },
    ]),
  );
  await page.evaluate(() => fixture.select);
  await page.waitForFunction(() => fixture.store.currentLadderId === "selected");
  await page.evaluate(() => fixture.metadata[0].resolve([{ id: "outdated", ranks: [] }]));
  await page.waitForFunction(() => !fixture.detail.isLoadingBeltData);
  assert.equal(await page.evaluate(() => fixture.store.beltLadders[0]?.id), "selected");
  assert.equal(await page.evaluate(() => fixture.store.currentLadderId), "selected");
});

for (const change of ["unchanged", "id", "name", "sub_rank_term", "ranks", "updated_at"]) {
  test(`metadata ${change} ${change === "unchanged" ? "reuses" : "invalidates"} the Belt Tracker route snapshot`, async (t) => {
    const page = await mount(t);
    await page.evaluate(() => {
      fixture.original = { id: "ladder-one", name: "Karate", sub_rank_term: "Stripe", ranks: [] };
      fixture.metadata[0].resolve([fixture.original]);
    });
    await page.waitForFunction(() => !fixture.detail.isLoadingBeltData);
    await page.evaluate(() => {
      fixture.unmountDetail();
      fixture.pathname = "/belt-tracker";
      window.dispatchEvent(new Event("fixture:navigate"));
    });
    await page.waitForFunction(() => fixture.metadata.length === 2);
    await page.evaluate(() => fixture.metadata[1].resolve([fixture.original]));
    await page.waitForFunction(() => fixture.store.eligibilityLadderId === "ladder-one");
    await page.evaluate(() => {
      fixture.pathname = "/students/student-1";
      window.dispatchEvent(new Event("fixture:navigate"));
      fixture.refresh = fixture.store.refreshBeltLadders();
    });
    await page.waitForFunction(() => fixture.metadata.length === 3);
    await page.evaluate((change) => {
      fixture.updated = {
        ...fixture.original,
        ...(change === "unchanged"
          ? {}
          : change === "ranks"
            ? { ranks: [{ id: "rank-1", ladder_id: fixture.original.id, name: "White", order: 1 }] }
            : { [change]: "Changed" }),
      };
      fixture.metadata[2].resolve([fixture.updated]);
    }, change);
    await page.evaluate(() => fixture.refresh);
    const before = await page.evaluate(
      () => fixture.requests.filter((r) => r.path.startsWith("/belts/eligibility")).length,
    );
    await page.evaluate(() => {
      fixture.pathname = "/belt-tracker";
      window.dispatchEvent(new Event("fixture:navigate"));
    });
    if (change === "unchanged") {
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      assert.equal(await page.evaluate(() => fixture.metadata.length), 3);
    } else {
      await page.waitForFunction(() => fixture.metadata.length === 4);
      await page.evaluate(() => fixture.metadata[3].resolve([fixture.updated]));
      await page.waitForFunction(
        () =>
          fixture.store.currentLadderId === fixture.updated.id &&
          fixture.store.ladderName === fixture.updated.name &&
          fixture.store.subRankTerm === fixture.updated.sub_rank_term,
      );
      await page.waitForFunction(
        (before) =>
          fixture.requests.filter((r) => r.path.startsWith("/belts/eligibility")).length ===
          before + 1,
        before,
      );
    }
  });
}
