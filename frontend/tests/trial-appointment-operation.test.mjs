import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
const { add, modules } = createCommonJsPacker({
  "@/lib/api": `exports.ApiError=class ApiError extends Error{constructor(message,status){super(message);this.status=status;}};`,
  "@/lib/access-identity": `exports.captureAccessIdentity=()=>{throw Error('Unexpected real auth')};exports.invalidateAccessIdentity=()=>{};`,
  "@/lib/studio-state-cookie": `exports.getActiveStudioIdCookie=()=>null;`,
});
const id = add("@/lib/trial-appointment-operation"),
  apiId = add("@/lib/api");
const [m, { ApiError }] = new Function(
  `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}return [require(${id}),require(${apiId})];`,
)();
const USER = "10000000-0000-4000-8000-000000000001",
  STUDIO = "20000000-0000-4000-8000-000000000001",
  LEAD = "30000000-0000-4000-8000-000000000001",
  APPT = "40000000-0000-4000-8000-000000000001",
  PROGRAM = "50000000-0000-4000-8000-000000000001",
  OP = "60000000-0000-4000-8000-000000000001";
const row = (changes = {}) => ({
  id: APPT,
  studio_id: STUDIO,
  lead_id: LEAD,
  program_id: PROGRAM,
  starts_at: "2026-10-05T09:00:00.123456Z",
  ends_at: "2026-10-05T10:00:00.123457Z",
  timezone: "Server/NewAlias",
  location: "Private location",
  status: "scheduled",
  revision: 1,
  created_by: USER,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...changes,
});
const leadRow = (changes = {}) => ({
  id: LEAD,
  studio_id: STUDIO,
  first_name: "Private",
  last_name: "Lead",
  source: "website",
  stage: "trial_scheduled",
  is_minor: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...changes,
});
const marker = (changes = {}) => ({
  command: "trial.create",
  operation_id: OP,
  owner_user_id: USER,
  owner_studio_id: STUDIO,
  lead_id: LEAD,
  ...changes,
});
const fields = (changes = {}) => ({
  schedule: { starts_at: "2026-10-05T09:00:00Z", ends_at: "2026-10-05T10:00:00Z", timezone: "UTC" },
  location: " Private ",
  program: { mode: "inherit" },
  ...changes,
});
const receipt = (changes = {}) => ({
  operation_id: OP,
  command: "trial.create",
  state: "committed",
  entity_type: "trial_appointment",
  entity_id: APPT,
  committed_at: "2026-10-01T00:00:00Z",
  result: row(),
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
function fixture({ entries, raw, role = "admin", storage = new Map() } = {}) {
  if (entries) storage.set(m.TRIAL_JOURNAL_KEY, JSON.stringify({ version: 1, entries }));
  if (raw !== undefined) storage.set(m.TRIAL_JOURNAL_KEY, raw);
  const f = {
    storage,
    reads: [],
    writes: [],
    publications: [],
    handles: new Map(),
    authority: true,
    resource: 1,
    token: "token-1",
    studio: STUDIO,
    publication: 0,
    counter: 1,
    mutationCount: 0,
    storageReads: 0,
    storageWrites: 0,
  };
  f.create = async () => row();
  f.update = async () => row({ revision: 2 });
  f.detail = async () => row();
  f.lead = async () => leadRow();
  f.receipt = async () => receipt();
  f.list = async () => ({ items: [row()], next_cursor: null, has_more: false });
  const deps = {
    capture: (_, onInvalidated) => {
      f.invalidate = () => {
        f.authority = false;
        onInvalidated();
      };
      return { isCurrent: () => f.authority, dispose() {}, signal: new AbortController().signal };
    },
    invalidate: () => f.invalidate(),
    activeStudio: () => f.studio,
    uuid: () => `60000000-0000-4000-8000-${String(f.counter++).padStart(12, "0")}`,
    storage: () => ({
      getItem: (key) => {
        f.storageReads++;
        if (f.readFailure) throw Error("Storage read error");
        const result = storage.get(key) ?? null;
        f.afterRead?.();
        return result;
      },
      setItem: (key, value) => {
        f.storageWrites++;
        if (f.writeFailure) throw Error("Storage write error");
        if (!f.ignoreWrite) storage.set(key, value);
        f.afterWrite?.();
      },
    }),
  };
  f.binding = () => {
    const resource = f.resource;
    return {
      isCurrent: () => resource === f.resource,
      beginRequest: () => {
        const token = f.token;
        return {
          token,
          isCurrent: () => f.authority && token === f.token,
          isSameIdentity: () => f.authority,
          canRetryAfterTokenChange: () => f.authority && token !== f.token,
        };
      },
      beginMutation: () => {
        f.mutationCount++;
        return () => f.mutationCount--;
      },
      reserve: (lead) => {
        if (f.handles.has(lead)) return null;
        const handle = { leadId: lead, followUp: null, previousRecovery: null };
        f.handles.set(lead, handle);
        return handle;
      },
      current: (lead) => f.handles.get(lead) ?? null,
      release: (handle) => {
        if (f.handles.get(handle.leadId) !== handle) return false;
        f.handles.delete(handle.leadId);
        return true;
      },
      list: async (lead, query, token) => {
        f.reads.push({ kind: "list", lead, query, token });
        return f.list();
      },
      detail: async (lead, id, token) => {
        f.reads.push({ kind: "detail", lead, id, token });
        return f.detail();
      },
      create: async (lead, body, token) => {
        f.writes.push({ kind: "create", lead, body, token });
        return f.create(body);
      },
      update: async (lead, id, body, token) => {
        f.writes.push({ kind: "update", lead, id, body, token });
        return f.update(body);
      },
      receipt: async (id, token) => {
        f.reads.push({ kind: "receipt", id, token });
        return f.receipt(id);
      },
      currentLead: async (id, token) => {
        f.reads.push({ kind: "lead", id, token });
        return f.lead();
      },
      capturePublication: () => {
        const publication = f.publication;
        return () => f.publication === publication;
      },
      publish: (id, value, isCurrent) => {
        f.publications.push({ id, value, isCurrent });
      },
    };
  };
  f.owner = m.createTrialAppointmentOwner({ userId: USER, studioId: STUDIO, role }, deps);
  f.detach = f.owner.bind(f.binding());
  f.api = () => f.owner.getSnapshot();
  f.view = (id = LEAD) => f.api().trialOperations.get(id);
  return f;
}
test("complete generated trial DTO accepts server-shaped locally unavailable zone and exact fractions", () => {
  assert.equal(m.isTrialAppointment(row(), STUDIO, LEAD), true);
  for (const key of Object.keys(row())) {
    const missing = row();
    delete missing[key];
    assert.equal(m.isTrialAppointment(missing, STUDIO, LEAD), false, key);
  }
  for (const change of [
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 1.5 },
    { status: {} },
    { program_id: undefined },
    { created_by: undefined },
    { starts_at: "2026-02-30T09:00:00Z" },
    { timezone: "right/UTC" },
    { timezone: "../UTC" },
  ])
    assert.equal(m.isTrialAppointment(row(change), STUDIO, LEAD), false);
});
test("typed receipt verifies operation, command, all parent identities and confirmed alias", () => {
  assert.equal(m.isTrialReceipt(receipt(), marker()), true);
  for (const change of [
    { command: "workflow.create" },
    { operation_id: PROGRAM },
    { entity_id: PROGRAM },
    { result: row({ lead_id: PROGRAM }) },
    { result: row({ studio_id: PROGRAM }) },
  ])
    assert.equal(m.isTrialReceipt(receipt(change), marker()), false);
  assert.equal(m.isTrialReceipt(receipt(), marker({ appointment_id: PROGRAM })), false);
});
test("fresh canonical create bodies preserve location and program omission/null/UUID", () => {
  assert.deepEqual(m.buildTrialCreate(OP, fields()), {
    operation_id: OP,
    starts_at: "2026-10-05T09:00:00Z",
    ends_at: "2026-10-05T10:00:00Z",
    timezone: "UTC",
    location: " Private ",
  });
  assert.equal(m.buildTrialCreate(OP, fields({ program: { mode: "none" } })).program_id, null);
  assert.equal(
    m.buildTrialCreate(OP, fields({ program: { mode: "program", id: PROGRAM } })).program_id,
    PROGRAM,
  );
  assert.doesNotThrow(() => m.buildTrialCreate(OP, fields({ location: "😀".repeat(240) })));
  assert.throws(() => m.buildTrialCreate(OP, fields({ location: "😀".repeat(241) })));
});
test("update only includes changed fields, exact revision and explicit outcomes", () => {
  assert.deepEqual(m.buildTrialUpdate(OP, row(), { kind: "schedule", location: "New" }), {
    operation_id: OP,
    expected_revision: 1,
    location: "New",
  });
  assert.deepEqual(m.buildTrialUpdate(OP, row(), { kind: "outcome", status: "canceled" }), {
    operation_id: OP,
    expected_revision: 1,
    status: "canceled",
  });
  assert.throws(
    () =>
      m.buildTrialUpdate(OP, row(), {
        kind: "schedule",
        schedule: row(),
        location: row().location,
        program: { mode: "program", id: PROGRAM },
      }),
    /Choose/,
  );
  assert.throws(() =>
    m.buildTrialUpdate(OP, row({ status: "completed" }), { kind: "outcome", status: "canceled" }),
  );
});
test("direct create observes exact current appointment and lead before cleanup", async () => {
  const f = fixture();
  await f.api().createTrialAppointment(LEAD, fields());
  assert.deepEqual(
    f.reads.map((x) => x.kind),
    ["detail", "lead"],
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.view().status, "confirmed");
  assert.equal(f.view().locked, false);
  assert.equal(f.view().ownsLeadReservation, false);
  assert.equal(f.view().currentAppointment.starts_at, row().starts_at);
  assert.ok(Object.isFrozen(f.view().currentAppointment));
  assert.ok(Object.isFrozen(f.view()));
  assert.deepEqual(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries, []);
  assert.equal(f.handles.size, 0);
  assert.equal(f.mutationCount, 0);
});
test("unknown result uses matching receipt, exact appointment and exact lead without replay", async () => {
  const f = fixture();
  f.create = async () => {
    throw Error("lost");
  };
  await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
  assert.equal(f.view().status, "unknown");
  assert.equal(f.view().ownsLeadReservation, true);
  assert.equal(f.mutationCount, 0);
  const stored = f.storage.get(m.TRIAL_JOURNAL_KEY);
  assert.ok(!stored.includes("Private"));
  assert.ok(!stored.includes("starts_at"));
  await f.api().checkTrialAppointmentResult(LEAD);
  assert.deepEqual(
    f.reads.map((x) => x.kind),
    ["receipt", "detail", "lead"],
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.view().status, "confirmed");
});
test("missing receipt remains locked and never reads current rows", async () => {
  const f = fixture({ entries: [marker()] });
  f.receipt = async () => {
    throw new ApiError("raw", 404);
  };
  await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
  assert.equal(f.view().status, "unknown");
  assert.equal(f.view().locked, true);
  assert.equal(f.reads.length, 1);
});
for (const [appointmentMissing, leadMissing] of [
  [true, false],
  [false, true],
  [true, true],
])
  test(`confirmed missing current rows ${appointmentMissing}/${leadMissing}`, async () => {
    const f = fixture({ entries: [marker()] });
    if (appointmentMissing)
      f.detail = async () => {
        throw new ApiError("missing", 404);
      };
    if (leadMissing)
      f.lead = async () => {
        throw new ApiError("missing", 404);
      };
    await f.api().checkTrialAppointmentResult(LEAD);
    assert.equal(f.view().status, "unavailable");
    assert.equal(f.view().message, m.TRIAL_UNAVAILABLE);
    assert.equal(f.view().currentAppointment, null);
    assert.equal(f.view().locked, false);
    assert.equal(f.publications[0].value === null, leadMissing);
    assert.deepEqual(
      f.reads.map((x) => x.kind),
      ["receipt", "detail", "lead"],
    );
  });
test("malformed initial journal is blocked, empty and unreserved, but reads work", async () => {
  const f = fixture({ raw: "{broken" });
  assert.equal(f.api().trialStorage.status, "blocked");
  assert.equal(f.api().trialOperations.size, 0);
  assert.equal(f.handles.size, 0);
  assert.equal((await f.api().listTrialAppointments(LEAD)).status, "ready");
  await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
  assert.equal(f.writes.length, 0);
  assert.equal(f.storage.get(m.TRIAL_JOURNAL_KEY), "{broken");
});
test("conflicting reservation does not steal handle, read receipt or claim ownership", async () => {
  const f = fixture();
  const other = { leadId: LEAD };
  f.handles.set(LEAD, other);
  f.storage.set(m.TRIAL_JOURNAL_KEY, JSON.stringify({ version: 1, entries: [marker()] }));
  await f.api().checkTrialAppointmentStorage();
  assert.equal(f.view().ownsLeadReservation, false);
  assert.equal(f.handles.get(LEAD), other);
  await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
  assert.equal(f.reads.length, 0);
  f.handles.delete(LEAD);
  await f.api().checkTrialAppointmentResult(LEAD);
  assert.equal(f.view().status, "confirmed");
});
test("detachment fences snapshots and releases only exact old handles", async () => {
  const f = fixture({ entries: [marker()] });
  const old = f.view();
  const replacement = { leadId: LEAD };
  f.handles.set(LEAD, replacement);
  f.detach();
  assert.equal(old.isCurrent(), false);
  assert.equal(f.api().trialOperations.size, 0);
  assert.equal(f.handles.get(LEAD), replacement);
  f.owner.bind(f.binding());
  assert.equal(f.view().ownsLeadReservation, false);
  f.detach();
  assert.equal(f.handles.get(LEAD), replacement);
});
test("double submit is one POST and check coalesces per lead", async () => {
  const f = fixture();
  const held = defer();
  f.create = () => held.promise;
  const first = f.api().createTrialAppointment(LEAD, fields());
  await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
  await Promise.resolve();
  assert.equal(f.writes.length, 1);
  const check = f.api().checkTrialAppointmentResult(LEAD);
  held.resolve(row());
  await Promise.all([first, check]);
  assert.equal(f.writes.length, 1);
});
test("resource replacement returns stale standalone reads and fences completed snapshots", async () => {
  const f = fixture();
  const ready = await f.api().getTrialAppointment(LEAD, APPT),
    held = defer();
  f.detail = () => held.promise;
  const read = f.api().getTrialAppointment(LEAD, APPT);
  f.resource++;
  held.resolve(row());
  assert.deepEqual(await read, { status: "stale" });
  assert.equal(ready.isCurrent(), false);
});
test("list cursor is encoded, page bounded and wire duplicate identities rejected", async () => {
  const f = fixture();
  await f.api().listTrialAppointments(LEAD, { cursor: "opaque&/=?", limit: 2 });
  assert.equal(f.reads[0].query, "?limit=2&cursor=opaque%26%2F%3D%3F");
  for (const options of [{ cursor: "" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }])
    await assert.rejects(f.api().listTrialAppointments(LEAD, options));
  f.list = async () => ({ items: [row(), row()], next_cursor: null, has_more: false });
  await assert.rejects(f.api().listTrialAppointments(LEAD), (error) => error.status === 503);
});
test("unknown zone can be listed, recovered and canceled with no schedule conversion", async () => {
  const f = fixture({ entries: [marker()] });
  assert.equal(
    (await f.api().listTrialAppointments(LEAD)).value.items[0].timezone,
    "Server/NewAlias",
  );
  await f.api().checkTrialAppointmentResult(LEAD);
  f.update = async () => row({ revision: 2, status: "canceled" });
  f.detail = f.update;
  await f.api().updateTrialAppointment(row(), { kind: "outcome", status: "canceled" });
  assert.deepEqual(Object.keys(f.writes[0].body).sort(), [
    "expected_revision",
    "operation_id",
    "status",
  ]);
});

for (const status of [401, 402, 403])
  test(`current read denial ${status} rejects safely and fences access`, async () => {
    const f = fixture();
    f.detail = async () => {
      throw new ApiError("Private provider data", status);
    };
    await assert.rejects(
      f.api().getTrialAppointment(LEAD, APPT),
      (error) => error.status === status && !error.message.includes("Private"),
    );
    assert.equal(f.owner.isCurrent(), false);
  });
test("old token denial retries read with renewed token and does not invalidate", async () => {
  const f = fixture();
  f.detail = async () => {
    if (f.token === "token-1") {
      f.token = "token-2";
      throw new ApiError("old denial", 401);
    }
    return row();
  };
  assert.equal((await f.api().getTrialAppointment(LEAD, APPT)).status, "ready");
  assert.equal(f.owner.isCurrent(), true);
  assert.deepEqual(
    f.reads.map((x) => x.token),
    ["token-1", "token-2"],
  );
});
test("detached provider late denial cannot fence replacement attachment", async () => {
  const f = fixture();
  const held = defer();
  f.detail = () => held.promise;
  const result = f.api().getTrialAppointment(LEAD, APPT);
  f.detach();
  f.owner.bind(f.binding());
  held.reject(new ApiError("late denial", 403));
  assert.deepEqual(await result, { status: "stale" });
  assert.equal(f.owner.isCurrent(), true);
});
test("malformed commands are never coerced or partially adopted", () => {
  for (const command of [["trial.create"], {}, null, 3]) {
    const f = fixture({
      entries: [marker(), marker({ operation_id: PROGRAM, lead_id: PROGRAM, command })],
    });
    assert.equal(f.api().trialStorage.status, "blocked");
    assert.equal(f.api().trialOperations.size, 0);
    assert.equal(f.handles.size, 0);
  }
});
test("cleanup readback failure restores prior durable marker when writes still work", async () => {
  const f = fixture({ entries: [marker()] });
  f.afterWrite = () => {
    if (JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries.length === 0) f.readFailure = true;
  };
  await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
  assert.equal(f.view().locked, true);
  assert.equal(f.view().status, "storage_blocked");
  assert.equal(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries[0].appointment_id, APPT);
});
test("validated alias remains binding after alias persistence failure", async () => {
  const f = fixture();
  f.afterWrite = () => {
    if (JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries[0]?.appointment_id)
      f.readFailure = true;
  };
  await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
  assert.equal(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries[0].appointment_id, undefined);
  f.readFailure = false;
  f.afterWrite = undefined;
  f.receipt = async () => receipt({ entity_id: PROGRAM, result: row({ id: PROGRAM }) });
  await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
  assert.equal(f.reads.filter((x) => x.kind === "detail").length, 0);
  assert.equal(f.view().locked, true);
});
test("newer lead publication blocks cleanup and older current observation", async () => {
  const f = fixture({ entries: [marker()] });
  f.lead = async () => {
    f.publication++;
    return leadRow();
  };
  await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
  assert.equal(f.view().status, "confirmed_needs_refresh");
  assert.equal(f.publications.length, 0);
  assert.equal(f.view().locked, true);
});
test("new command invalidates old currentAppointment snapshot and deferred lead publication", async () => {
  const f = fixture();
  await f.api().createTrialAppointment(LEAD, fields());
  const previous = f.view(),
    publication = f.publications[0];
  const held = defer();
  f.update = () => held.promise;
  const update = f.api().updateTrialAppointment(row(), { kind: "outcome", status: "canceled" });
  assert.equal(f.view().currentAppointment, null);
  assert.equal(previous.isCurrent(), false);
  assert.equal(publication.isCurrent(), false);
  held.resolve(row({ revision: 2, status: "canceled" }));
  await update;
});
test("terminal unavailable retains the confirmed appointment identity", async () => {
  const f = fixture({ entries: [marker()] });
  f.detail = async () => {
    throw new ApiError("missing", 404);
  };
  await f.api().checkTrialAppointmentResult(LEAD);
  assert.equal(f.view().appointmentId, APPT);
});
for (const status of [400, 404, 409, 413, 422])
  test(`definite mutation rejection ${status} cleans durable state and releases exact handle`, async () => {
    const f = fixture();
    f.create = async () => {
      throw new ApiError("private", status);
    };
    await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
    assert.equal(f.view().status, "rejected");
    assert.equal(f.view().command, "trial.create");
    assert.equal(f.view().locked, false);
    assert.equal(f.handles.size, 0);
    assert.equal(f.reads.length, 0);
  });
test("cap pressure preserves other owners and allows existing marker recovery", async () => {
  const entries = Array.from({ length: 99 }, (_, i) =>
    marker({
      operation_id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      owner_user_id: PROGRAM,
      lead_id: `80000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    }),
  );
  const f = fixture({ entries: [...entries, marker()] });
  await assert.rejects(f.api().createTrialAppointment(PROGRAM, fields()));
  assert.equal(f.writes.length, 0);
  await f.api().checkTrialAppointmentResult(LEAD);
  assert.deepEqual(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries, entries);
});
test("storage recheck performs adoption only and no receipt reads", async () => {
  const f = fixture({ raw: "bad" });
  f.storage.set(m.TRIAL_JOURNAL_KEY, JSON.stringify({ version: 1, entries: [marker()] }));
  await f.api().checkTrialAppointmentStorage();
  assert.equal(f.api().trialStorage.status, "ready");
  assert.equal(f.view().locked, true);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});
test("preview keeps sample changes in memory with zero live journal or API I/O", async () => {
  globalThis.crypto ??= (await import("node:crypto")).webcrypto;
  const preview = m.createPreviewTrialOwner(
    () => [{ id: "lead-1" }],
    () => true,
  );
  const rows = await preview.getSnapshot().listTrialAppointments("lead-1");
  assert.equal(rows.value.items.length, 1);
  await preview
    .getSnapshot()
    .updateTrialAppointment(rows.value.items[0], { kind: "outcome", status: "canceled" });
  await preview.getSnapshot().createTrialAppointment("lead-1", fields());
  assert.equal((await preview.getSnapshot().listTrialAppointments("lead-1")).value.items.length, 2);
  assert.equal(preview.getSnapshot().trialStorage.status, "inactive");
});

for (const denied of ["admin-other", "front_desk", "instructor"])
  test(`unauthorized owner ${denied} cannot touch trial journal`, () => {
    let reads = 0;
    assert.throws(() =>
      m.createTrialAppointmentOwner(
        { userId: USER, studioId: STUDIO, role: denied },
        {
          capture() {
            throw Error("not allowed");
          },
          storage() {
            reads++;
            throw Error();
          },
        },
      ),
    );
    assert.equal(reads, 0);
  });
test("authority ABA never revives an old result or unlocks another handle", async () => {
  const f = fixture({ entries: [marker()] }),
    held = defer();
  f.receipt = () => held.promise;
  const check = f.api().checkTrialAppointmentResult(LEAD);
  await Promise.resolve();
  f.invalidate();
  f.authority = true;
  const replacement = { leadId: LEAD };
  f.handles.set(LEAD, replacement);
  held.resolve(receipt());
  await assert.rejects(check);
  assert.equal(f.owner.isCurrent(), false);
  assert.equal(f.handles.get(LEAD), replacement);
  assert.equal(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries.length, 1);
  assert.equal(f.publications.length, 0);
});
test("independent leads can dispatch while first command remains unknown", async () => {
  const f = fixture();
  f.create = async () => {
    throw Error("lost");
  };
  await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
  await assert.rejects(f.api().createTrialAppointment(PROGRAM, fields()));
  assert.equal(f.writes.length, 2);
  assert.equal(f.api().trialOperations.size, 2);
  assert.equal(f.handles.size, 2);
});
for (const change of [{ revision: 2 }, { status: "canceled" }, { id: "bad" }, { lead_id: PROGRAM }])
  test(`malformed direct create confirmation ${JSON.stringify(change)} stays unknown`, async () => {
    const f = fixture();
    f.create = async () => row(change);
    await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
    assert.equal(f.view().status, "unknown");
    assert.equal(f.view().locked, true);
    assert.equal(f.reads.length, 0);
  });
test("direct update requires exact safe next revision and performs no mutation retry", async () => {
  const f = fixture();
  f.update = async () => row({ revision: 3 });
  await assert.rejects(
    f.api().updateTrialAppointment(row(), { kind: "outcome", status: "canceled" }),
  );
  assert.equal(f.view().status, "unknown");
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.length, 0);
});
test("standalone current404 never cleans an unrelated pending marker", async () => {
  const f = fixture({ entries: [marker()] });
  f.detail = async () => {
    throw new ApiError("missing", 404);
  };
  await assert.rejects(f.api().getTrialAppointment(LEAD, APPT), (error) => error.status === 404);
  assert.equal(f.view().locked, true);
  assert.equal(JSON.parse(f.storage.get(m.TRIAL_JOURNAL_KEY)).entries.length, 1);
});
test("no-op update is unreserved rejected with null command and zero persistence or dispatch", async () => {
  const f = fixture(),
    initialWrites = f.storageWrites;
  await assert.rejects(
    f.api().updateTrialAppointment(row(), { kind: "schedule", location: row().location }),
  );
  assert.equal(f.view().command, null);
  assert.equal(f.view().appointmentId, null);
  assert.equal(f.view().locked, false);
  assert.equal(f.storageWrites, initialWrites);
  assert.equal(f.writes.length, 0);
});
for (const malformed of [
  { version: 2, entries: [marker()] },
  { version: 1, entries: [marker({ private: "name" })] },
  { version: 1, entries: [marker(), marker()] },
  { version: 1, entries: [marker({ command: "trial.update" })] },
  { version: 1, entries: [marker({ operation_id: "bad" })] },
  { version: 1, entries: [marker(), marker({ operation_id: PROGRAM })] },
  { version: 1, entries: [marker()], extra: true },
])
  test(`whole journal validation rejects ${JSON.stringify(malformed).slice(0, 90)}`, () => {
    const raw = JSON.stringify(malformed),
      f = fixture({ raw });
    assert.equal(f.api().trialStorage.status, "blocked");
    assert.equal(f.api().trialOperations.size, 0);
    assert.equal(f.handles.size, 0);
    assert.equal(f.storage.get(m.TRIAL_JOURNAL_KEY), raw);
  });
for (const fault of ["writeFailure", "ignoreWrite"])
  test(`required marker ${fault} prevents dispatch`, async () => {
    const f = fixture();
    f[fault] = true;
    await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
    assert.equal(f.writes.length, 0);
    assert.equal(f.api().trialStorage.status, "blocked");
  });
test("saved slot body preserves fractional schedule on program-only change", () => {
  assert.deepEqual(m.buildTrialUpdate(OP, row(), { kind: "schedule", program: { mode: "none" } }), {
    operation_id: OP,
    expected_revision: 1,
    program_id: null,
  });
});
test("copied operation snapshots cannot mutate owner state", async () => {
  const f = fixture({ entries: [marker()] }),
    snapshot = f.api();
  snapshot.trialOperations.clear();
  await f.api().checkTrialAppointmentStorage();
  assert.equal(f.api().trialOperations.size, 1);
  assert.ok(Object.isFrozen(f.api()));
  assert.ok(Object.isFrozen(f.api().trialStorage));
});
for (const fault of ["malformed", "unreadable"])
  test(`trusted unknown command retains reservation on ${fault} journal rebind`, async () => {
    const f = fixture();
    f.create = async () => {
      throw Error("unknown");
    };
    await assert.rejects(f.api().createTrialAppointment(LEAD, fields()));
    f.detach();
    if (fault === "malformed") f.storage.set(m.TRIAL_JOURNAL_KEY, "bad");
    else f.readFailure = true;
    f.owner.bind(f.binding());
    assert.equal(f.api().trialStorage.status, "blocked");
    assert.equal(f.view().locked, true);
    assert.equal(f.view().ownsLeadReservation, true);
    assert.equal(f.binding().reserve(LEAD), null);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 1);
    if (fault === "malformed") assert.equal(f.storage.get(m.TRIAL_JOURNAL_KEY), "bad");
  });
test("initial unreadable journal still has no trusted rows or reservations", () => {
  const storage = new Map();
  storage.get = () => {
    throw Error("unreadable");
  };
  const f = fixture({ storage });
  assert.equal(f.api().trialStorage.status, "blocked");
  assert.equal(f.api().trialOperations.size, 0);
  assert.equal(f.handles.size, 0);
});
for (const command of ["trial.create", "trial.update"])
  test(`adopted ${command} appointment ID has the correct confirmation meaning after receipt404`, async () => {
    const f = fixture({ entries: [marker({ command, appointment_id: APPT })] });
    const expected = command === "trial.create" ? "confirmed_needs_refresh" : "unknown";
    assert.equal(f.view().status, expected);
    assert.match(
      f.view().message,
      command === "trial.create" ? /was saved/ : /may have been saved/,
    );
    f.receipt = async () => {
      throw new ApiError("missing", 404);
    };
    await assert.rejects(f.api().checkTrialAppointmentResult(LEAD));
    assert.equal(f.view().status, expected);
    assert.equal(f.view().locked, true);
    assert.equal(f.view().appointmentId, APPT);
    assert.equal(f.view().currentAppointment, null);
    assert.match(
      f.view().message,
      command === "trial.create" ? /was saved/ : /may have been saved/,
    );
  });
test("equivalent fractional schedule is a local no-op with no journal or dispatch", async () => {
  const f = fixture(),
    baseline = row({
      starts_at: "2030-01-01T09:00:00.000000Z",
      ends_at: "2030-01-01T10:00:00.120000Z",
    });
  await assert.rejects(
    f.api().updateTrialAppointment(baseline, {
      kind: "schedule",
      schedule: {
        starts_at: "2030-01-01T09:00:00Z",
        ends_at: "2030-01-01T10:00:00.12Z",
        timezone: baseline.timezone,
      },
    }),
    /Choose/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.storageWrites, 0);
  assert.equal(f.handles.size, 0);
});
