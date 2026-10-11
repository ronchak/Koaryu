import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import {
  flush,
  homeCount,
  mountHome,
  rejectHome,
  resolveHome,
  state,
  tick,
  until,
} from "./helpers/home-hook-mounted.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
function mounted(name, run, options = {}) {
  test(name, async (t) => {
    const { page, errors } = await mountHome(browser, options);
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, [], "unexpected browser errors");
    });
    await run(page);
  });
}
async function coldReady(page) {
  await until(page, () => window.fixture.homeReads.length === 1);
  await resolveHome(page);
  await until(page, () => window.fixture.home.status === "ready");
}
async function retry(page) {
  await page.evaluate(() => window.fixture.home.retry());
  await flush(page);
}

for (const mode of ["production", "development"]) {
  mounted(
    `cold ${mode}: identity gates Home, one GET, pending state, no summary read`,
    async (page) => {
      assert.equal(await homeCount(page), 0);
      assert.equal((await state(page)).status, "loading");
      await page.evaluate(() => {
        window.fixture.holdSession = false;
        window.fixture.releaseSession();
      });
      await until(page, () => window.fixture.homeReads.length === 1);
      assert.equal((await state(page)).isRevalidating, true);
      assert.equal((await state(page)).name, null);
      const request = await page.evaluate(() =>
        window.fixture.requests.find((r) => r.path.startsWith("/dashboard/home")),
      );
      assert.equal(request.path, "/dashboard/home");
      assert.equal(request.token, "token-a");
      assert.deepEqual(request.options, {
        timeoutMs: 35000,
        timeoutMessage: "Home refresh timed out.",
      });
      await resolveHome(page);
      assert.equal((await state(page)).isRevalidating, false);
      assert.equal(await homeCount(page), 1);
      assert.equal(
        await page.evaluate(() =>
          window.fixture.requests.some((r) => r.path.startsWith("/dashboard/summary")),
        ),
        false,
      );
    },
    { mode, holdSession: true },
  );
}

mounted(
  "StrictMode mounts after identity ready dedupe the loader",
  async (page) => {
    await until(page, () => window.fixture.store.identityReady);
    await page.evaluate(() => window.fixture.mountHome());
    await until(page, () => window.fixture.homeReads.length === 1);
    await resolveHome(page);
    assert.equal(await homeCount(page), 1);
  },
  { mode: "development", homeMounted: false },
);

mounted(
  "subscription gate prevents Home reads and retry",
  async (page) => {
    await until(page, () => window.fixture.store.subscriptionRequired);
    await retry(page);
    await tick(page, 60000);
    assert.equal(await homeCount(page), 0);
    assert.equal((await state(page)).name, null);
  },
  { workspaceError: 402 },
);

mounted("fresh=true lasts strictly less than 60 seconds after a facts mark", async (page) => {
  await coldReady(page);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  assert.equal(
    await page.evaluate(() => window.fixture.homeReads[1].path),
    "/dashboard/home?fresh=true",
  );
  await resolveHome(page, 1);
  await tick(page, 59699);
  await retry(page);
  assert.equal(
    await page.evaluate(() => window.fixture.homeReads[2].path),
    "/dashboard/home?fresh=true",
  );
  await resolveHome(page, 2);
  await tick(page, 1);
  assert.equal(await page.evaluate(() => window.fixture.homeReads[3].path), "/dashboard/home");
  await resolveHome(page, 3);
});

mounted(
  "revisit paints retained ready immediately, revalidates once, swaps in place",
  async (page) => {
    await coldReady(page);
    await page.evaluate(() => window.fixture.unmountHome());
    await flush(page);
    const offset = await page.evaluate(() => window.fixture.homeRenders.length);
    await page.evaluate(() => window.fixture.mountHome());
    await until(page, () => window.fixture.homeReads.length === 2);
    assert.equal((await state(page)).name, "initial");
    assert.equal((await state(page)).status, "ready");
    assert.equal((await state(page)).isRevalidating, true);
    await resolveHome(page, 1, "updated");
    const renders = await page.evaluate(
      (offset) => window.fixture.homeRenders.slice(offset),
      offset,
    );
    assert.ok(
      renders.every((r) => r.status === "ready"),
      "revisit must never render loading",
    );
    assert.equal(renders[0].payload.studio.name, "initial");
    assert.equal((await state(page)).name, "updated");
    assert.equal(await homeCount(page), 2);
  },
);

mounted("success landing after unmount is retained for the next mount", async (page) => {
  await until(page, () => window.fixture.homeReads.length === 1);
  await page.evaluate(() => window.fixture.unmountHome());
  await flush(page);
  await resolveHome(page, 0, "landed away");
  const offset = await page.evaluate(() => window.fixture.homeRenders.length);
  await page.evaluate(() => window.fixture.mountHome());
  await until(page, () => window.fixture.homeReads.length === 2);
  assert.equal((await state(page)).name, "landed away");
  assert.equal(
    await page.evaluate((offset) => window.fixture.homeRenders[offset].status, offset),
    "ready",
  );
});

mounted("focus and visibility share a 5-second throttle and in-flight dedupe", async (page) => {
  await coldReady(page);
  await tick(page, 4999);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.fixture.visibility("visible");
  });
  assert.equal(await homeCount(page), 1);
  await tick(page, 1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until(page, () => window.fixture.homeReads.length === 2);
  await tick(page, 5000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.fixture.visibility("visible");
    window.fixture.home.retry();
  });
  await flush(page);
  assert.equal(await homeCount(page), 2, "plain triggers must join the pending read");
  await resolveHome(page, 1);
  await tick(page, 5000);
  await page.evaluate(() => window.fixture.visibility("visible"));
  await until(page, () => window.fixture.homeReads.length === 3);
});

mounted("60-second interval reads while visible and skips while hidden", async (page) => {
  await coldReady(page);
  await tick(page, 59999);
  assert.equal(await homeCount(page), 1);
  await tick(page, 1);
  assert.equal(await homeCount(page), 2);
  await resolveHome(page, 1);
  await page.evaluate(() => window.fixture.visibility("hidden"));
  await tick(page, 120000);
  assert.equal(await homeCount(page), 2);
  await page.evaluate(() => window.fixture.visibility("visible"));
  await until(page, () => window.fixture.homeReads.length === 3);
});

mounted(
  "facts debounce resets for bursts, skips pending commands, reads after post-command mark",
  async (page) => {
    await coldReady(page);
    await page.evaluate(() => window.fixture.markFacts());
    await tick(page, 200);
    await page.evaluate(() => {
      window.fixture.markFacts();
      window.fixture.markFacts();
    });
    await tick(page, 299);
    assert.equal(await homeCount(page), 1);
    await tick(page, 1);
    assert.equal(await homeCount(page), 2);
    await resolveHome(page, 1);
    await page.evaluate(() => {
      window.fixture.finishCommand = window.fixture.beginPendingCommand();
      window.fixture.markFacts();
    });
    await tick(page, 300);
    assert.equal(await homeCount(page), 2);
    await page.evaluate(() => {
      window.fixture.finishCommand();
      window.fixture.markFacts();
    });
    await tick(page, 299);
    assert.equal(await homeCount(page), 2);
    await tick(page, 1);
    assert.equal(await homeCount(page), 3);
    assert.equal(
      await page.evaluate(() => window.fixture.homeReads[2].path),
      "/dashboard/home?fresh=true",
    );
  },
);

mounted("other-tab storage event refreshes after debounce with fresh facts", async (page) => {
  await coldReady(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "unrelated", newValue: String(Date.now()) }),
    ),
  );
  await tick(page, 300);
  assert.equal(await homeCount(page), 1);
  await page.evaluate(() => {
    localStorage.setItem("koaryu:facts-changed-at", String(Date.now()));
    window.dispatchEvent(
      new StorageEvent("storage", { key: "koaryu:facts-changed-at", newValue: String(Date.now()) }),
    );
  });
  await tick(page, 299);
  assert.equal(await homeCount(page), 1);
  await tick(page, 1);
  assert.equal(await homeCount(page), 2);
  assert.equal(
    await page.evaluate(() => window.fixture.homeReads[1].path),
    "/dashboard/home?fresh=true",
  );
});

mounted(
  "midnight business-date flip keeps old payload ready until server today arrives",
  async (page) => {
    await coldReady(page);
    const offset = await page.evaluate(() => window.fixture.homeRenders.length);
    await page.clock.setSystemTime(new Date("2026-10-11T00:00:01Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(
      page,
      () =>
        window.fixture.store.businessDate === "2026-10-11" && window.fixture.homeReads.length === 2,
    );
    assert.equal((await state(page)).today, "2026-10-10");
    assert.equal((await state(page)).status, "ready");
    await resolveHome(page, 1, "new day", "2026-10-11");
    assert.equal((await state(page)).today, "2026-10-11");
    assert.ok(
      await page.evaluate(
        (offset) => window.fixture.homeRenders.slice(offset).every((r) => r.status === "ready"),
        offset,
      ),
      "client midnight must never blank Home",
    );
  },
);

mounted(
  "ordinary error keeps payload and asOf, remains during retry, clears on success",
  async (page) => {
    await coldReady(page);
    await retry(page);
    await rejectHome(page, 1);
    assert.deepEqual(await state(page), {
      status: "error",
      name: "initial",
      today: "2026-10-10",
      error: "Home outage",
      asOf: "2026-10-10T12:00:00Z",
      isRevalidating: false,
    });
    await retry(page);
    assert.equal((await state(page)).error, "Home outage");
    assert.equal((await state(page)).isRevalidating, true);
    await resolveHome(page, 2, "recovered");
    assert.equal((await state(page)).error, null);
    assert.equal((await state(page)).status, "ready");
    assert.equal((await state(page)).name, "recovered");
  },
);

mounted("cold failure without payload settles as error", async (page) => {
  await until(page, () => window.fixture.homeReads.length === 1);
  await rejectHome(page, 0);
  assert.deepEqual(await state(page), {
    status: "error",
    name: null,
    today: null,
    error: "Home outage",
    asOf: null,
    isRevalidating: false,
  });
});

for (const outcome of ["success", "failure"]) {
  mounted(`older success cannot overwrite a newer ${outcome}`, async (page) => {
    await until(page, () => window.fixture.homeReads.length === 1);
    await page.evaluate(() => window.fixture.markFacts());
    await tick(page, 300);
    assert.equal(await homeCount(page), 2, "fresh read must not join a plain read");
    if (outcome === "success") await resolveHome(page, 1, "newer");
    else await rejectHome(page, 1, 500, "newer failure");
    const newer = await state(page);
    await resolveHome(page, 0, "obsolete");
    assert.deepEqual(
      await state(page),
      { ...newer, isRevalidating: false },
      "older success overwrote a newer outcome",
    );
  });
}

mounted("older ordinary failure is ignored while newer fresh read is pending", async (page) => {
  await until(page, () => window.fixture.homeReads.length === 1);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  await rejectHome(page, 0, 500, "obsolete failure");
  assert.equal((await state(page)).error, null);
  assert.equal((await state(page)).isRevalidating, true);
  await resolveHome(page, 1, "newer");
  assert.equal((await state(page)).name, "newer");
});

mounted("older success after unmount cannot replace the newer retained outcome", async (page) => {
  await until(page, () => window.fixture.homeReads.length === 1);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  assert.equal(await homeCount(page), 2);
  await page.evaluate(() => window.fixture.unmountHome());
  await flush(page);
  await resolveHome(page, 1, "newer retained");
  await resolveHome(page, 0, "obsolete retained");
  await page.evaluate(() => window.fixture.mountHome());
  await until(page, () => window.fixture.homeReads.length === 3);
  assert.equal(
    (await state(page)).name,
    "newer retained",
    "Home restored an obsolete success that landed after a newer success while unmounted",
  );
});

mounted("plain retry joins a fresh flight and does not start another request", async (page) => {
  await coldReady(page);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  await page.clock.setSystemTime(new Date("2026-10-10T12:01:01Z"));
  await retry(page);
  assert.equal(await homeCount(page), 2);
  await resolveHome(page, 1, "fresh result");
  assert.equal((await state(page)).name, "fresh result");
});

mounted(
  "402 clears displayed data, gates subsequent reads, redirects to subscription recovery",
  async (page) => {
    await coldReady(page);
    await retry(page);
    await rejectHome(page, 1, 402, "Subscription required");
    await until(
      page,
      () =>
        window.fixture.store.subscriptionRequired &&
        window.fixture.redirects.includes("/subscription-required"),
    );
    assert.equal((await state(page)).name, null);
    await retry(page);
    await tick(page, 60000);
    assert.equal(await homeCount(page), 2);
  },
);

for (const status of [401, 403]) {
  mounted(
    `${status} clears payload and retained data, rechecks workspace without data refresh`,
    async (page) => {
      await coldReady(page);
      const start = await page.evaluate(() => window.fixture.requests.length);
      await page.evaluate(() => {
        window.fixture.holdWorkspace = true;
      });
      await retry(page);
      await rejectHome(page, 1, status, status === 403 ? "Staff archived" : "Session refused");
      await until(page, () => Boolean(window.fixture.releaseWorkspace));
      assert.equal((await state(page)).name, null);
      assert.equal((await state(page)).status, "error");
      assert.deepEqual(await page.evaluate(() => window.fixture.resumeEvents), [
        { refreshData: false },
      ]);
      await page.evaluate(() => window.fixture.releaseWorkspace());
      await flush(page);
      assert.deepEqual(
        await page.evaluate(
          (start) => window.fixture.requests.slice(start).map((r) => r.path),
          start,
        ),
        ["/dashboard/home", "/dashboard/workspace"],
      );
      assert.equal(await page.evaluate(() => window.fixture.refreshEvents), 0);
      await page.evaluate(() => window.fixture.unmountHome());
      await flush(page);
      await page.evaluate(() => window.fixture.mountHome());
      await until(page, () => window.fixture.homeReads.length === 3);
      assert.equal(
        (await state(page)).name,
        null,
        "refused retained payload must not reappear on revisit",
      );
    },
  );
  mounted(`${status} denied workspace resets identity and removes Home payload`, async (page) => {
    await coldReady(page);
    await page.evaluate((status) => {
      window.fixture.workspaceError = status;
    }, status);
    await retry(page);
    await rejectHome(page, 1, status, "Access refused");
    await until(page, () => !window.fixture.store.identityReady);
    assert.equal((await state(page)).name, null);
    assert.equal(await page.evaluate(() => window.fixture.store.currentStudioId), null);
    assert.ok(await page.evaluate(() => window.fixture.workspaceReads.length >= 2));
  });
}

mounted(
  "loader rejects mismatched studio id",
  async (page) => {
    await until(page, () => window.fixture.store.identityReady);
    await page.evaluate(() => {
      window.fixture.loaderOutcome = null;
      window.fixture.store.loadDashboardHome({ fresh: false }).then(
        () => (window.fixture.loaderOutcome = "unexpected success"),
        (error) => (window.fixture.loaderOutcome = error.message),
      );
    });
    await until(page, () => window.fixture.homeReads.length === 1);
    await page.evaluate(() => {
      const payload = window.fixture.payload();
      payload.studio.id = "studio-other";
      window.fixture.homeReads[0].resolve(payload);
    });
    await until(page, () => window.fixture.loaderOutcome !== null);
    assert.equal(
      await page.evaluate(() => window.fixture.loaderOutcome),
      "Dashboard scope changed. Please retry.",
    );
  },
  { homeMounted: false },
);

mounted(
  "identity change in flight ignores old success and never displays previous user's payload",
  async (page) => {
    await coldReady(page);
    await retry(page);
    const offset = await page.evaluate(() => window.fixture.homeRenders.length);
    await page.evaluate(() => {
      window.fixture.studioId = "studio-b";
      window.fixture.emit("SIGNED_IN", {
        access_token: "token-b",
        user: { id: "user-b", email: "b@example.test", user_metadata: {} },
      });
    });
    await until(
      page,
      () =>
        window.fixture.store.currentUserId === "user-b" && window.fixture.homeReads.length === 3,
    );
    assert.equal((await state(page)).name, null);
    await page.evaluate(() =>
      window.fixture.homeReads[1].resolve({
        ...window.fixture.payload("obsolete"),
        studio: { ...window.fixture.payload().studio, id: "studio-a" },
      }),
    );
    await flush(page);
    assert.equal(
      (await state(page)).error,
      null,
      "old scope failure must not become new scope's error",
    );
    assert.equal((await state(page)).name, null);
    await resolveHome(page, 2, "user-b data");
    assert.equal((await state(page)).name, "user-b data");
    assert.ok(
      await page.evaluate(
        (offset) =>
          window.fixture.homeRenders
            .slice(offset)
            .every((r) => r.payload === null || r.payload.studio.id === "studio-b"),
        offset,
      ),
      "new identity rendered previous identity's data",
    );
  },
);

mounted("token rotation in same identity retries loader with current token", async (page) => {
  await until(page, () => window.fixture.homeReads.length === 1);
  const generation = await page.evaluate(() => window.fixture.store.identityGeneration);
  await page.evaluate(() => window.fixture.rotate("token-renewed"));
  await flush(page);
  await resolveHome(page, 0, "stale token data");
  await until(page, () => window.fixture.homeReads.length === 2);
  assert.equal(await page.evaluate(() => window.fixture.homeReads[1].token), "token-renewed");
  assert.equal((await state(page)).name, null);
  assert.equal(await page.evaluate(() => window.fixture.store.identityGeneration), generation);
  await resolveHome(page, 1, "renewed data");
  assert.equal((await state(page)).name, "renewed data");
});

mounted(
  "preview uses admin fixture and store UTC business date without network",
  async (page) => {
    // Preview identity hydration intentionally starts on a zero-delay task.
    await tick(page, 1);
    await until(page, () => window.fixture.home?.status === "ready");
    assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
    assert.equal(await page.evaluate(() => window.fixture.home.payload.viewer.role), "admin");
    assert.equal(
      await page.evaluate(
        () => window.fixture.home.payload.studio.today === window.fixture.store.businessDate,
      ),
      true,
    );
    assert.equal((await state(page)).today, "2026-10-10");
    await page.clock.setSystemTime(new Date("2026-10-11T00:00:01Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(
      page,
      () =>
        window.fixture.store.businessDate === "2026-10-11" && !window.fixture.home.isRevalidating,
    );
    assert.equal(
      (await state(page)).today,
      "2026-10-11",
      "Preview Home kept yesterday's fixture after the store advanced its UTC business date and revalidation settled",
    );
    assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
  },
  { preview: true },
);

mounted("a refusal is not undone by an older success that lands after navigation", async (page) => {
  await coldReady(page);
  await retry(page);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  assert.equal(await homeCount(page), 3, "plain read A, then fresh read B");
  await page.evaluate(() => {
    window.fixture.holdWorkspace = true;
    window.fixture.unmountHome();
  });
  await flush(page);
  await rejectHome(page, 2, 403, "Access refused");
  await until(page, () => Boolean(window.fixture.releaseWorkspace), "workspace recheck pending");
  await resolveHome(page, 1, "before refusal");
  const offset = await page.evaluate(() => window.fixture.homeRenders.length);
  await page.evaluate(() => window.fixture.mountHome());
  await until(page, () => window.fixture.homeReads.length === 4);
  const revisit = await state(page);
  assert.equal(revisit.name, null, "an older success restored data after a refusal");
  assert.ok(["loading", "error"].includes(revisit.status));
  await page.evaluate(() => window.fixture.releaseWorkspace());
  await flush(page);
  await resolveHome(page, 3, "verified again");
  assert.equal((await state(page)).name, "verified again");
  assert.ok(
    await page.evaluate(
      (offset) =>
        window.fixture.homeRenders
          .slice(offset)
          .every((r) => r.payload === null || r.payload.studio.name === "verified again"),
      offset,
    ),
    "Home painted refused or pre-refusal data before a fresh read succeeded",
  );
});

mounted("a read after a command never joins a flight started before it", async (page) => {
  await coldReady(page);
  await page.evaluate(() => window.fixture.markFacts());
  await tick(page, 300);
  assert.equal(await homeCount(page), 2, "fresh read held in flight");
  await page.evaluate(() => {
    const finish = window.fixture.beginPendingCommand();
    window.fixture.markFacts();
    finish();
    window.fixture.markFacts();
  });
  await tick(page, 300);
  await resolveHome(page, 1, "before command");
  assert.equal(await homeCount(page), 3, "post-command read joined the pre-command flight");
  assert.equal(
    await page.evaluate(() => window.fixture.homeReads[2].path),
    "/dashboard/home?fresh=true",
  );
  await resolveHome(page, 2, "after command");
  assert.equal((await state(page)).name, "after command");
  assert.equal((await state(page)).isRevalidating, false);
});
