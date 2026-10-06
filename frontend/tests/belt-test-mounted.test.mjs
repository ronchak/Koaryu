import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "@playwright/test";
import { MOCK_STUDENTS } from "../src/lib/mock-data.ts";
import {
  mountBeltFixture,
  resolveRead,
  resetStudio,
  flush,
  KEY,
  marker,
  fixture,
} from "./helpers/belt-test-mounted.mjs";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const settled = async (p) => {
  await p.evaluate(() => f.beltPromise);
  await flush(p);
};
for (const command of ["create", "update", "approve", "revoke"])
  test(`mounted ${command} transport uses exact command route and current reads`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser);
    try {
      await p.evaluate((command) => f.beltRun(command), command);
      await p.waitForFunction(() => f.writes.length === 1);
      const target = command === "create" ? "draft" : "target";
      assert.deepEqual(
        await p.evaluate(
          (target) => ({
            status: f.beltView(f[target]).status,
            current: f.beltView(f[target]).isCurrent(),
            locked: f.beltView(f[target]).locked,
          }),
          target,
        ),
        { status: "submitting", current: true, locked: true },
      );
      const write = await p.evaluate(() => ({
        path: f.writes[0].path,
        method: f.writes[0].method,
        body: JSON.parse(f.writes[0].body),
      }));
      const event = fixture.ids.event;
      assert.equal(
        write.path,
        command === "create"
          ? "/belt-tests"
          : command === "update"
            ? `/belt-tests/${event}`
            : command === "approve"
              ? `/belt-tests/${event}/recipients/approve`
              : `/belt-tests/${event}/recipients/${fixture.ids.recipient}/revoke`,
      );
      assert.equal(write.method, command === "update" ? "patch" : "post");
      await p.evaluate((command) => f.writes[0].resolve(f.beltResult(command)), command);
      await resolveRead(p, 0, "event", {
        name: "Current event",
        revision: 8,
        schedule_revision: 4,
      });
      if (command === "revoke") await resolveRead(p, 1, "recipient", { revision: 12 });
      await settled(p);
      assert.deepEqual(
        await p.evaluate(
          (target) => ({
            status: f.beltView(f[target]).status,
            current: f.beltView(f[target]).isCurrent(),
            locked: f.beltView(f[target]).locked,
            name: f.beltView(f[target]).currentEvent?.name,
          }),
          target,
        ),
        { status: "confirmed", current: true, locked: false, name: "Current event" },
      );
      assert.equal(await p.evaluate(() => f.beltReads.length), command === "revoke" ? 2 : 1);
      assert.equal(
        await p.evaluate((KEY) => JSON.parse(sessionStorage.getItem(KEY)).entries.length, KEY),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
for (const role of ["front_desk", "instructor", "student"])
  test(`mounted ${role} has zero belt API and journal access`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser, { role });
    try {
      await p.evaluate(() => f.beltRun());
      await settled(p);
      assert.deepEqual(
        await p.evaluate(() => ({
          storage: beltStorageReads + beltStorageWrites,
          reads: f.beltReads.length,
          writes: f.writes.length,
          status: f.store.beltTests.storage.status,
        })),
        { storage: 0, reads: 0, writes: 0, status: "inactive" },
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
test("mounted unverified admin does no belt I/O until workspace grants current authority", async () => {
  const { p, close, errors, finishIdentity } = await mountBeltFixture(browser, {
    unverified: true,
  });
  try {
    assert.equal(await p.evaluate(() => f.store.identityReady), false);
    await p.evaluate(() => f.beltRun());
    await settled(p);
    assert.deepEqual(
      await p.evaluate(() => [
        beltStorageReads + beltStorageWrites,
        f.beltReads.length,
        f.writes.length,
      ]),
      [0, 0, 0],
    );
    await finishIdentity();
    assert.equal(await p.evaluate(() => f.store.beltTests.storage.status), "ready");
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
for (const command of ["create", "update", "approve", "revoke"])
  test(`mounted unknown ${command} survives provider remount and checks without replay`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser);
    try {
      await p.evaluate((command) => f.beltRun(command), command);
      await p.waitForFunction(() => f.writes.length === 1);
      await p.evaluate(() => f.writes[0].reject(new f.Unknown()));
      await settled(p);
      await p.evaluate(() => {
        f.oldFacade = f.store.beltTests;
        f.showProvider(false);
      });
      await flush(p);
      await p.evaluate(() => f.showProvider(true));
      await p.waitForFunction(() => f.store.beltTests.storage.status === "ready");
      await p.evaluate(async () => {
        f.oldRead = await f.oldFacade.getEvent(f.target.id).catch((error) => error.message);
      });
      assert.match(await p.evaluate(() => f.oldRead), /administrator/);
      await p.evaluate(
        (command) => f.beltCheck(command === "create" ? f.draft : f.target),
        command,
      );
      await p.waitForFunction(() => f.beltReads.length === 1);
      await p.evaluate(
        (command) =>
          f.beltReads[0].resolve(f.beltReceipt(command, JSON.parse(f.writes[0].body).operation_id)),
        command,
      );
      await resolveRead(p, 1, "event", { name: "Later current" });
      if (command === "revoke")
        await resolveRead(p, 2, "recipient", { state: "approved", revision: 12 });
      await settled(p);
      assert.equal(
        await p.evaluate(
          (command) => f.beltView(command === "create" ? f.draft : f.target).status,
          command,
        ),
        "confirmed",
      );
      assert.equal(await p.evaluate(() => f.writes.length), 1);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
for (const action of ["clear", "reset"])
  for (const phase of ["event", "recipient", "receipt"])
    test(`${action} while ${phase} held permits a fresh exact recovery and fences old callbacks`, async () => {
      const { p, close, errors } = await mountBeltFixture(browser);
      const command = phase === "recipient" ? "revoke" : "update";
      try {
        await p.evaluate((command) => f.beltRun(command), command);
        await p.waitForFunction(() => f.writes.length === 1);
        if (phase === "receipt") {
          await p.evaluate(() => f.writes[0].reject(new f.Unknown()));
          await settled(p);
          await p.evaluate(() => f.beltCheck());
        } else {
          await p.evaluate((command) => f.writes[0].resolve(f.beltResult(command)), command);
          if (phase === "recipient") await resolveRead(p, 0);
        }
        const oldIndex = phase === "recipient" ? 1 : 0;
        await p.waitForFunction((index) => f.beltReads.length > index, oldIndex);
        await p.evaluate(() => {
          f.oldFacade = f.store.beltTests;
          f.oldView = f.beltView();
          f.oldPromise = f.beltPromise;
        });
        await resetStudio(p, action);
        assert.equal(await p.evaluate(() => f.oldView.isCurrent()), false);
        await p.evaluate(async () => {
          f.oldCall = await f.oldFacade.getEvent(f.target.id).catch((error) => error.message);
        });
        assert.match(await p.evaluate(() => f.oldCall), /administrator/);
        assert.equal(
          await p.evaluate(() => f.store.beltTests.pendingOperation(f.target).locked),
          true,
        );
        const nextIndex = await p.evaluate(() => f.beltReads.length);
        await p.evaluate(() => f.beltCheck());
        await p.waitForFunction((index) => f.beltReads.length > index, nextIndex);
        await p.evaluate(
          ({ oldIndex, phase }) =>
            f.beltReads[oldIndex].resolve(
              phase === "receipt"
                ? f.beltReceipt("update", JSON.parse(f.writes[0].body).operation_id)
                : phase === "recipient"
                  ? f.beltRecipient()
                  : f.beltEvent(),
            ),
          { oldIndex, phase },
        );
        await p.evaluate(() => f.oldPromise);
        await flush(p);
        assert.equal(await p.evaluate(() => f.beltView().status), "checking");
        await p.evaluate(
          ({ nextIndex, command }) =>
            f.beltReads[nextIndex].resolve(
              f.beltReceipt(command, JSON.parse(f.writes[0].body).operation_id),
            ),
          { nextIndex, command },
        );
        await p.waitForFunction((index) => f.beltReads.length > index + 1, nextIndex);
        await p.evaluate(
          (index) => f.beltReads[index + 1].reject(new f.ApiError("gone", 404)),
          nextIndex,
        );
        await settled(p);
        assert.equal(await p.evaluate(() => f.beltView().status), "unavailable");
        assert.equal(await p.evaluate(() => f.beltView().currentEvent), null);
        assert.equal(await p.evaluate(() => f.writes.length), 1);
        assert.equal(
          await p.evaluate((KEY) => JSON.parse(sessionStorage.getItem(KEY)).entries.length, KEY),
          0,
        );
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    });
for (const missing of [false, true])
  test(`mounted current child ${missing ? "404" : "200null"} retains parent only for genuine absence`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser);
    try {
      await p.evaluate(() => f.beltRun("revoke"));
      await p.waitForFunction(() => f.writes.length === 1);
      await p.evaluate(() => f.writes[0].resolve(f.beltResult("revoke")));
      await resolveRead(p, 0, "event", { name: "Verified parent" });
      await p.waitForFunction(() => f.beltReads.length === 2);
      await p.evaluate(
        (missing) =>
          missing
            ? f.beltReads[1].reject(new f.ApiError("gone", 404))
            : f.beltReads[1].resolve(null),
        missing,
      );
      await settled(p);
      assert.deepEqual(
        await p.evaluate(() => ({
          status: f.beltView().status,
          event: f.beltView().currentEvent?.name ?? null,
          child: f.beltView().currentRecipient,
          locked: f.beltView().locked,
        })),
        {
          status: missing ? "unavailable" : "confirmed_needs_refresh",
          event: missing ? "Verified parent" : null,
          child: null,
          locked: !missing,
        },
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
test("mounted token renewal retries old read401 and preserves single mutation", async () => {
  const { p, close, errors } = await mountBeltFixture(browser);
  try {
    await p.evaluate(() => f.beltRun());
    await p.waitForFunction(() => f.writes.length === 1);
    await p.evaluate(() => f.writes[0].resolve(f.beltResult("update")));
    await p.waitForFunction(() => f.beltReads.length === 1);
    await p.evaluate(() => f.emit("TOKEN_REFRESHED", { ...f.session, access_token: "token-2" }));
    await flush(p);
    await p.evaluate(() => f.beltReads[0].reject(new f.ApiError("old", 401)));
    await p.waitForFunction(() => f.beltReads.length === 2);
    assert.equal(await p.evaluate(() => f.beltReads[1].token), "token-2");
    await resolveRead(p, 1);
    await settled(p);
    assert.equal(await p.evaluate(() => f.beltView().status), "confirmed");
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
for (const change of ["role", "studio", "user_updated"])
  test(`mounted ${change} replacement fences old facade and retains metadata`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser);
    try {
      await p.evaluate(() => f.beltRun());
      await p.waitForFunction(() => f.writes.length === 1);
      await p.evaluate(() => f.writes[0].reject(new f.Unknown()));
      await settled(p);
      await p.evaluate((change) => {
        f.oldFacade = f.store.beltTests;
        f.oldView = f.beltView();
        if (change === "role") f.auth = { ...f.auth, role: "instructor" };
        if (change === "studio")
          f.auth = { ...f.auth, studio_id: "20000000-0000-4000-8000-000000000002" };
        f.emit("USER_UPDATED", f.session);
      }, change);
      await flush(p);
      await p.evaluate(async () => {
        f.oldFailure = await f.oldFacade.getEvent(f.target.id).catch((error) => error.message);
      });
      assert.match(await p.evaluate(() => f.oldFailure), /administrator/);
      assert.equal(await p.evaluate(() => f.oldView.isCurrent()), false);
      assert.equal(
        await p.evaluate((KEY) => JSON.parse(sessionStorage.getItem(KEY)).entries.length, KEY),
        1,
      );
      assert.equal(await p.evaluate(() => f.beltReads.length), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });
test("mounted stored create alias is recoverable without treating receipt rows as current", async () => {
  const journal = JSON.stringify({
    version: 1,
    entries: [marker("belt_test.create", { event_id: fixture.ids.event })],
  });
  const { p, close, errors } = await mountBeltFixture(browser, { journal });
  try {
    assert.equal(await p.evaluate(() => f.beltView(f.draft).status), "confirmed_needs_refresh");
    await p.evaluate(() => f.beltCheck(f.target));
    await p.waitForFunction(() => f.beltReads.length === 1);
    await p.evaluate(() => f.beltReads[0].reject(new f.ApiError("missing receipt", 404)));
    await settled(p);
    assert.equal(await p.evaluate(() => f.beltView(f.draft).status), "confirmed_needs_refresh");
    assert.equal(await p.evaluate(() => f.beltView(f.draft).currentEvent), null);
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
test("mounted preview keeps actual local IDs, seed eligibility and state across rerenders", async () => {
  const { p, close, errors } = await mountBeltFixture(browser, { preview: true });
  try {
    const result = await p.evaluate(async () => {
      const api = f.store.beltTests,
        page = await api.listEvents(),
        event = page.value.items[0];
      f.previewEvent = event;
      f.previewStudents = JSON.stringify(f.store.students);
      const candidates = (await api.getCandidates(event.id)).value;
      await f.store.setStudioName("Renamed sample studio");
      return {
        event,
        candidates,
        ladders: f.store.beltLadders.map((row) => row.id),
        students: f.store.students.map((row) => row.id),
        programs: f.store.programs.map((row) => row.id),
      };
    });
    assert.ok(result.ladders.includes(result.event.ladder_id));
    assert.equal(result.event.name, "Sample belt test");
    assert.ok(result.candidates.length > 0);
    assert.ok(result.candidates.every((row) => result.students.includes(row.student_id)));
    assert.ok(
      result.candidates.every(
        (row) => row.program_id === null || result.programs.includes(row.program_id),
      ),
    );
    assert.ok(result.candidates.some((row) => row.classes_since_promo > 0));
    await flush(p);
    assert.equal(
      await p.evaluate(async () => (await f.store.beltTests.listEvents()).value.items[0].id),
      result.event.id,
    );
    const local = await p.evaluate(async () => {
      const api = f.store.beltTests,
        event = f.previewEvent;
      const candidates = (await api.getCandidates(event.id)).value.filter(
        (row) => row.classes_met && row.time_met && row.next_rank_id,
      );
      if (!candidates.length) throw Error("Expected seed-eligible sample context");
      const pair = {
        student_id: candidates[0].student_id,
        student_program_membership_id: candidates[0].student_program_membership_id,
      };
      await api.approveRecipients(event, [pair]);
      const child = (await api.listRecipients(event.id)).value.items[0];
      await api.revokeRecipient(event, child);
      await api.updateEvent(event, { kind: "details", name: "Local edit" });
      await api.createEvent(f.draft.id, { ...f.beltFields, ladderId: event.ladder_id });
      await api.checkStorage();
      await api.checkResult(f.draft);
      return {
        count: (await api.listEvents()).value.items.length,
        state: (await api.getRecipient(event.id, child.id)).value.state,
        studentUnchanged: f.previewStudents === JSON.stringify(f.store.students),
        io: [f.beltReads.length, f.writes.length, beltStorageReads + beltStorageWrites],
      };
    });
    assert.equal(local.count, 2);
    assert.equal(local.state, "revoked");
    assert.equal(local.studentUnchanged, true);
    assert.deepEqual(local.io, [0, 0, 0]);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
for (const action of ["clear", "reset"])
  test(`preview ${action} resets local rows and invalidates old facade`, async () => {
    const { p, close, errors } = await mountBeltFixture(browser, { preview: true });
    try {
      await p.evaluate(async () => {
        f.oldFacade = f.store.beltTests;
        f.oldEvents = await f.oldFacade.listEvents();
      });
      await resetStudio(p, action);
      const result = await p.evaluate(async () => ({
        oldCurrent: f.oldEvents.isCurrent(),
        oldCall: await f.oldFacade.listEvents().then(
          () => "accepted",
          () => "stale",
        ),
        rows: (await f.store.beltTests.listEvents()).value.items,
        io: [f.beltReads.length, beltStorageReads + beltStorageWrites],
      }));
      assert.equal(result.oldCurrent, false);
      assert.equal(result.oldCall, "stale");
      if (action === "clear") assert.equal(result.rows.length, 0);
      else assert.equal(result.rows.length, 1);
      assert.deepEqual(result.io, [0, 0]);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  });

test("mounted preview hydrates legacy stored students and approves their explicit null membership", async () => {
  const legacy = MOCK_STUDENTS.map((student) => {
    const row = { ...student };
    delete row.program_memberships;
    return row;
  });
  const { p, close, errors } = await mountBeltFixture(
    {
      newContext: async () => {
        const context = await browser.newContext();
        await context.addInitScript(
          (rows) => localStorage.setItem("koaryu:students", JSON.stringify(rows)),
          legacy,
        );
        return context;
      },
    },
    { preview: true },
  );
  try {
    const result = await p.evaluate(async () => {
      const before = JSON.stringify(f.store.students),
        stored = localStorage.getItem("koaryu:students");
      const api = f.store.beltTests,
        event = (await api.listEvents()).value.items[0];
      const candidates = (await api.getCandidates(event.id)).value;
      const candidate = candidates.find(
        (row) => row.classes_met && row.time_met && row.next_rank_id,
      );
      if (!candidate) throw Error("Expected an eligible legacy sample student");
      await api.approveRecipients(event, [
        { student_id: candidate.student_id, student_program_membership_id: null },
      ]);
      const recipient = (await api.listRecipients(event.id)).value.items[0];
      return {
        legacyRows: f.store.students.every(
          (student) => !Object.hasOwn(student, "program_memberships"),
        ),
        trackerCount: f.store.eligibility.length,
        candidates,
        studentIds: f.store.students.map((student) => student.id),
        recipient,
        expectedStudent: candidate.student_id,
        unchanged:
          before === JSON.stringify(f.store.students) &&
          stored === localStorage.getItem("koaryu:students"),
        io: [f.beltReads.length, f.writes.length, beltStorageReads + beltStorageWrites],
      };
    });
    assert.equal(result.legacyRows, true);
    assert.ok(result.trackerCount > 0);
    assert.ok(result.candidates.length > 0);
    assert.ok(
      result.candidates.every(
        (row) =>
          result.studentIds.includes(row.student_id) && row.student_program_membership_id === null,
      ),
    );
    assert.equal(result.recipient.student_id, result.expectedStudent);
    assert.equal(result.recipient.student_program_membership_id, null);
    assert.equal(result.recipient.state, "approved");
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.io, [0, 0, 0]);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});
