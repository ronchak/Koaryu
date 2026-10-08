import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
const { add, modules } = createCommonJsPacker({
  "@/lib/api": `exports.ApiError=class ApiError extends Error{constructor(message,status){super(message);this.status=status;}};`,
  "@/lib/access-identity": `exports.captureAccessIdentity=()=>{throw Error('Unexpected live auth')};exports.invalidateAccessIdentity=()=>{throw Error('Unexpected auth write')};`,
  "@/lib/studio-state-cookie": `exports.getActiveStudioIdCookie=()=>null;`,
});
const moduleIds = [
  add("@/lib/belt-test-operation"),
  add("@/lib/preview-belt-test-owner"),
  add("@/lib/api"),
];
const [m, preview, { ApiError }] = new Function(
  `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}return ${JSON.stringify(moduleIds)}.map(require);`,
)();
const data = JSON.parse(
  readFileSync(new URL("./fixtures/belt-test-contract.json", import.meta.url)),
);
const ids = data.ids,
  USER = "abcdefab-cdef-4abc-8def-000000000099";
const uid = (n) => `abcdefab-cdef-4abc-8def-${String(n).padStart(12, "0")}`;
const draft = { kind: "draft", id: uid(100) },
  target = { kind: "event", id: ids.event };
const key = (value) => `${value.kind}:${value.id.toLowerCase()}`;
const clone = (value) => structuredClone(value);
const fields = () => ({
  name: data.events.create.name,
  ladderId: ids.ladder,
  schedule: {
    starts_at: data.events.create.starts_at,
    ends_at: data.events.create.ends_at,
    timezone: data.events.create.timezone,
  },
  location: "",
  status: "draft",
});
const marker = (command = "belt_test.update", changes = {}) => ({
  command,
  operation_id: ids.operation,
  owner_user_id: USER,
  owner_studio_id: ids.studio,
  target: command === "belt_test.create" ? draft : target,
  ...(command === "belt_test.revoke" ? { recipient_id: ids.recipient } : {}),
  ...changes,
});
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ entries, raw, storage = new Map(), scope } = {}) {
  if (entries) storage.set(m.BELT_TEST_JOURNAL_KEY, JSON.stringify({ version: 1, entries }));
  if (raw !== undefined) storage.set(m.BELT_TEST_JOURNAL_KEY, raw);
  const f = {
    storage,
    calls: [],
    storageReads: 0,
    storageWrites: 0,
    invalidations: 0,
    begins: 0,
    finishes: 0,
    active: true,
    epoch: 0,
    resource: 0,
    token: 1,
    operation: 0,
    studio: scope?.studioId ?? ids.studio,
    readFault: null,
    writeFault: null,
    eventRow: {
      ...data.events.scheduled,
      name: "Current event",
      revision: 8,
      schedule_revision: 4,
    },
    recipientRow: { ...data.recipients.approved, revision: 12 },
  };
  const deps = {
    capture(observed, invalidated) {
      f.captured = observed;
      f.invalidateAuthority = () => {
        f.active = false;
        f.epoch++;
        invalidated();
      };
      const epoch = f.epoch;
      return {
        isCurrent: () => f.active && f.epoch === epoch,
        dispose() {},
        signal: new AbortController().signal,
      };
    },
    invalidate() {
      f.invalidations++;
      f.invalidateAuthority();
    },
    activeStudio: () => f.studio,
    uuid: () => (f.operation++ === 0 ? ids.operation : uid(200 + f.operation)),
    storage: () => ({
      getItem(name) {
        f.storageReads++;
        if (f.readFault) return f.readFault(name);
        return storage.get(name) ?? null;
      },
      setItem(name, value) {
        f.storageWrites++;
        if (f.writeFault) return f.writeFault(name, value);
        storage.set(name, value);
      },
    }),
  };
  f.impl = {
    listEvents: async () => data.event_page,
    event: async () => f.eventRow,
    listRecipients: async () => data.recipient_page,
    recipient: async () => f.recipientRow,
    candidates: async () => data.candidates,
    create: async () => data.events.create,
    update: async () => data.events.name_update,
    approve: async () => data.approval,
    revoke: async () => data.recipients.revoked,
    receipt: async () => f.receipt,
  };
  f.attach = () => {
    const resource = f.resource;
    f.detach = f.owner.bind({
      isCurrent: () => f.resource === resource,
      beginMutation() {
        f.begins++;
        let finished = false;
        return () => {
          assert.equal(finished, false);
          finished = true;
          f.finishes++;
        };
      },
      beginRequest() {
        const token = f.token,
          epoch = f.epoch;
        return {
          token: `token-${token}`,
          isCurrent: () => f.active && epoch === f.epoch && token === f.token,
          isSameIdentity: () => f.active && epoch === f.epoch,
          canRetryAfterTokenChange: () => f.active && epoch === f.epoch && token !== f.token,
        };
      },
      ...Object.fromEntries(
        Object.keys(f.impl).map((name) => [
          name,
          (...args) => {
            f.calls.push({ name, args });
            return f.impl[name](...args);
          },
        ]),
      ),
    });
  };
  f.owner = m.createBeltTestOwner(
    scope ?? { userId: USER, studioId: ids.studio, role: "admin" },
    deps,
  );
  f.attach();
  f.api = () => f.owner.getSnapshot();
  f.view = (value = target) => f.api().operations.get(key(value));
  f.journal = () => JSON.parse(storage.get(m.BELT_TEST_JOURNAL_KEY) ?? '{"entries":[]}').entries;
  f.reset = () => {
    f.resource++;
    f.detach();
    f.attach();
  };
  return f;
}
const commands = {
  create: {
    command: "belt_test.create",
    target: draft,
    call: (api) => api.createEvent(draft.id, fields()),
    result: data.events.create,
  },
  update: {
    command: "belt_test.update",
    target,
    call: (api) =>
      api.updateEvent(clone(data.events.scheduled), { kind: "details", name: "Changed" }),
    result: data.events.name_update,
  },
  approve: {
    command: "belt_test.approve",
    target,
    call: (api) =>
      api.approveRecipients(clone(data.events.scheduled), clone(data.requests.approve.recipients)),
    result: data.approval,
  },
  revoke: {
    command: "belt_test.revoke",
    target,
    call: (api) =>
      api.revokeRecipient(clone(data.events.scheduled), clone(data.recipients.approved)),
    result: data.recipients.revoked,
  },
};
for (const [name, command] of Object.entries(commands)) {
  test(`${name}: direct acknowledgement publishes exact current reads`, async () => {
    const f = fixture(),
      method = f.api().createEvent;
    await command.call(f.api());
    assert.deepEqual(
      f.calls.map((call) => call.name),
      [name, "event", ...(name === "revoke" ? ["recipient"] : [])],
    );
    const view = f.view(command.target);
    assert.equal(view.status, "confirmed");
    assert.equal(view.locked, false);
    assert.equal(view.isCurrent(), true);
    assert.equal(view.currentEvent.name, "Current event");
    assert.equal(view.currentRecipient?.revision ?? null, name === "revoke" ? 12 : null);
    assert.equal(view.currentRecipient?.state ?? null, name === "revoke" ? "approved" : null);
    assert.equal(f.api().createEvent, method);
    assert.equal(f.api(), f.api());
    assert.deepEqual(f.journal(), []);
    assert.equal(f.begins, 1);
    assert.equal(f.finishes, 1);
    assert.ok(Object.isFrozen(view));
    assert.ok(Object.isFrozen(view.currentEvent));
    assert.ok(Object.isFrozen(f.calls[0].args.find((arg) => arg && typeof arg === "object")));
    assert.equal(Object.hasOwn(view, "operation_id"), false);
  });
  test(`${name}: lost response checks receipt then current without mutation replay`, async () => {
    const f = fixture();
    f.impl[name] = async () => {
      throw Error("private timeout");
    };
    await assert.rejects(command.call(f.api()), (error) => !error.message.includes("private"));
    assert.equal(f.view(command.target).status, "unknown");
    assert.equal(f.view(command.target).locked, true);
    assert.deepEqual(
      Object.keys(f.journal()[0]).sort(),
      Object.keys(marker(command.command)).sort(),
    );
    assert.equal(JSON.stringify(f.journal()).includes("student"), false);
    f.receipt = { ...data.receipts[command.command], result: command.result };
    await f.api().checkResult(command.target);
    assert.deepEqual(
      f.calls.map((call) => call.name),
      [name, "receipt", "event", ...(name === "revoke" ? ["recipient"] : [])],
    );
    assert.equal(f.view(command.target).status, "confirmed");
    assert.deepEqual(f.journal(), []);
  });
  for (const invalid of [null, undefined, [], { wrong: true }])
    test(`${name}: malformed direct ${JSON.stringify(invalid)} retains unknown`, async () => {
      const f = fixture();
      f.impl[name] = async () => invalid;
      await assert.rejects(command.call(f.api()));
      assert.equal(f.view(command.target).status, "unknown");
      assert.equal(f.journal().length, 1);
      assert.equal(f.calls.length, 1);
    });
}
test("approval body and baseline remain immutable despite caller edits", async () => {
  const f = fixture(),
    held = defer(),
    event = clone(data.events.scheduled),
    pairs = clone(data.requests.approve.recipients);
  f.impl.approve = () => held.promise;
  const result = f.api().approveRecipients(event, pairs);
  await tick();
  assert.equal(f.view().status, "submitting");
  assert.equal(f.view().isCurrent(), true);
  event.revision = 77;
  pairs[0].student_id = uid(800);
  pairs.length = 0;
  const body = f.calls[0].args[1];
  assert.equal(body.expected_event_revision, 3);
  assert.equal(body.recipients.length, 2);
  assert.ok(Object.isFrozen(body.recipients));
  assert.ok(Object.isFrozen(body.recipients[0]));
  held.resolve(data.approval);
  await result;
  assert.equal(f.view().status, "confirmed");
});
test("create/update/revoke detach schedule and original baseline before dispatch", async () => {
  for (const name of ["create", "update", "revoke"]) {
    const f = fixture(),
      held = defer(),
      event = clone(data.events.scheduled),
      child = clone(data.recipients.approved),
      form = fields();
    f.impl[name] = () => held.promise;
    const promise =
      name === "create"
        ? f.api().createEvent(draft.id, form)
        : name === "update"
          ? f.api().updateEvent(event, { kind: "details", name: "Changed" })
          : f.api().revokeRecipient(event, child);
    event.name = "Caller";
    event.revision = 50;
    child.revision = 50;
    form.schedule.starts_at = "broken";
    held.resolve(commands[name].result);
    await promise;
    assert.equal(f.view(commands[name].target).status, "confirmed");
  }
});
for (const place of ["event", "recipient"]) {
  for (const value of [null, undefined, [], { ...data.events.scheduled, id: uid(333) }])
    test(`current ${place} malformed success never proves absence`, async () => {
      const f = fixture();
      f.impl[place] = async () => value;
      await assert.rejects(commands.revoke.call(f.api()));
      assert.equal(f.view().status, "confirmed_needs_refresh");
      assert.equal(f.view().currentEvent, null);
      assert.equal(f.journal().length, 1);
    });
  test(`true current ${place}404 completes unavailable after cleanup`, async () => {
    const f = fixture();
    f.impl[place] = async () => {
      throw new ApiError("private missing", 404);
    };
    await commands.revoke.call(f.api());
    const view = f.view();
    assert.equal(view.status, "unavailable");
    assert.equal(view.isCurrent(), true);
    assert.equal(view.currentEvent?.name ?? null, place === "recipient" ? "Current event" : null);
    assert.equal(view.currentRecipient, null);
    assert.deepEqual(f.journal(), []);
  });
}
for (const command of Object.values(commands))
  test(`reload adopts only ${command.command} metadata`, async () => {
    const entry = marker(command.command),
      f = fixture({ entries: [entry] });
    f.receipt = clone(data.receipts[command.command]);
    if (command.command === "belt_test.approve")
      f.receipt.result.items = [f.receipt.result.items[1]];
    await f.api().checkResult(entry.target);
    assert.equal(f.view(entry.target).status, "confirmed");
    assert.equal(
      f.calls.some((row) => Object.keys(commands).includes(row.name)),
      false,
    );
  });
test("retained approval request rejects mismatched receipt audience", async () => {
  const f = fixture();
  f.impl.approve = async () => {
    throw Error("lost");
  };
  await assert.rejects(commands.approve.call(f.api()));
  f.receipt = clone(data.receipts["belt_test.approve"]);
  f.receipt.result.items = [f.receipt.result.items[1]];
  await assert.rejects(f.api().checkResult(target));
  assert.equal(f.view().status, "unknown");
  assert.equal(
    f.calls.some((row) => row.name === "event"),
    false,
  );
});
for (const change of [
  { operation_id: uid(81) },
  { command: "belt_test.update" },
  { entity_id: uid(82) },
  ...["event_id", "studio_id", "id"].map((field) => ({
    result: { ...data.recipients.revoked, [field]: uid(83) },
  })),
])
  test(`receipt exact identity rejects ${JSON.stringify(change)}`, async () => {
    const f = fixture({ entries: [marker("belt_test.revoke")] });
    f.receipt = { ...data.receipts["belt_test.revoke"], ...change };
    await assert.rejects(f.api().checkResult(target));
    assert.equal(f.view().locked, true);
    assert.equal(f.calls.length, 1);
  });
for (const alias of [false, true])
  test(`receipt404 stays unresolved; durable create alias=${alias} proves commitment`, async () => {
    const f = fixture({
      entries: [marker("belt_test.create", alias ? { event_id: ids.event } : {})],
    });
    f.impl.receipt = async () => {
      throw new ApiError("missing", 404);
    };
    await assert.rejects(f.api().checkResult(draft));
    assert.equal(f.view(draft).status, alias ? "confirmed_needs_refresh" : "unknown");
    assert.equal(f.view(draft).eventId, alias ? ids.event : null);
    assert.equal(f.journal().length, 1);
  });
const malformed = [
  "null",
  "[]",
  "{",
  JSON.stringify({ version: 1, entries: [], "": true }),
  ...[
    [{ ...marker(), "": true }],
    [{ ...marker(), target: { ...target, "": true } }],
    [marker("belt_test.revoke", { recipient_id: undefined })],
    [marker(), marker()],
    [marker(), marker("belt_test.create", { operation_id: uid(9), event_id: ids.event })],
    [marker("belt_test.update", { event_id: ids.event })],
    [marker("belt_test.create", { target })],
    [marker("belt_test.create", { recipient_id: ids.recipient })],
  ].map((entries) => JSON.stringify({ version: 1, entries })),
];
for (const raw of malformed)
  test(`initial malformed journal supplies no trusted metadata: ${raw}`, async () => {
    const f = fixture({ raw });
    assert.equal(f.api().storage.status, "blocked");
    assert.equal(f.api().operations.size, 0);
    assert.equal(f.api().pendingOperation(target), undefined);
    await assert.rejects(commands.update.call(f.api()));
    assert.equal(f.calls.length, 0);
    assert.equal((await f.api().getEvent(ids.event)).status, "ready");
  });
test("journal100 cap spans owners and never expires or evicts", async () => {
  const entries = Array.from({ length: 100 }, (_, n) =>
    marker("belt_test.update", {
      operation_id: uid(1000 + n),
      owner_user_id: uid(2000 + n),
      target: { kind: "event", id: uid(3000 + n) },
    }),
  );
  const f = fixture({ entries });
  await assert.rejects(commands.create.call(f.api()));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.journal(), entries);
  assert.equal(fixture({ entries: [...entries, marker()] }).api().storage.status, "blocked");
});
for (const mode of ["read", "write", "verify"])
  test(`marker ${mode} failure blocks dispatch`, async () => {
    const f = fixture();
    if (mode === "read")
      f.readFault = () => {
        throw Error("denied");
      };
    if (mode === "write")
      f.writeFault = () => {
        throw Error("denied");
      };
    if (mode === "verify") f.writeFault = () => {};
    await assert.rejects(commands.create.call(f.api()));
    assert.equal(f.calls.length, 0);
    assert.equal(f.api().storage.status, "blocked");
  });
for (const phase of ["alias", "cleanup"])
  test(`${phase} durability failure preserves marker and acknowledged fact`, async () => {
    const f = fixture();
    f.writeFault = (name, raw) => {
      const rows = JSON.parse(raw).entries;
      if ((phase === "alias" && rows[0]?.event_id) || (phase === "cleanup" && !rows.length))
        throw Error("denied");
      f.storage.set(name, raw);
    };
    await assert.rejects(commands.create.call(f.api()));
    assert.equal(f.view(draft).status, "storage_blocked");
    assert.equal(f.view(draft).isCurrent(), true);
    assert.equal(f.view(draft).eventId, phase === "alias" ? null : ids.event);
    assert.equal(f.journal().length, 1);
    f.writeFault = null;
    f.receipt = data.receipts["belt_test.create"];
    await f.api().checkResult(draft);
    assert.equal(f.view(draft).status, "confirmed");
    assert.equal(f.calls.filter((row) => row.name === "create").length, 1);
  });
test("cleanup rollback cannot erase another owner's newly written metadata", async () => {
  const f = fixture(),
    other = marker("belt_test.update", { owner_user_id: uid(700), operation_id: uid(701) });
  f.writeFault = (name, raw) => {
    f.storage.set(
      name,
      JSON.parse(raw).entries.length
        ? raw
        : JSON.stringify({
            version: 1,
            entries: [marker("belt_test.create", { event_id: ids.event }), other],
          }),
    );
  };
  await assert.rejects(commands.create.call(f.api()));
  assert.ok(f.journal().some((row) => row.operation_id === other.operation_id));
  assert.equal(f.view(draft).locked, true);
});
test("trusted pending memory survives malformed journal on reattachment", () => {
  const f = fixture({ entries: [marker()] }),
    old = f.api();
  f.storage.set(m.BELT_TEST_JOURNAL_KEY, "malformed");
  f.reset();
  assert.equal(old.storage.isCurrent(), false);
  assert.equal(f.api().storage.status, "blocked");
  assert.equal(f.api().pendingOperation(target).locked, true);
  assert.equal(f.api().operations.size, 1);
});
for (const status of [400, 404, 409, 413, 422])
  test(`definite rejection${status} releases after durable cleanup`, async () => {
    const f = fixture();
    f.impl.update = async () => {
      throw new ApiError("private", status);
    };
    await assert.rejects(commands.update.call(f.api()), (error) => error.status === status);
    assert.equal(f.view().status, "rejected");
    assert.equal(f.view().isCurrent(), true);
    assert.deepEqual(f.journal(), []);
  });
test("known rejection recovery retries cleanup only; reload cannot invent rejection", async () => {
  const f = fixture();
  f.impl.update = async () => {
    throw new ApiError("conflict", 409);
  };
  f.writeFault = (name, raw) => {
    if (!JSON.parse(raw).entries.length) throw Error("blocked");
    f.storage.set(name, raw);
  };
  await assert.rejects(commands.update.call(f.api()));
  const retained = clone(f.journal());
  f.writeFault = null;
  await f.api().checkResult(target);
  assert.equal(f.view().status, "rejected");
  assert.deepEqual(
    f.calls.map((row) => row.name),
    ["update"],
  );
  const reload = fixture({ entries: retained });
  reload.impl.receipt = async () => {
    throw new ApiError("missing", 404);
  };
  await assert.rejects(reload.api().checkResult(target));
  assert.equal(reload.view().status, "unknown");
});
for (const status of [408, 425, 429, 500, 503])
  test(`uncertain mutation${status} retains original marker`, async () => {
    const f = fixture();
    f.impl.update = async () => {
      throw new ApiError("private", status);
    };
    await assert.rejects(commands.update.call(f.api()));
    assert.equal(f.view().status, "unknown");
    assert.equal(f.journal().length, 1);
  });
test("exact/alias precedence over deterministic unidentified-create blocker", async () => {
  const a = marker("belt_test.create", { operation_id: uid(1), event_id: ids.event });
  const b = marker("belt_test.create", {
    operation_id: uid(2),
    target: { kind: "draft", id: uid(101) },
  });
  const c = marker("belt_test.update", {
    operation_id: uid(3),
    target: { kind: "event", id: uid(102) },
  });
  const f = fixture({ entries: [b, c, a] });
  assert.deepEqual(f.api().pendingOperation(target).target, draft);
  assert.deepEqual(f.api().pendingOperation(c.target).target, c.target);
  assert.deepEqual(f.api().pendingOperation({ kind: "event", id: uid(900) }).target, b.target);
  await f.api().checkResult({ kind: "event", id: uid(900) });
  await assert.rejects(commands.update.call(f.api()), /pending/);
  assert.equal(f.calls.length, 0);
});
test("equal UUID in different namespaces is never an implicit alias", async () => {
  const f = fixture({
    entries: [marker("belt_test.create", { target: { kind: "draft", id: ids.event } })],
  });
  await f.api().checkResult(target);
  assert.equal(f.calls.length, 0);
  assert.equal(f.api().pendingOperation(target).target.kind, "draft");
});
test("known create aliasA permits eventB; event read generations are independent", async () => {
  const f = fixture({ entries: [marker("belt_test.create", { event_id: ids.event })] }),
    b = { ...data.events.scheduled, id: uid(502) };
  f.impl.event = async (id) => ({ ...f.eventRow, id });
  f.operation = 1;
  const readA = await f.api().getEvent(ids.event),
    readB = await f.api().getEvent(b.id),
    list = await f.api().listEvents();
  f.impl.update = async () => ({ ...b, name: "Changed", revision: b.revision + 1 });
  await f.api().updateEvent(b, { kind: "details", name: "Changed" });
  assert.equal(readA.isCurrent(), true);
  assert.equal(readB.isCurrent(), false);
  assert.equal(list.isCurrent(), false);
  assert.equal(f.api().pendingOperation(target).locked, true);
});
test("concurrent checks for separate events settle independently", async () => {
  const b = uid(503),
    held = defer(),
    f = fixture({
      entries: [
        marker(),
        marker("belt_test.update", { operation_id: uid(10), target: { kind: "event", id: b } }),
      ],
    });
  f.impl.receipt = async (op) =>
    op === ids.operation ? data.receipts["belt_test.update"] : held.promise;
  f.impl.event = async (id) => ({ ...f.eventRow, id });
  const other = f.api().checkResult({ kind: "event", id: b });
  await f.api().checkResult(target);
  assert.equal(f.view().status, "confirmed");
  held.resolve({
    ...data.receipts["belt_test.update"],
    operation_id: uid(10),
    entity_id: b,
    result: { ...data.events.name_update, id: b },
  });
  await other;
  assert.equal(f.view({ kind: "event", id: b }).status, "confirmed");
});
test("old held check cannot block or remove replacement task; old callbacks are inert", async () => {
  const f = fixture({ entries: [marker()] }),
    held = defer();
  f.impl.receipt = () => held.promise;
  const oldFacade = f.api(),
    oldTask = oldFacade.checkResult(target),
    old = oldTask.catch(() => {});
  await tick();
  assert.equal(oldFacade.checkResult(target), oldTask);
  assert.equal(f.view().isCurrent(), true);
  f.reset();
  assert.equal(f.finishes, 1);
  await assert.rejects(oldFacade.getEvent(ids.event));
  await assert.rejects(commands.update.call(oldFacade));
  const current = defer();
  f.impl.receipt = () => current.promise;
  const recovery = f.api().checkResult(target);
  assert.equal(f.api().checkResult(target), recovery);
  held.resolve(data.receipts["belt_test.update"]);
  await old;
  assert.equal(f.api().checkResult(target), recovery);
  f.impl.event = async () => {
    throw new ApiError("gone", 404);
  };
  current.resolve(data.receipts["belt_test.update"]);
  await recovery;
  assert.equal(f.view().status, "unavailable");
  assert.equal(f.finishes, 2);
});
test("held submission joins only current attachment and never replays after reset", async () => {
  const f = fixture(),
    held = defer();
  f.impl.create = () => held.promise;
  const old = commands.create.call(f.api()).catch(() => {});
  await tick();
  const join = f.api().checkResult(draft);
  const joined = join.catch(() => {});
  assert.equal(f.api().checkResult(draft), join);
  f.reset();
  f.receipt = data.receipts["belt_test.create"];
  await f.api().checkResult(draft);
  held.resolve(data.events.create);
  await old;
  await joined;
  assert.equal(f.calls.filter((row) => row.name === "create").length, 1);
  assert.equal(f.view(draft).status, "confirmed");
});
test("held reads and completed create view lose currentness after replacement or later event mutation", async () => {
  const f = fixture(),
    held = defer();
  f.impl.event = () => held.promise;
  const read = f.api().getEvent(ids.event);
  f.reset();
  held.resolve(f.eventRow);
  assert.equal((await read).status, "stale");
  f.impl.event = async () => f.eventRow;
  const observed = await f.api().getEvent(ids.event);
  await commands.create.call(f.api());
  const view = f.view(draft);
  await commands.update.call(f.api());
  assert.equal(observed.isCurrent(), false);
  assert.equal(view.isCurrent(), false);
});
for (const phase of ["event", "update"])
  for (const status of [401, 402, 403])
    test(`current ${phase}${status} fences access with fixed denial status`, async () => {
      const f = fixture();
      f.impl[phase] = async () => {
        throw new ApiError("private provider", status);
      };
      await assert.rejects(
        commands.update.call(f.api()),
        (error) => error.status === status && /administrator/.test(error.message),
      );
      assert.equal(f.invalidations, 1);
      assert.equal(f.journal().length, 1);
      assert.equal(f.owner.isCurrent(), false);
    });
test("obsolete-token read401 recovers with current token; mutation401 never replays", async () => {
  const f = fixture();
  let attempt = 0;
  f.impl.event = async () => {
    if (!attempt++) {
      f.token++;
      throw new ApiError("old", 401);
    }
    return f.eventRow;
  };
  assert.equal((await f.api().getEvent(ids.event)).status, "ready");
  assert.deepEqual(
    f.calls.map((row) => row.args.at(-1)),
    ["token-1", "token-2"],
  );
  f.impl.update = async () => {
    f.token++;
    throw new ApiError("old mutation", 401);
  };
  await assert.rejects(commands.update.call(f.api()));
  assert.equal(f.invalidations, 0);
  assert.equal(f.view().status, "unknown");
  f.receipt = { ...data.receipts["belt_test.update"], result: data.events.name_update };
  await f.api().checkResult(target);
  assert.equal(f.calls.filter((row) => row.name === "update").length, 1);
});
test("repeated renewal is bounded to three read attempts", async () => {
  const f = fixture();
  f.impl.event = async () => {
    f.token++;
    return f.eventRow;
  };
  await assert.rejects(f.api().getEvent(ids.event));
  assert.equal(f.calls.length, 3);
});
test("raw authority capture preserves strings; canonical keys merge UUID case variants", () => {
  const studio = uid(90),
    event = uid(91),
    owner = USER.toUpperCase();
  const f = fixture({
    scope: { userId: owner, studioId: studio.toUpperCase(), role: "admin" },
    entries: [
      marker("belt_test.update", {
        owner_user_id: owner,
        owner_studio_id: studio.toUpperCase(),
        target: { kind: "event", id: event.toUpperCase() },
      }),
    ],
  });
  assert.equal(f.captured.userId, owner);
  assert.equal(f.captured.studioId, studio.toUpperCase());
  assert.equal(f.api().pendingOperation({ kind: "event", id: event }).target.id, event);
  assert.equal(f.api().operations.size, 1);
});
test("authority and observed studio ABA never revive prior owner", async () => {
  const f = fixture(),
    old = f.api();
  f.invalidateAuthority();
  f.active = true;
  assert.equal(f.owner.isCurrent(), false);
  await assert.rejects(old.getEvent(ids.event));
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.studio = uid(7);
  assert.equal(g.owner.isCurrent(), false);
  g.studio = ids.studio;
  assert.equal(g.owner.isCurrent(), false);
});
test("invalid/nonadmin scopes never reach real authority or journal", () => {
  for (const role of ["front_desk", "instructor", "student", null])
    assert.throws(() => m.createBeltTestOwner({ userId: USER, studioId: ids.studio, role }));
  assert.throws(() => m.createBeltTestOwner({ userId: "", studioId: ids.studio, role: "admin" }));
});
test("invalid/no-op requests do not persist or dispatch", async () => {
  const f = fixture(),
    writes = f.storageWrites;
  await assert.rejects(
    f
      .api()
      .updateEvent(data.events.scheduled, { kind: "details", name: data.events.scheduled.name }),
  );
  await assert.rejects(f.api().approveRecipients(data.events.scheduled, []));
  await assert.rejects(f.api().createEvent(draft.id, { ...fields(), name: "" }));
  assert.equal(f.calls.length, 0);
  assert.equal(f.storageWrites, writes);
});
test("ordinary page/detail/candidate reads validate and detach data, encode opaque Unicode cursor", async () => {
  const f = fixture(),
    page = await f.api().listEvents({ cursor: "opaque/😀", limit: 2 });
  assert.equal(f.calls[0].args[0], "?limit=2&cursor=opaque%2F%F0%9F%98%80");
  assert.ok(Object.isFrozen(page.value.items));
  assert.ok(Object.isFrozen(page.value.items[0]));
  await f.api().listRecipients(ids.event);
  await f.api().getRecipient(ids.event, ids.recipient);
  await f.api().getCandidates(ids.event);
  assert.deepEqual(
    f.calls.map((row) => row.name),
    ["listEvents", "listRecipients", "recipient", "candidates"],
  );
  await f.api().listEvents({ cursor: "😀".repeat(512) });
  await assert.rejects(f.api().listEvents({ cursor: "😀".repeat(513) }));
  for (const limit of [0, 101, 1.5, Infinity]) await assert.rejects(f.api().listEvents({ limit }));
  for (const method of ["listEvents", "listRecipients", "recipient", "candidates"]) {
    f.impl[method] = async () => null;
    await assert.rejects(
      method === "listEvents"
        ? f.api().listEvents()
        : method === "listRecipients"
          ? f.api().listRecipients(ids.event)
          : method === "recipient"
            ? f.api().getRecipient(ids.event, ids.recipient)
            : f.api().getCandidates(ids.event),
    );
  }
});
function sample() {
  const f = {
    active: true,
    ladders: [{ id: "ladder-local", name: "Local ladder", program_id: null }],
    programs: [{ id: "program-local", name: "Local program", archived_at: null }],
    students: [
      {
        id: "student-local",
        status: "active",
        program_id: "program-local",
        program_memberships: [],
      },
    ],
    eligibility: [
      {
        ...data.candidates[0],
        student_id: "student-local",
        student_program_membership_id: null,
        program_id: "program-local",
        current_rank_id: "rank-local",
        next_rank_id: "next-local",
        student_name: "Local student",
        classes_met: true,
        time_met: true,
        needs_approval: true,
        is_eligible: false,
      },
    ],
    calls: [],
  };
  f.owner = preview.createPreviewBeltTestOwner(
    {
      getLadders: () => f.ladders,
      getPrograms: () => f.programs,
      getStudents: () => f.students,
      eligibilityForLadder: (id) => {
        f.calls.push(id);
        return f.eligibility;
      },
    },
    () => f.active,
  );
  f.api = () => f.owner.getSnapshot();
  return f;
}
test("preview lazily retries seed, preserves local IDs/labels and advisory flags", async () => {
  const f = sample(),
    ladders = f.ladders;
  f.ladders = [];
  assert.deepEqual((await f.api().listEvents()).value.items, []);
  f.ladders = ladders;
  const event = (await f.api().listEvents()).value.items[0];
  assert.equal(event.name, "Sample belt test");
  assert.equal(event.ladder_id, "ladder-local");
  const rows = (await f.api().getCandidates(event.id)).value;
  assert.equal(rows[0].student_name, "Local student");
  assert.equal(rows[0].program_id, "program-local");
  assert.equal(rows[0].is_eligible, false);
  assert.deepEqual(f.calls, ["ladder-local"]);
});
test("preview create/edit/approve/reapprove/revoke changes only local event/recipient state", async () => {
  const f = sample(),
    students = clone(f.students);
  await f
    .api()
    .createEvent(draft.id, { ...fields(), ladderId: "ladder-local", status: "scheduled" });
  let event = f.api().operations.get(key(draft)).currentEvent;
  assert.equal((await f.api().listEvents()).value.items.length, 1);
  const pairs = [{ student_id: "student-local", student_program_membership_id: null }];
  await f.api().approveRecipients(event, pairs);
  let child = (await f.api().listRecipients(event.id)).value.items[0];
  assert.equal(child.approved_target_rank_id, "next-local");
  await f.api().approveRecipients(event, pairs);
  assert.equal((await f.api().getRecipient(event.id, child.id)).value.revision, child.revision);
  await f.api().updateEvent(event, { kind: "details", name: "Renamed" });
  event = (await f.api().getEvent(event.id)).value;
  assert.equal(event.schedule_revision, 1);
  assert.equal((await f.api().getRecipient(event.id, child.id)).value.state, "approved");
  await f.api().revokeRecipient(event, child);
  child = (await f.api().getRecipient(event.id, child.id)).value;
  assert.equal(child.state, "revoked");
  assert.equal(child.revision, 2);
  await f.api().approveRecipients(event, pairs);
  child = (await f.api().getRecipient(event.id, child.id)).value;
  assert.equal(child.revision, 3);
  await f.api().updateEvent(event, { kind: "details", location: "Different" });
  event = (await f.api().getEvent(event.id)).value;
  assert.equal(event.schedule_revision, 2);
  assert.equal((await f.api().getRecipient(event.id, child.id)).value.state, "revoked");
  assert.deepEqual(f.students, students);
  await f.api().checkStorage();
  await f.api().checkResult(target);
});
for (const status of ["completed", "canceled"])
  test(`preview ${status} revokes approvals without incrementing schedule revision`, async () => {
    const f = sample(),
      event = (await f.api().listEvents()).value.items[0];
    await f
      .api()
      .approveRecipients(event, [
        { student_id: "student-local", student_program_membership_id: null },
      ]);
    await f.api().updateEvent(event, { kind: "status", status });
    assert.equal((await f.api().listRecipients(event.id)).value.items[0].state, "revoked");
    assert.deepEqual((await f.api().getCandidates(event.id)).value, []);
    assert.equal((await f.api().getEvent(event.id)).value.schedule_revision, 1);
  });
for (const change of ["missing", "archived", "reparented"])
  test(`preview ${change} context blocks edits but permits cancellation`, async () => {
    const f = sample();
    f.ladders[0].program_id = "program-local";
    const event = (await f.api().listEvents()).value.items[0];
    if (change === "missing") f.ladders = [];
    if (change === "archived") f.programs[0].archived_at = "2026-01-01";
    if (change === "reparented") f.ladders[0].program_id = null;
    await assert.rejects(f.api().updateEvent(event, { kind: "details", name: "Renamed" }));
    await f.api().updateEvent(event, { kind: "status", status: "canceled" });
    assert.equal((await f.api().getEvent(event.id)).value.ladder_id, event.ladder_id);
  });
test("preview preserves membership pairs and filters ended/archived/legacy contexts", async () => {
  const f = sample();
  f.students[0].program_memberships = ["a", "b", "ended"].map((id) => ({
    id,
    program_id: "program-local",
    status: id === "ended" ? "ended" : "active",
    ended_at: null,
  }));
  f.eligibility = [null, "a", "b", "ended"].map((id) => ({
    ...f.eligibility[0],
    student_program_membership_id: id,
  }));
  const event = (await f.api().listEvents()).value.items[0];
  const rows = (await f.api().getCandidates(event.id)).value;
  assert.deepEqual(
    rows.map((row) => row.student_program_membership_id),
    ["a", "b"],
  );
  await f.api().approveRecipients(
    event,
    rows.map((row) => ({
      student_id: row.student_id,
      student_program_membership_id: row.student_program_membership_id,
    })),
  );
  assert.equal((await f.api().listRecipients(event.id)).value.items.length, 2);
  f.programs[0].archived_at = "today";
  assert.deepEqual((await f.api().getCandidates(event.id)).value, []);
});
test("preview paging, read lifetimes and recipient CAS reject stale work", async () => {
  const f = sample(),
    observed = await f.api().listEvents(),
    event = observed.value.items[0];
  await f.api().createEvent(draft.id, { ...fields(), ladderId: "ladder-local" });
  assert.equal(observed.isCurrent(), false);
  const page = (await f.api().listEvents({ limit: 1 })).value;
  assert.equal(page.has_more, true);
  assert.equal(
    (await f.api().listEvents({ cursor: page.next_cursor, limit: 1 })).value.items.length,
    1,
  );
  await assert.rejects(f.api().listEvents({ cursor: "forged" }));
  await f
    .api()
    .approveRecipients(event, [
      { student_id: "student-local", student_program_membership_id: null },
    ]);
  const child = (await f.api().listRecipients(event.id)).value.items[0];
  await f.api().revokeRecipient(event, child);
  await assert.rejects(f.api().revokeRecipient(event, child));
  f.active = false;
  await assert.rejects(f.api().listEvents());
  assert.equal(f.api().storage.isCurrent(), false);
});

test("immediate submit/check selectors expose current locked operation before I/O", async () => {
  const f = fixture(),
    held = defer();
  f.impl.update = () => held.promise;
  const task = commands.update.call(f.api());
  assert.equal(f.api().pendingOperation(target).status, "submitting");
  assert.equal(f.api().pendingOperation(target).isCurrent(), true);
  assert.equal(f.api().pendingOperation(target).locked, true);
  held.resolve(data.events.name_update);
  await task;
  const g = fixture({ entries: [marker()] });
  g.receipt = data.receipts["belt_test.update"];
  const check = g.api().checkResult(target);
  assert.equal(g.api().pendingOperation(target).status, "checking");
  assert.equal(g.api().pendingOperation(target).isCurrent(), true);
  await check;
});

for (const [phase, at] of [
  ["alias read", 4],
  ["alias verification", 5],
  ["cleanup read", 6],
  ["cleanup verification", 7],
])
  test(`${phase} failure retains durable recovery until explicit check`, async () => {
    const f = fixture();
    f.readFault = (name) => {
      if (f.storageReads === at) throw Error("private read failure");
      return f.storage.get(name) ?? null;
    };
    await assert.rejects(commands.create.call(f.api()));
    assert.equal(f.view(draft).status, "storage_blocked");
    assert.equal(f.view(draft).locked, true);
    assert.equal(f.view(draft).isCurrent(), true);
    assert.equal(f.journal().length, 1);
    f.readFault = null;
    f.receipt = data.receipts["belt_test.create"];
    await f.api().checkResult(draft);
    assert.equal(f.view(draft).status, "confirmed");
    assert.equal(f.calls.filter((row) => row.name === "create").length, 1);
  });
test("validated create alias conflict retains prior event reservation and unidentified-create fence", async () => {
  const f = fixture({ entries: [marker("belt_test.update", { operation_id: uid(880) })] });
  await assert.rejects(commands.create.call(f.api()));
  assert.equal(f.view(draft).status, "storage_blocked");
  assert.equal(f.view(draft).eventId, null);
  assert.deepEqual(f.api().pendingOperation(target).target, target);
  assert.deepEqual(f.api().pendingOperation({ kind: "event", id: uid(881) }).target, draft);
  assert.equal(f.journal().length, 2);
  assert.equal(f.journal().find((row) => row.command === "belt_test.create").event_id, undefined);
  assert.equal(f.calls.filter((row) => row.name === "event").length, 0);
});
test("durable create alias mismatch cannot retarget the original draft", async () => {
  const f = fixture({ entries: [marker("belt_test.create", { event_id: ids.event })] });
  f.receipt = {
    ...data.receipts["belt_test.create"],
    entity_id: uid(991),
    result: { ...data.events.create, id: uid(991) },
  };
  await assert.rejects(f.api().checkResult(draft));
  assert.equal(f.view(draft).status, "confirmed_needs_refresh");
  assert.equal(f.view(draft).eventId, ids.event);
  assert.equal(f.journal()[0].event_id, ids.event);
});
test("ordinary held event read cannot overwrite a newer confirmed observation", async () => {
  const f = fixture(),
    held = defer();
  let reads = 0;
  f.impl.event = () => (reads++ === 0 ? held.promise : Promise.resolve(f.eventRow));
  const ordinary = f.api().getEvent(ids.event);
  await commands.update.call(f.api());
  held.resolve(data.events.scheduled);
  assert.equal((await ordinary).status, "stale");
  assert.equal(f.view().currentEvent.name, "Current event");
  assert.equal(f.view().isCurrent(), true);
});
for (const field of ["id", "event_id", "studio_id"])
  test(`canonical current recipient with wrong ${field} stays unresolved`, async () => {
    const f = fixture();
    f.impl.recipient = async () => ({ ...data.recipients.revoked, [field]: uid(888) });
    await assert.rejects(commands.revoke.call(f.api()));
    assert.equal(f.view().status, "confirmed_needs_refresh");
    assert.equal(f.view().currentEvent, null);
    assert.equal(f.journal().length, 1);
  });
test("validated storage retry re-adopts metadata and preserves unrelated owner entries", async () => {
  const other = marker("belt_test.update", { owner_user_id: uid(1001), operation_id: uid(1002) });
  const f = fixture({ raw: "malformed" });
  f.storage.set(
    m.BELT_TEST_JOURNAL_KEY,
    JSON.stringify({ version: 1, entries: [other, marker()] }),
  );
  await f.api().checkStorage();
  assert.equal(f.api().storage.status, "ready");
  assert.equal(f.api().operations.size, 1);
  f.receipt = data.receipts["belt_test.update"];
  await f.api().checkResult(target);
  assert.deepEqual(f.journal(), [other]);
});
test("mutating a published map cannot alter private pending reservations", () => {
  const f = fixture({ entries: [marker()] }),
    snapshot = f.api();
  snapshot.operations.clear();
  assert.equal(f.api().pendingOperation(target).locked, true);
});
test("preview rejects unmet class/time selections and preserves each current membership", async () => {
  const f = sample(),
    event = (await f.api().listEvents()).value.items[0];
  for (const flag of ["classes_met", "time_met"]) {
    f.eligibility[0][flag] = false;
    assert.equal((await f.api().getCandidates(event.id)).value.length, 1);
    await assert.rejects(
      f
        .api()
        .approveRecipients(event, [
          { student_id: "student-local", student_program_membership_id: null },
        ]),
    );
    f.eligibility[0][flag] = true;
  }
  assert.deepEqual((await f.api().listRecipients(event.id)).value.items, []);
});

for (const membershipState of ["absent", "null"])
  test(`preview legacy ${membershipState} membership array keeps explicit null approval context`, async () => {
    const f = sample();
    if (membershipState === "absent") delete f.students[0].program_memberships;
    else f.students[0].program_memberships = null;
    const originalStudents = clone(f.students);
    const event = (await f.api().listEvents()).value.items[0];
    const candidates = (await f.api().getCandidates(event.id)).value;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].student_id, "student-local");
    assert.equal(candidates[0].program_id, "program-local");
    assert.equal(candidates[0].student_program_membership_id, null);
    await f
      .api()
      .approveRecipients(event, [
        { student_id: "student-local", student_program_membership_id: null },
      ]);
    const recipient = (await f.api().listRecipients(event.id)).value.items[0];
    assert.equal(recipient.student_program_membership_id, null);
    assert.equal(recipient.state, "approved");
    assert.deepEqual(f.students, originalStudents);
  });
test("preview legacy fallback never treats a malformed nonarray as absent memberships", async () => {
  for (const memberships of [{}, false, ""]) {
    const f = sample();
    f.students[0].program_memberships = memberships;
    const event = (await f.api().listEvents()).value.items[0];
    await assert.rejects(f.api().getCandidates(event.id));
    assert.deepEqual((await f.api().listRecipients(event.id)).value.items, []);
  }
});
