import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import {
  mountLeadCreateFixture,
  flushLeadCreate as flush,
} from "./helpers/lead-create-mounted.mjs";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const KEY = "koaryu-lead-create-operations-v1";
const button = (p, name) => p.getByRole("button", { name, exact: true });
async function openForm(p) {
  await p.getByRole("banner").getByRole("button", { name: "Add lead", exact: true }).click();
  await p.getByRole("heading", { name: "Add new lead" }).waitFor();
}
async function submit(p) {
  await openForm(p);
  await p.locator('[name="first_name"]').fill("Synthetic");
  await p.locator('[name="last_name"]').fill("Lead");
  await p.locator("form").getByRole("button", { name: "Add lead", exact: true }).click();
  await p.waitForFunction(() => f.writes.length === 1);
}
async function resolveCurrent(p, index = 0) {
  await p.waitForFunction((i) => f.rowReads.length > i, index);
  await p.evaluate((i) => f.readRow(i), index);
  await flush(p);
}
for (const role of ["admin", "front_desk"])
  test(`${role} direct success reads current row, upserts once, and preserves explicit UUID`, async () => {
    const p = await mountLeadCreateFixture(browser, { role, realControls: true });
    try {
      await submit(p);
      await p.evaluate(() => {
        void f.store.addLead({ first_name: "Duplicate", last_name: "Attempt" }).catch(() => {});
        f.emit("TOKEN_REFRESHED", { ...f.session, access_token: "token-2" });
      });
      await flush(p);
      assert.equal(await p.evaluate(() => f.writes.length), 1);
      assert.match(
        await p.evaluate(() => JSON.parse(f.writes[0].body).operation_id),
        /^[0-9a-f-]{36}$/,
      );
      await p.evaluate(() => f.commitCreate(0));
      await resolveCurrent(p);
      assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed");
      assert.equal(
        await p.evaluate(() => f.store.leads.filter((l) => l.id.startsWith("30000000")).length),
        1,
      );
      assert.equal(await p.evaluate(() => f.store.leads[0].first_name), "Current");
      assert.equal(await p.locator("form").count(), 0);
      assert.equal(
        await p
          .getByRole("banner")
          .getByRole("button", { name: "Add lead", exact: true })
          .evaluate((element) => document.activeElement === element),
        true,
      );
      assert.equal(await p.evaluate(() => f.rowReads[0].token), "token-2");
      assert.deepEqual(
        await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries, KEY),
        [],
      );
    } finally {
      await p.close();
    }
  });
test("unknown survives modal close, route/provider remount, and read-only recovery", async () => {
  const p = await mountLeadCreateFixture(browser);
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0, { lose: true }));
    await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
    await button(p, "Close add lead dialog").click();
    await openForm(p);
    assert.equal(
      await p.locator("form").getByRole("button", { name: "Add lead", exact: true }).isDisabled(),
      true,
    );
    await p.evaluate(() => f.showPage(false));
    await flush(p);
    await p.evaluate(() => f.showPage(true));
    await flush(p);
    await p.evaluate(() => f.showProvider(false));
    await flush(p);
    await p.evaluate(() => f.showProvider(true));
    await p.waitForFunction(() => f.store.identityReady && f.store.leadCreate.isCurrent());
    assert.equal(await p.evaluate(() => f.store.leadCreate.locked), true);
    assert.equal(
      await p.evaluate(
        () => f.reads.filter((r) => r.path.startsWith("/automations/operations/")).length,
      ),
      0,
    );
    await button(p, "Check result").click();
    await resolveCurrent(p);
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed");
    assert.equal(
      await p.evaluate(() => f.store.leads.filter((l) => l.id.startsWith("30000000")).length),
      1,
    );
  } finally {
    await p.close();
  }
});
test("metadata-only reload adopts after verified owner and reads receipt before current entity", async () => {
  const p = await mountLeadCreateFixture(browser);
  let journal, receipt;
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0, { lose: true }));
    await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
    journal = await p.evaluate((key) => sessionStorage.getItem(key), KEY);
    receipt = await p.evaluate(() => Object.values(f.createReceipts)[0]);
  } finally {
    await p.close();
  }
  const fresh = await mountLeadCreateFixture(browser, { journal });
  try {
    await fresh.evaluate((receipt) => {
      f.createReceipts[receipt.operation_id] = receipt;
      f.rows = [f.createdRow({ first_name: "Edited after save" })];
    }, receipt);
    assert.equal(await fresh.evaluate(() => f.store.leadCreate.status), "unknown");
    assert.equal(await fresh.locator("form").count(), 0);
    await button(fresh, "Check result").click();
    await resolveCurrent(fresh);
    assert.equal(await fresh.evaluate(() => f.writes.length), 0);
    assert.equal(await fresh.evaluate(() => f.store.leads[0].first_name), "Edited after save");
  } finally {
    await fresh.close();
  }
});
for (const direct of [true, false])
  test(`${direct ? "direct" : "recovered"} current404 shows unavailable without stale row or unconditional success`, async () => {
    const p = await mountLeadCreateFixture(browser);
    try {
      await submit(p);
      await p.evaluate((direct) => f.commitCreate(0, { lose: !direct, missing: true }), direct);
      if (!direct) {
        await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
        await button(p, "Check result").click();
      }
      await resolveCurrent(p);
      assert.equal(await p.evaluate(() => f.store.leadCreate.locked), false);
      assert.equal(
        await p
          .getByText("The lead was created but is no longer available.", { exact: true })
          .count(),
        1,
      );
      assert.equal(await p.getByText("Lead added to the pipeline.", { exact: true }).count(), 0);
      assert.equal(
        await p.evaluate(() => f.store.leads.some((l) => l.id.startsWith("30000000"))),
        false,
      );
      await openForm(p);
      assert.equal(
        await p.locator("form").getByRole("button", { name: "Add lead", exact: true }).isEnabled(),
        true,
      );
    } finally {
      await p.close();
    }
  });
test("recovery cannot close a replacement modal in the same owner", async () => {
  const p = await mountLeadCreateFixture(browser, { realControls: true });
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0, { lose: true }));
    await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
    await button(p, "Check result").click();
    await p.waitForFunction(() => f.rowReads.length === 1);
    await button(p, "Close add lead dialog").click();
    await openForm(p);
    await p.locator('[name="first_name"]').fill("Replacement form");
    await resolveCurrent(p);
    assert.equal(await p.locator("form").count(), 1);
    assert.equal(await p.locator('[name="first_name"]').inputValue(), "Replacement form");
  } finally {
    await p.close();
  }
});
for (const action of ["clear", "reset"])
  test(`${action} fences a held current read, retains marker, and next check observes unavailable`, async () => {
    const p = await mountLeadCreateFixture(browser);
    try {
      await submit(p);
      await p.evaluate(() => f.commitCreate(0));
      await p.waitForFunction(() => f.rowReads.length === 1);
      const old = await p.evaluate(() => f.createdRow({ first_name: "Stale before clear" }));
      await p.evaluate(async (action) => {
        f.rows = [];
        if (action === "clear") {
          f.api.delete = async () => ({
            studio_name: "Cleared",
            automation: {
              workflows_paused: 0,
              workflow_runs_cancelled: 0,
              workflow_cancellation_intents_added: 0,
              attendance_deliveries_cancelled: 0,
              belt_test_events_deleted: 0,
              belt_test_recipients_deleted: 0,
              sending_attempts_preserved: 0,
              unknown_attempts_preserved: 0,
              attendance_rule_paused: false,
            },
          });
          await f.store.clearStudioData();
        } else {
          f.api.post = async () => ({
            studio_name: "Reset",
            automation: {
              workflows_paused: 0,
              workflow_runs_cancelled: 0,
              workflow_cancellation_intents_added: 0,
              attendance_deliveries_cancelled: 0,
              belt_test_events_deleted: 0,
              belt_test_recipients_deleted: 0,
              sending_attempts_preserved: 0,
              unknown_attempts_preserved: 0,
              attendance_rule_paused: false,
            },
            students: [],
            leads: [],
            programs: [],
            belt_ladders: [],
            primary_belt_ladder: null,
            eligibility: [],
            templates: [],
            sessions: [],
            attendance: [],
          });
          await f.store.resetDemoData();
        }
      }, action);
      await flush(p);
      await p.evaluate((old) => f.rowReads[0].resolve(old), old);
      await p.waitForFunction(() => f.store.leadCreate.status === "confirmed_needs_refresh");
      assert.equal(await p.evaluate(() => f.store.leads.length), 0);
      assert.equal(
        await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
        1,
      );
      await button(p, "Check result").click();
      await resolveCurrent(p, 1);
      assert.equal(await p.evaluate(() => f.store.leadCreate.status), "unavailable");
      assert.equal(await p.evaluate(() => f.store.leads.length), 0);
    } finally {
      await p.close();
    }
  });
test("provider detachment fences old current observation even if original auth request remains current", async () => {
  const p = await mountLeadCreateFixture(browser);
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0));
    await p.waitForFunction(() => f.rowReads.length === 1);
    await p.evaluate(() => f.showProvider(false));
    await flush(p);
    await p.evaluate(() => f.rowReads[0].resolve(f.createdRow({ first_name: "Old attachment" })));
    await flush(p);
    assert.equal(
      await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
      1,
    );
    await p.evaluate(() => f.showProvider(true));
    await p.waitForFunction(() => f.store.identityReady && f.store.leadCreate.isCurrent());
    assert.equal(await p.evaluate(() => f.store.leadCreate.locked), true);
    assert.equal(
      await p.evaluate(() => f.store.leads.some((l) => l.first_name === "Old attachment")),
      false,
    );
  } finally {
    await p.close();
  }
});
test("nonmanager invokes neither create/readback nor journal I/O", async () => {
  const p = await mountLeadCreateFixture(browser, { role: "instructor" });
  try {
    await p.evaluate(async () => {
      let calls = 0;
      Storage.prototype.getItem = new Proxy(Storage.prototype.getItem, {
        apply(target, that, args) {
          if (args[0] === "koaryu-lead-create-operations-v1") calls++;
          return Reflect.apply(target, that, args);
        },
      });
      Storage.prototype.setItem = new Proxy(Storage.prototype.setItem, {
        apply(target, that, args) {
          if (args[0] === "koaryu-lead-create-operations-v1") calls++;
          return Reflect.apply(target, that, args);
        },
      });
      await f.store.addLead({ first_name: "Denied", last_name: "Lead" }).catch(() => {});
      await f.store.checkLeadCreateResult().catch(() => {});
      f.journalCalls = calls;
    });
    assert.equal(await p.evaluate(() => f.journalCalls), 0);
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.equal(
      await p.evaluate(() => f.reads.some((r) => r.path.startsWith("/automations/operations/"))),
      false,
    );
  } finally {
    await p.close();
  }
});
test("preview preserves local lead creation without live requests or recovery journal", async () => {
  const p = await mountLeadCreateFixture(browser, { preview: true });
  try {
    await openForm(p);
    await p.locator('[name="first_name"]').fill("Preview");
    await p.locator('[name="last_name"]').fill("Only");
    await p.locator("form").getByRole("button", { name: "Add lead", exact: true }).click();
    await p.waitForFunction(() => f.store.leads.some((l) => l.first_name === "Preview"));
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.equal(await p.evaluate(() => f.reads.length), 0);
    assert.equal(await p.evaluate((key) => sessionStorage.getItem(key), KEY), null);
  } finally {
    await p.close();
  }
});

test("owner replacement and ABA never revive the original pending callback", async () => {
  const p = await mountLeadCreateFixture(browser);
  try {
    await submit(p);
    const historical = await p.evaluate(() => f.createdRow());
    await p.evaluate(() => {
      f.originalAuth = structuredClone(f.auth);
      f.rows = [];
      f.auth = { ...f.auth, user: { ...f.auth.user, id: "10000000-0000-4000-8000-000000000002" } };
      f.emit("SIGNED_IN", { access_token: "user-b", user: f.auth.user });
    });
    await p.waitForFunction(
      () =>
        f.store.identityReady &&
        f.store.currentUserId === "10000000-0000-4000-8000-000000000002" &&
        f.store.leadCreate.isCurrent(),
    );
    assert.equal(await p.evaluate(() => f.store.leadCreate.status), "idle");
    await p.evaluate(() => {
      f.auth = f.originalAuth;
      f.emit("SIGNED_IN", { access_token: "user-a-again", user: f.auth.user });
    });
    await p.waitForFunction(
      () =>
        f.store.identityReady &&
        f.store.currentUserId === "10000000-0000-4000-8000-000000000001" &&
        f.store.leadCreate.status === "unknown",
    );
    await openForm(p);
    await p.locator('[name="first_name"]').fill("Returned owner form");
    await p.evaluate((row) => f.writes[0].resolve(row), historical);
    await flush(p);
    assert.equal(await p.evaluate(() => f.store.leadCreate.status), "unknown");
    assert.equal(await p.locator('[name="first_name"]').inputValue(), "Returned owner form");
    assert.equal(await p.evaluate(() => f.store.leads.length), 0);
    assert.equal(await p.evaluate(() => f.rowReads.length), 0);
    assert.equal(
      await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
      1,
    );
  } finally {
    await p.close();
  }
});
test("newer row write during recovery prevents a stale upsert and keeps recovery available", async () => {
  const p = await mountLeadCreateFixture(browser);
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0, { lose: true }));
    await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
    await button(p, "Check result").click();
    await p.waitForFunction(() => f.rowReads.length === 1);
    await p.evaluate(() => {
      void f.store.updateLead("30000000-0000-4000-8000-000000000001", { first_name: "Newer" });
    });
    await p.waitForFunction(() => f.writes.length === 2);
    await p.evaluate(() => f.writes[1].resolve(f.createdRow({ first_name: "Newer" })));
    await flush(p);
    await p.evaluate(() =>
      f.rowReads[0].resolve(f.createdRow({ first_name: "Old held snapshot" })),
    );
    await p.waitForFunction(() => f.store.leadCreate.status === "confirmed_needs_refresh");
    assert.equal(
      await p.evaluate(() => f.store.leads.some((l) => l.first_name === "Old held snapshot")),
      false,
    );
    assert.equal(
      await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
      1,
    );
  } finally {
    await p.close();
  }
});
test("recovery updates dashboard projection freshness through the existing command owner", async () => {
  const p = await mountLeadCreateFixture(browser);
  try {
    await submit(p);
    await p.evaluate(() => f.commitCreate(0, { lose: true }));
    await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
    await p.evaluate(() => localStorage.removeItem("koaryu:facts-changed-at"));
    await button(p, "Check result").click();
    await p.waitForFunction(() => f.rowReads.length === 1);
    assert.ok(await p.evaluate(() => localStorage.getItem("koaryu:facts-changed-at")));
    await p.evaluate(() => localStorage.removeItem("koaryu:facts-changed-at"));
    await resolveCurrent(p);
    assert.ok(await p.evaluate(() => localStorage.getItem("koaryu:facts-changed-at")));
  } finally {
    await p.close();
  }
});

for (const status of [401, 403])
  test(`current create denial${status} explains disabled access without reusing old status`, async () => {
    const p = await mountLeadCreateFixture(browser);
    try {
      await submit(p);
      await p.evaluate(
        (status) => f.writes[0].reject(new f.ApiError("Private backend denial", status)),
        status,
      );
      await p.waitForFunction(() => !f.store.leadCreate.isCurrent());
      assert.equal(await p.evaluate(() => f.store.identityReady), true);
      assert.equal(await p.evaluate(() => f.store.currentRole), "admin");
      assert.equal(
        await p.locator("form").getByRole("button", { name: "Add lead", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await p
          .getByText(
            "Your studio access needs to be checked. Reload this page before adding a lead.",
            { exact: true },
          )
          .count(),
        1,
      );
      assert.equal(await p.getByText("Private backend denial", { exact: true }).count(), 0);
      assert.equal(await button(p, "Check result").count(), 0);
      assert.equal(
        await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
        1,
      );
      assert.equal(await p.evaluate(() => f.writes.length), 1);
    } finally {
      await p.close();
    }
  });

for (const held of ["post", "current"])
  test(`provider replacement survives the old ${held}401 and checks with token2`, async () => {
    const p = await mountLeadCreateFixture(browser);
    try {
      await submit(p);
      if (held === "current") {
        await p.evaluate(() => f.commitCreate(0));
        await p.waitForFunction(() => f.rowReads.length === 1);
      }
      await p.evaluate(() => f.showProvider(false));
      await flush(p);
      await p.evaluate(() => {
        f.session = { ...f.session, access_token: "token-2" };
        f.showProvider(true);
      });
      await p.waitForFunction(
        () =>
          f.store.identityReady && f.store.leadCreate.isCurrent() && f.store.token === "token-2",
      );
      await p.evaluate((held) => {
        if (held === "post") f.commitCreate(0, { denial: 401 });
        else f.rowReads[0].reject(new f.ApiError("Old provider expired", 401));
      }, held);
      await p.waitForFunction(() =>
        ["unknown", "confirmed_needs_refresh"].includes(f.store.leadCreate.status),
      );
      assert.equal(await p.evaluate(() => f.store.leadCreate.isCurrent()), true);
      assert.equal(
        await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
        1,
      );
      await button(p, "Check result").click();
      await resolveCurrent(p, held === "post" ? 0 : 1);
      assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed");
      assert.equal(await p.evaluate(() => f.rowReads.at(-1).token), "token-2");
      assert.equal(
        await p.evaluate(
          () =>
            f.reads.filter((read) => read.path.startsWith("/automations/operations/")).at(-1).token,
        ),
        "token-2",
      );
      assert.equal(await p.evaluate(() => f.writes.length), 1);
    } finally {
      await p.close();
    }
  });

for (const newer of [false, true])
  test(`confirmed404 ${newer ? "preserves newer publication" : "removes the exact cached row"}`, async () => {
    const p = await mountLeadCreateFixture(browser);
    try {
      await submit(p);
      await p.evaluate(() => f.commitCreate(0, { lose: true }));
      await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
      await p.evaluate(() => f.store.refreshLeads());
      await p.waitForFunction(() => f.store.leads.length === 3);
      await p.evaluate(() => {
        f.rows = f.rows.filter((row) => !row.id.startsWith("30000000"));
      });
      await button(p, "Check result").click();
      await p.waitForFunction(() => f.rowReads.length === 1);
      if (newer) {
        await p.evaluate(() => {
          void f.store.updateLead("30000000-0000-4000-8000-000000000001", {
            first_name: "Newer observation",
          });
        });
        await p.waitForFunction(() => f.writes.length === 2);
        await p.evaluate(() =>
          f.writes[1].resolve(f.createdRow({ first_name: "Newer observation" })),
        );
        await flush(p);
      }
      await resolveCurrent(p);
      assert.equal(
        await p.evaluate(() => f.store.leads.filter((row) => ["a", "b"].includes(row.id)).length),
        2,
      );
      if (newer) {
        assert.equal(
          await p.evaluate(
            () => f.store.leads.find((row) => row.id.startsWith("30000000")).first_name,
          ),
          "Newer observation",
        );
        assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed_needs_refresh");
        assert.equal(
          await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
          1,
        );
      } else {
        assert.equal(await p.evaluate(() => f.store.leads.length), 2);
        assert.equal(await p.evaluate(() => f.store.leadCreate.status), "unavailable");
        assert.equal(
          await p.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).entries.length, KEY),
          0,
        );
      }
    } finally {
      await p.close();
    }
  });

for (const replacement of ["reopened", "page remount", "provider remount"])
  test(`Check result preserves a ${replacement} draft opened before checking`, async () => {
    const p = await mountLeadCreateFixture(browser, { realControls: true });
    try {
      await submit(p);
      await p.evaluate(() => f.commitCreate(0, { lose: true }));
      await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
      if (replacement === "reopened") await button(p, "Close add lead dialog").click();
      else {
        await p.evaluate(
          (which) => (which === "page remount" ? f.showPage(false) : f.showProvider(false)),
          replacement,
        );
        await flush(p);
        await p.evaluate(
          (which) => (which === "page remount" ? f.showPage(true) : f.showProvider(true)),
          replacement,
        );
        await p.waitForFunction(() => f.store.identityReady && f.store.leadCreate.isCurrent());
        await flush(p);
      }
      await openForm(p);
      await p.locator('[name="first_name"]').fill("Replacement draft");
      await p.locator('[name="last_name"]').fill("Unsaved");
      await button(p, "Check result").click();
      await resolveCurrent(p);
      assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed");
      assert.equal(await p.locator("form").count(), 1);
      assert.equal(await p.locator('[name="first_name"]').inputValue(), "Replacement draft");
      assert.equal(await p.locator('[name="last_name"]').inputValue(), "Unsaved");
      assert.equal(await p.evaluate(() => f.writes.length), 1);
    } finally {
      await p.close();
    }
  });

for (const edit of ["native field", "program", "unchanged"])
  test(`recovery closure respects the original form ${edit}`, async () => {
    const programId = "50000000-0000-4000-8000-000000000001";
    const p = await mountLeadCreateFixture(browser, {
      realControls: true,
      programs: [
        {
          id: programId,
          name: "Recovery program",
          color_hex: "#123456",
          archived_at: null,
          is_system: false,
        },
      ],
    });
    try {
      await submit(p);
      await p.evaluate(() => f.commitCreate(0, { lose: true }));
      await p.waitForFunction(() => f.store.leadCreate.status === "unknown");
      if (edit === "native field") await p.locator('[name="notes"]').fill("Unsaved local note");
      if (edit === "program")
        await p.getByRole("combobox", { name: "Program", exact: true }).selectOption(programId);
      await button(p, "Check result").click();
      await resolveCurrent(p);
      assert.equal(await p.evaluate(() => f.store.leadCreate.status), "confirmed");
      assert.equal(await p.locator("form").count(), edit === "unchanged" ? 0 : 1);
      if (edit === "native field")
        assert.equal(await p.locator('[name="notes"]').inputValue(), "Unsaved local note");
      if (edit === "program")
        assert.equal(
          await p.getByRole("combobox", { name: "Program", exact: true }).inputValue(),
          programId,
        );
      assert.equal(await p.evaluate(() => f.writes.length), 1);
    } finally {
      await p.close();
    }
  });
