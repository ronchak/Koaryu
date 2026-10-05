import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "@playwright/test";
import {
  mountTrialFixture,
  resolveTrialCurrent,
  flush,
  KEY,
  marker,
} from "./helpers/trial-appointment-mounted.mjs";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
test("mounted facade publishes current appointment/current lead and releases ordinary reservation", async () => {
  const { p, close } = await mountTrialFixture(browser);
  try {
    await p.evaluate(() => f.createTrial());
    await p.waitForFunction(() => f.writes.length === 1);
    assert.equal(
      await p.evaluate(() => f.store.leadOperations.current(f.trialLead)?.followUp),
      null,
    );
    assert.equal(await p.evaluate(() => f.viewTrial().ownsLeadReservation), true);
    await p.evaluate(() => f.writes[0].resolve(f.trialRow()));
    await resolveTrialCurrent(p);
    assert.equal(await p.evaluate(() => f.viewTrial().status), "confirmed");
    assert.equal(await p.evaluate(() => f.store.leadOperations.current(f.trialLead)), null);
    assert.equal(
      await p.evaluate(() => f.viewTrial().currentAppointment.starts_at),
      "2026-10-05T09:00:00.123456Z",
    );
  } finally {
    await close();
  }
});
test("provider remount reconstructs pending reservation before explicit receipt recovery", async () => {
  const { p, close } = await mountTrialFixture(browser);
  try {
    await p.evaluate(() => f.createTrial());
    await p.waitForFunction(() => f.writes.length === 1);
    await p.evaluate(() => f.lose(0));
    await p.evaluate(() => f.trialPromise);
    await p.evaluate(() => {
      f.oldTrialView = f.viewTrial();
      f.showProvider(false);
    });
    await flush(p);
    assert.equal(await p.evaluate(() => f.oldTrialView.isCurrent()), false);
    await p.evaluate(() => f.showProvider(true));
    await p.waitForFunction(() => f.viewTrial()?.ownsLeadReservation);
    assert.equal(await p.evaluate(() => f.trialReads.length), 0);
    assert.equal(
      await p.evaluate(() => Boolean(f.store.leadOperations.current(f.trialLead))),
      true,
    );
    await p.evaluate(() => f.checkTrial());
    await p.waitForFunction(() => f.trialReads.length === 1);
    await p.evaluate(() =>
      f.trialReads[0].resolve(f.trialReceipt(JSON.parse(f.writes[0].body).operation_id)),
    );
    await resolveTrialCurrent(p, 1);
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    assert.equal(await p.evaluate(() => f.viewTrial().status), "confirmed");
  } finally {
    await close();
  }
});
test("reload journal adopts exact lead reservation without receipt I/O", async () => {
  const { p, close } = await mountTrialFixture(browser, {
    journal: JSON.stringify({ version: 1, entries: [marker] }),
  });
  try {
    assert.equal(await p.evaluate(() => f.viewTrial().locked), true);
    assert.equal(await p.evaluate(() => f.viewTrial().ownsLeadReservation), true);
    assert.equal(await p.evaluate(() => f.trialReads.length), 0);
    assert.equal(await p.evaluate(() => f.store.leadOperations.reserve(f.trialLead)), null);
  } finally {
    await close();
  }
});
test("malformed journal blocks mutations without reserving ordinary lead rows", async () => {
  const { p, close } = await mountTrialFixture(browser, { journal: "bad" });
  try {
    assert.equal(await p.evaluate(() => f.store.trialAppointments.trialStorage.status), "blocked");
    assert.equal(await p.evaluate(() => f.store.trialAppointments.trialOperations.size), 0);
    assert.equal(await p.evaluate(() => f.store.leadOperations.current(f.trialLead)), null);
    await p.evaluate(() => f.createTrial());
    await p.evaluate(() => f.trialPromise);
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.equal(await p.evaluate((key) => sessionStorage.getItem(key), KEY), "bad");
  } finally {
    await close();
  }
});
for (const role of ["front_desk", "instructor"])
  test(`live ${role} trial facade has zero journal/API I/O`, async () => {
    const { p, close } = await mountTrialFixture(browser, {
      role,
      journal: JSON.stringify({ version: 1, entries: [marker] }),
    });
    try {
      assert.equal(await p.evaluate(() => window.trialStorageReads), 0);
      assert.equal(
        await p.evaluate(() => f.store.trialAppointments.trialStorage.status),
        "inactive",
      );
      await p.evaluate(async () => {
        try {
          await f.store.trialAppointments.listTrialAppointments(f.trialLead);
        } catch {}
      });
      assert.equal(await p.evaluate(() => f.trialReads.length), 0);
      assert.equal(await p.evaluate(() => window.trialStorageReads), 0);
    } finally {
      await close();
    }
  });
test("ordinary reservation conflict remains owned by its original command", async () => {
  const { p, close } = await mountTrialFixture(browser);
  try {
    await p.evaluate(
      ({ KEY, marker }) => {
        f.otherHandle = f.store.leadOperations.reserve(f.trialLead);
        sessionStorage.setItem(KEY, JSON.stringify({ version: 1, entries: [marker] }));
      },
      { KEY, marker },
    );
    await p.evaluate(() => f.store.trialAppointments.checkTrialAppointmentStorage());
    await flush(p);
    assert.equal(await p.evaluate(() => f.viewTrial().ownsLeadReservation), false);
    assert.equal(
      await p.evaluate(() => f.store.leadOperations.current(f.trialLead) === f.otherHandle),
      true,
    );
    await p.evaluate(() => f.checkTrial());
    await p.evaluate(() => f.trialPromise);
    assert.equal(await p.evaluate(() => f.trialReads.length), 0);
  } finally {
    await close();
  }
});
test("token renewal retries an exact current read without repeating mutation", async () => {
  const { p, close } = await mountTrialFixture(browser);
  try {
    await p.evaluate(() => f.createTrial());
    await p.waitForFunction(() => f.writes.length === 1);
    await p.evaluate(() => f.writes[0].resolve(f.trialRow()));
    await p.waitForFunction(() => f.trialReads.length === 1);
    await p.evaluate(() => {
      f.emit("TOKEN_REFRESHED", { ...f.session, access_token: "token-2" });
      f.trialReads[0].reject(new f.ApiError("old", 401));
    });
    await p.waitForFunction(() => f.trialReads.length === 2);
    await resolveTrialCurrent(p, 1);
    assert.equal(await p.evaluate(() => f.trialReads[1].token), "token-2");
    assert.equal(await p.evaluate(() => f.writes.length), 1);
  } finally {
    await close();
  }
});
test("newer ordinary lead publication fences pending trial reconciliation", async () => {
  const { p, close } = await mountTrialFixture(browser, {
    journal: JSON.stringify({ version: 1, entries: [marker] }),
  });
  try {
    await p.evaluate(() => f.checkTrial());
    await p.waitForFunction(() => f.trialReads.length === 1);
    await p.evaluate(() => f.trialReads[0].resolve(f.trialReceipt()));
    await p.waitForFunction(() => f.trialReads.length === 2);
    await p.evaluate(() => f.trialReads[1].resolve(f.trialRow()));
    await p.waitForFunction(() => f.rowReads.length === 1);
    await p.evaluate(() => {
      f.otherWrite = f.store.updateLead(f.trialLead, { first_name: "Newer" });
    });
    await p.waitForFunction(() => f.writes.length === 1);
    await p.evaluate(() => f.writes[0].resolve(f.createdRow({ first_name: "Newer" })));
    await p.evaluate(() => f.otherWrite);
    await p.evaluate(() => f.readRow(0));
    await p.evaluate(() => f.trialPromise);
    await flush(p);
    assert.equal(await p.evaluate(() => f.viewTrial().status), "confirmed_needs_refresh");
    assert.equal(await p.evaluate(() => f.stored(f.trialLead).first_name), "Newer");
    assert.equal(await p.evaluate(() => f.viewTrial().locked), true);
  } finally {
    await close();
  }
});
test("preview sample facade performs local history and cancellation with zero trial I/O", async () => {
  const { p, close } = await mountTrialFixture(browser, { preview: true, journal: "bad" });
  try {
    const data = await p.evaluate(async () => {
      const lead = f.store.leads[0].id,
        facade = f.store.trialAppointments;
      const result = await facade.listTrialAppointments(lead);
      await facade.updateTrialAppointment(result.value.items[0], {
        kind: "outcome",
        status: "canceled",
      });
      return {
        status: (await facade.getTrialAppointment(lead, result.value.items[0].id)).value.status,
        storageReads: window.trialStorageReads,
        reads: f.trialReads.length,
        writes: f.writes.length,
      };
    });
    assert.deepEqual(data, { status: "canceled", storageReads: 0, reads: 0, writes: 0 });
  } finally {
    await close();
  }
});
test("preview explicit current local program ID can be selected", async () => {
  const { p, close } = await mountTrialFixture(browser, { preview: true });
  try {
    const result = await p.evaluate(async () => {
      const facade = f.store.trialAppointments,
        lead = f.store.leads[0].id,
        program = f.store.programs.find((item) => !item.archived_at);
      const baseline = (await facade.listTrialAppointments(lead)).value.items[0];
      await facade.updateTrialAppointment(baseline, { kind: "outcome", status: "canceled" });
      await facade.createTrialAppointment(lead, {
        ...f.trialFields,
        program: { mode: "program", id: program.id },
      });
      return {
        actual: (await facade.listTrialAppointments(lead)).value.items[0].program_id,
        expected: program.id,
      };
    });
    assert.equal(result.actual, result.expected);
  } finally {
    await close();
  }
});
for (const action of ["clear", "reset"])
  test(`${action} fences held trial current lead and reconstructs exact reservation`, async () => {
    const { p, close } = await mountTrialFixture(browser);
    try {
      await p.evaluate(() => f.createTrial());
      await p.waitForFunction(() => f.writes.length === 1);
      await p.evaluate(() => f.writes[0].resolve(f.trialRow()));
      await p.waitForFunction(() => f.trialReads.length === 1);
      await p.evaluate(() => f.trialReads[0].resolve(f.trialRow()));
      await p.waitForFunction(() => f.rowReads.length === 1);
      await p.evaluate(async (action) => {
        f.oldTrialView = f.viewTrial();
        f.rows = [];
        if (action === "clear") {
          f.api.delete = async () => ({ studio_name: "Cleared" });
          await f.store.clearStudioData();
        } else {
          f.api.post = async () => ({
            studio_name: "Reset",
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
      await p.evaluate(() => f.rowReads[0].resolve(f.createdRow({ first_name: "Stale" })));
      await p.evaluate(() => f.trialPromise);
      await flush(p);
      assert.equal(await p.evaluate(() => f.oldTrialView.isCurrent()), false);
      assert.equal(await p.evaluate(() => f.store.leads.length), 0);
      assert.equal(await p.evaluate(() => f.viewTrial().ownsLeadReservation), true);
      assert.equal(
        await p.evaluate((KEY) => JSON.parse(sessionStorage.getItem(KEY)).entries.length, KEY),
        1,
      );
      await p.evaluate(() => f.checkTrial());
      await p.waitForFunction(() => f.trialReads.length === 2);
      await p.evaluate(() =>
        f.trialReads[1].resolve(f.trialReceipt(JSON.parse(f.writes[0].body).operation_id)),
      );
      await p.waitForFunction(() => f.trialReads.length === 3);
      await p.evaluate(() => f.trialReads[2].reject(new f.ApiError("gone", 404)));
      await p.waitForFunction(() => f.rowReads.length === 2);
      await p.evaluate(() => f.readRow(1));
      await p.evaluate(() => f.trialPromise);
      await flush(p);
      assert.equal(await p.evaluate(() => f.viewTrial().status), "unavailable");
      assert.equal(await p.evaluate(() => f.store.leads.length), 0);
    } finally {
      await close();
    }
  });
test("trial create and explicit check mark dashboard facts changed", async () => {
  const { p, close } = await mountTrialFixture(browser);
  try {
    await p.evaluate(() => {
      localStorage.removeItem("koaryu:facts-changed-at");
      f.createTrial();
    });
    await p.waitForFunction(() => f.writes.length === 1);
    assert.notEqual(await p.evaluate(() => localStorage.getItem("koaryu:facts-changed-at")), null);
    await p.evaluate(() => f.lose(0));
    await p.evaluate(() => f.trialPromise);
    await p.evaluate(() => {
      localStorage.removeItem("koaryu:facts-changed-at");
      f.checkTrial();
    });
    await p.waitForFunction(() => f.trialReads.length === 1);
    assert.notEqual(await p.evaluate(() => localStorage.getItem("koaryu:facts-changed-at")), null);
    await p.evaluate(() => f.trialReads[0].reject(new f.ApiError("missing", 404)));
    await p.evaluate(() => f.trialPromise);
  } finally {
    await close();
  }
});
test("preview owner survives changing callback and ref-wrapper identities", async () => {
  const { mountDriftingTrialPreview } = await import("./helpers/trial-appointment-mounted.mjs");
  const p = await mountDriftingTrialPreview(browser);
  try {
    const saved = await p.evaluate(async () => {
      const facade = f.actions.trialAppointments;
      const row = (await facade.listTrialAppointments("local-lead")).value.items[0];
      await facade.updateTrialAppointment(row, { kind: "outcome", status: "canceled" });
      return row.id;
    });
    await p.evaluate(() => f.rerender());
    await p.getByText("ready 1", { exact: true }).waitFor();
    assert.equal(
      await p.evaluate(
        async (id) =>
          (await f.actions.trialAppointments.getTrialAppointment("local-lead", id)).value.status,
        saved,
      ),
      "canceled",
    );
  } finally {
    await p.close();
  }
});
for (const fault of ["malformed", "unreadable"])
  test(`same-owner remount retains trusted trial row lock when journal becomes ${fault}`, async () => {
    const { p, close } = await mountTrialFixture(browser);
    try {
      await p.evaluate(() => f.createTrial());
      await p.waitForFunction(() => f.writes.length === 1);
      await p.evaluate(() => f.lose(0));
      await p.evaluate(() => f.trialPromise);
      await p.evaluate(
        ({ KEY, fault }) => {
          f.showProvider(false);
          if (fault === "malformed") sessionStorage.setItem(KEY, "bad");
          else {
            const original = Storage.prototype.getItem;
            Storage.prototype.getItem = function (key) {
              if (key === KEY) throw Error("unreadable");
              return original.call(this, key);
            };
          }
        },
        { KEY, fault },
      );
      await flush(p);
      await p.evaluate(() => f.showProvider(true));
      await p.waitForFunction(() => f.viewTrial()?.ownsLeadReservation);
      assert.equal(
        await p.evaluate(() => f.store.trialAppointments.trialStorage.status),
        "blocked",
      );
      assert.equal(await p.evaluate(() => f.viewTrial().locked), true);
      assert.equal(await p.evaluate(() => f.store.leadOperations.reserve(f.trialLead)), null);
      assert.equal(await p.evaluate(() => f.trialReads.length), 0);
      assert.equal(await p.evaluate(() => f.writes.length), 1);
    } finally {
      await close();
    }
  });
