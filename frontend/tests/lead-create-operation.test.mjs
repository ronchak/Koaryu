import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const { add, modules } = createCommonJsPacker({
  "@/lib/api": `exports.ApiError=class ApiError extends Error{constructor(message,status){super(message);this.status=status;}};`,
  "@/lib/access-identity": `exports.captureAccessIdentity=()=>{throw Error('Unexpected real auth')};exports.invalidateAccessIdentity=()=>{};`,
  "@/lib/studio-state-cookie": `exports.getActiveStudioIdCookie=()=>null;`,
});
const modId = add("@/lib/lead-create-operation"),
  apiId = add("@/lib/api");
const [m, { ApiError }] = new Function(
  `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}return [require(${modId}),require(${apiId})];`,
)();
const USER = "10000000-0000-4000-8000-000000000001",
  STUDIO = "20000000-0000-4000-8000-000000000001",
  LEAD = "30000000-0000-4000-8000-000000000001";
const input = {
  first_name: "Private",
  last_name: "Contact",
  email: "private@example.test",
  notes: "Secret note",
};
const row = (changes = {}) => ({
  id: LEAD,
  studio_id: STUDIO,
  first_name: "Current",
  last_name: "Lead",
  source: "walk_in",
  stage: "inquiry",
  is_minor: false,
  created_at: "2026-10-05T00:00:00Z",
  updated_at: "2026-10-05T00:01:00Z",
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
function fixture({ storage = new Map(), role = "admin", userId = USER, studioId = STUDIO } = {}) {
  const f = {
    storage,
    writes: [],
    reads: [],
    published: [],
    observations: [],
    cached: [],
    pending: 0,
    token: "token-1",
    authority: true,
    attachment: true,
    studioId,
    publication: 0,
    counter: 1,
    post: async () => row(),
    current: async () => row(),
    receipt: async (id) => ({
      operation_id: id,
      state: "committed",
      entity_type: "lead",
      entity_id: LEAD,
      command: "lead.create",
      committed_at: "2026-10-05T00:00:00Z",
      result: row({ first_name: "Historical" }),
    }),
  };
  const deps = {
    capture: (_, invalidated) => {
      f.invalidate = () => {
        f.authority = false;
        invalidated();
      };
      return {
        isCurrent: () => f.authority,
        dispose: () => {},
        signal: new AbortController().signal,
      };
    },
    invalidate: () => f.invalidate(),
    activeStudio: () => f.studioId,
    storage: () => {
      if (f.storageUnavailable) throw Error("Storage unavailable");
      return {
        getItem: (key) => {
          if (f.readFailure) throw Error("Cannot read");
          const stored = storage.get(key) ?? null;
          f.afterRead?.();
          return stored;
        },
        setItem: (key, value) => {
          if (f.writeFailure) throw Error("Cannot write");
          if (!f.ignoreWrite) storage.set(key, value);
          f.afterWrite?.();
        },
      };
    },
    uuid: () => `40000000-0000-4000-8000-${String(f.counter++).padStart(12, "0")}`,
  };
  f.owner = m.createLeadCreateOwner({ userId, studioId, role }, deps);
  f.bind = () => {
    const credentials = f.credentials ?? f;
    return f.owner.bind({
      isCurrent: () => f.attachment,
      beginRequest: () => {
        const token = credentials.token;
        return {
          token,
          isCurrent: () => f.authority && token === credentials.token,
          canRetryAfterTokenChange: () => f.authority && token !== credentials.token,
        };
      },
      beginMutation: () => {
        f.pending++;
        return () => {
          f.pending--;
        };
      },
      post: async (body, token) => {
        f.writes.push({ body, token });
        assert.ok(storage.get(m.LEAD_CREATE_JOURNAL_KEY));
        return f.post(body, token);
      },
      receipt: async (id, token) => {
        f.reads.push({ kind: "receipt", id, token });
        return f.receipt(id, token);
      },
      currentLead: async (id, token) => {
        f.reads.push({ kind: "current", id, token });
        return f.current(id, token);
      },
      capturePublication: () => {
        const p = f.publication;
        return () => p === f.publication;
      },
      publish: (id, lead) => {
        f.publication++;
        f.observations.push({ id, lead });
        if (lead) f.published.push(lead);
        f.cached = lead
          ? [lead, ...f.cached.filter((item) => item.id !== id)]
          : f.cached.filter((item) => item.id !== id);
      },
    });
  };
  f.detach = f.bind();
  f.view = () => f.owner.getSnapshot();
  f.entries = () => JSON.parse(storage.get(m.LEAD_CREATE_JOURNAL_KEY)).entries;
  return f;
}
async function unknown(f) {
  f.post = async () => {
    throw Error("lost response");
  };
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.view().status, "unknown");
}
for (const role of ["admin", "front_desk"])
  test(`${role} creates once, persists only identities, and publishes the current optional-field row`, async () => {
    const f = fixture({ role });
    const d = defer();
    f.post = () => d.promise;
    const one = f.owner.submit(input);
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].body.operation_id, /^[a-f0-9-]{36}$/);
    const stored = JSON.stringify(f.entries());
    for (const secret of ["Private", "Contact", "private@example.test", "Secret note", "token-1"])
      assert.ok(!stored.includes(secret));
    assert.equal(f.pending, 1);
    d.resolve(row({ first_name: "Historical" }));
    await one;
    assert.equal(f.pending, 0);
    assert.equal(f.published[0].first_name, "Current");
    assert.ok(!Object.hasOwn(f.published[0], "email"));
    assert.equal(f.view().status, "confirmed");
    assert.equal(f.view().locked, false);
    assert.deepEqual(f.entries(), []);
  });
test("reload adopts only same owner metadata and checks receipt then current row without POST", async () => {
  const f = fixture();
  await unknown(f);
  assert.equal(f.pending, 0);
  const restored = fixture({ storage: f.storage });
  await restored.owner.check();
  assert.deepEqual(
    restored.reads.map((r) => r.kind),
    ["receipt", "current"],
  );
  assert.equal(restored.writes.length, 0);
  assert.equal(restored.published[0].first_name, "Current");
});
test("another verified owner preserves other markers and does not adopt them", async () => {
  const f = fixture();
  await unknown(f);
  const other = fixture({ storage: f.storage, userId: "10000000-0000-4000-8000-000000000002" });
  assert.equal(other.view().status, "idle");
  await other.owner.check();
  assert.equal(other.reads.length, 0);
  other.counter = 2;
  other.post = async () => {
    throw Error("unknown");
  };
  await assert.rejects(other.owner.submit(input));
  assert.equal(other.entries().length, 2);
});
for (const change of [
  (v) => ({ ...v, command: "workflow.create" }),
  (v) => ({ ...v, operation_id: "40000000-0000-4000-8000-000000000099" }),
  (v) => ({ ...v, entity_type: "workflow" }),
  (v) => ({ ...v, entity_id: "30000000-0000-4000-8000-000000000002" }),
  (v) => ({ ...v, result: { ...v.result, studio_id: "20000000-0000-4000-8000-000000000002" } }),
  (v) => ({ ...v, result: { ...v.result, stage: "surprise" } }),
  () => null,
])
  test(`malformed or mismatched receipt ${change.toString()} stays reserved`, async () => {
    const f = fixture();
    await unknown(f);
    const receipt = f.receipt;
    f.receipt = async (id) => change(await receipt(id));
    await assert.rejects(f.owner.check());
    assert.equal(f.view().locked, true);
    assert.equal(f.published.length, 0);
    assert.equal(f.reads.filter((r) => r.kind === "current").length, 0);
  });
test("missing receipt stays unknown; current404 is terminal unavailable only after confirmation", async () => {
  const f = fixture();
  await unknown(f);
  const receipt = f.receipt;
  f.receipt = async () => {
    throw new ApiError("missing", 404);
  };
  await assert.rejects(f.owner.check());
  assert.equal(f.view().status, "unknown");
  f.receipt = receipt;
  f.current = async () => {
    throw new ApiError("missing current", 404);
  };
  await f.owner.check();
  assert.equal(f.view().status, "unavailable");
  assert.equal(f.view().message, m.LEAD_CREATE_UNAVAILABLE);
  assert.equal(f.view().locked, false);
  assert.equal(f.published.length, 0);
  assert.deepEqual(f.entries(), []);
});
test("direct success current404 uses the same unavailable result", async () => {
  const f = fixture();
  f.current = async () => {
    throw new ApiError("missing", 404);
  };
  await f.owner.submit(input);
  assert.equal(f.view().message, m.LEAD_CREATE_UNAVAILABLE);
  assert.equal(f.published.length, 0);
});
for (const value of [null, {}, row({ id: "wrong" }), row({ studio_id: "wrong" })])
  test(`malformed current row ${JSON.stringify(value)} does not mean404`, async () => {
    const f = fixture();
    f.current = async () => value;
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.view().status, "confirmed_needs_refresh");
    assert.equal(f.view().locked, true);
    assert.equal(f.published.length, 0);
  });
test("current GET failure retains the confirmed alias; a different later receipt ID is refused", async () => {
  const f = fixture();
  f.current = async () => {
    throw Error("offline");
  };
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.entries()[0].lead_id, LEAD);
  const receipt = f.receipt;
  f.receipt = async (id) => {
    const v = await receipt(id);
    return {
      ...v,
      entity_id: "30000000-0000-4000-8000-000000000099",
      result: row({ id: "30000000-0000-4000-8000-000000000099" }),
    };
  };
  await assert.rejects(f.owner.check());
  assert.equal(f.published.length, 0);
  assert.equal(f.entries()[0].lead_id, LEAD);
});
test("obsolete mutation401 retains authority and current-token readback uses the original operation", async () => {
  const f = fixture(),
    d = defer();
  f.post = () => d.promise;
  const submitted = f.owner.submit(input);
  f.token = "token-2";
  d.reject(new ApiError("expired", 401));
  await assert.rejects(submitted);
  assert.equal(f.view().isCurrent(), true);
  await f.owner.check();
  assert.equal(f.writes.length, 1);
  assert.ok(f.reads.every((r) => r.token === "token-2"));
});
for (const status of [401, 402, 403])
  test(`current mutation${status} fences authority and retains metadata`, async () => {
    const f = fixture();
    f.post = async () => {
      throw new ApiError("denied", status);
    };
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.view().isCurrent(), false);
    assert.equal(f.entries().length, 1);
    assert.equal(f.published.length, 0);
  });
for (const status of [400, 404, 409, 413, 422])
  test(`direct mutation${status} releases only after durable cleanup and next submit gets a new ID`, async () => {
    const f = fixture();
    f.post = async () => {
      throw new ApiError("rejected", status);
    };
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.view().status, "rejected");
    assert.equal(f.view().locked, false);
    f.post = async () => row();
    await f.owner.submit(input);
    assert.notEqual(f.writes[0].body.operation_id, f.writes[1].body.operation_id);
  });
test("bounded reads retry only credentials, and repeated checks coalesce", async () => {
  const f = fixture();
  await unknown(f);
  const original = f.receipt,
    d = defer();
  f.receipt = async (id, token) => (token === "token-1" ? d.promise : original(id));
  const a = f.owner.check(),
    b = f.owner.check();
  assert.equal(a, b);
  f.token = "token-2";
  d.reject(new ApiError("expired", 401));
  await a;
  assert.deepEqual(
    f.reads.map((r) => r.token),
    ["token-1", "token-2", "token-2"],
  );
  assert.equal(f.writes.length, 1);
});
test("three credential replacements stop a read without POST replay", async () => {
  const f = fixture();
  await unknown(f);
  f.receipt = async () => {
    f.token += "x";
    throw new ApiError("expired", 401);
  };
  await assert.rejects(f.owner.check());
  assert.equal(f.reads.length, 3);
  assert.equal(f.view().status, "unknown");
  assert.equal(f.writes.length, 1);
});
test("provider detach during current read prevents row publication and durable cleanup", async () => {
  const f = fixture(),
    d = defer();
  f.current = () => d.promise;
  const submit = f.owner.submit(input);
  await new Promise((r) => setImmediate(r));
  f.detach();
  d.resolve(row());
  await assert.rejects(submit);
  assert.equal(f.entries().length, 1);
  assert.equal(f.published.length, 0);
  f.bind();
  f.current = async () => row();
  await f.owner.check();
  assert.equal(f.view().status, "confirmed");
});
test("newer publication and resource replacement keep the marker for a fresh observation", async () => {
  for (const replace of [(f) => f.publication++, (f) => (f.attachment = false)]) {
    const f = fixture(),
      d = defer();
    f.current = () => d.promise;
    const submit = f.owner.submit(input);
    await new Promise((r) => setImmediate(r));
    replace(f);
    d.resolve(row());
    await assert.rejects(submit);
    assert.equal(f.entries().length, 1);
    assert.equal(f.published.length, 0);
  }
});
test("identity/ABA change during404 cannot publish or clean an old owner's marker", async () => {
  const f = fixture(),
    d = defer();
  f.current = () => d.promise;
  const submitted = f.owner.submit(input);
  await new Promise((r) => setImmediate(r));
  f.invalidate();
  f.authority = true;
  d.reject(new ApiError("removed", 404));
  await assert.rejects(submitted);
  assert.equal(f.view().isCurrent(), false);
  assert.equal(f.entries().length, 1);
  assert.equal(f.published.length, 0);
});
test("actual studio cookie must match before any create or check request", async () => {
  const f = fixture();
  f.studioId = "another";
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.writes.length, 0);
  assert.equal(f.storage.size, 0);
});
for (const fault of ["storageUnavailable", "readFailure", "writeFailure", "ignoreWrite"])
  test(`journal ${fault} prevents dispatch`, async () => {
    const f = fixture();
    f[fault] = true;
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.writes.length, 0);
    assert.equal(f.view().locked, true);
  });
test("malformed, duplicate, extra-payload and over-cap journals refuse dispatch", async () => {
  for (const raw of [
    "not-json",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({
      version: 1,
      entries: [
        {
          command: "lead.create",
          operation_id: LEAD,
          owner_user_id: USER,
          owner_studio_id: STUDIO,
          contact: "secret",
        },
      ],
    }),
  ]) {
    const f = fixture({ storage: new Map([[m.LEAD_CREATE_JOURNAL_KEY, raw]]) });
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.writes.length, 0);
    assert.equal(f.storage.get(m.LEAD_CREATE_JOURNAL_KEY), raw);
  }
});
test("100 other-owner markers are preserved without eviction", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    command: "lead.create",
    operation_id: `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    owner_user_id: `10000000-0000-4000-8000-${String(i + 2).padStart(12, "0")}`,
    owner_studio_id: STUDIO,
  }));
  const raw = JSON.stringify({ version: 1, entries }),
    f = fixture({ storage: new Map([[m.LEAD_CREATE_JOURNAL_KEY, raw]]) });
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.writes.length, 0);
  assert.equal(f.storage.get(m.LEAD_CREATE_JOURNAL_KEY), raw);
});
test("alias persistence failure never publishes a row and retains original marker", async () => {
  const f = fixture();
  f.post = async () => {
    f.writeFailure = true;
    return row();
  };
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.entries()[0].lead_id, undefined);
  assert.equal(f.view().locked, true);
  assert.equal(f.reads.length, 0);
  assert.equal(f.published.length, 0);
  f.writeFailure = false;
  await f.owner.check();
  assert.equal(f.view().status, "confirmed");
});
for (const missing of [false, true])
  test(`cleanup failure keeps ${missing ? "unavailable" : "confirmed"} result blocked`, async () => {
    const f = fixture();
    f.current = async () => {
      f.writeFailure = true;
      if (missing) throw new ApiError("missing", 404);
      return row();
    };
    await assert.rejects(f.owner.submit(input));
    assert.equal(f.view().locked, true);
    assert.equal(f.entries()[0].lead_id, LEAD);
    assert.equal(f.published.length, 0);
  });
test("serialization failure never dispatches or stores form fields", async () => {
  const f = fixture(),
    circular = { ...input };
  circular.self = circular;
  await assert.rejects(f.owner.submit(circular));
  assert.equal(f.writes.length, 0);
  assert.equal(f.storage.size, 0);
  assert.equal(f.view().status, "rejected");
});
test("nonmanagers cannot create an owner or touch its journal", () => {
  let calls = 0;
  assert.throws(() =>
    m.createLeadCreateOwner(
      { userId: USER, studioId: STUDIO, role: "instructor" },
      {
        storage: () => {
          calls++;
        },
      },
    ),
  );
  assert.equal(calls, 0);
});

test("storage restoration allows a new explicit create without abandoning another owner", async () => {
  const f = fixture();
  f.writeFailure = true;
  await assert.rejects(f.owner.submit(input));
  f.writeFailure = false;
  await f.owner.check();
  assert.equal(f.view().status, "idle");
  await f.owner.submit(input);
  assert.equal(f.writes.length, 1);
});
test("known rejection with failed cleanup stays locked until cleanup succeeds", async () => {
  const f = fixture();
  f.post = async () => {
    f.writeFailure = true;
    throw new ApiError("rejected", 422);
  };
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.view().status, "rejected");
  assert.equal(f.view().locked, true);
  f.writeFailure = false;
  await f.owner.check();
  assert.equal(f.view().status, "rejected");
  assert.equal(f.view().locked, false);
  assert.equal(f.reads.length, 0);
});
test("cleanup write verification failure restores the earlier marker", async () => {
  const f = fixture();
  f.current = async () => {
    f.afterWrite = () => {
      f.readFailure = true;
    };
    return row();
  };
  await assert.rejects(f.owner.submit(input));
  f.readFailure = false;
  assert.equal(f.entries()[0].lead_id, LEAD);
  assert.equal(f.view().locked, true);
  assert.equal(f.published.length, 0);
});
test("authority change during cleanup restores metadata and never publishes", async () => {
  const f = fixture();
  f.current = async () => {
    f.afterWrite = () => f.invalidate();
    throw new ApiError("removed", 404);
  };
  await assert.rejects(f.owner.submit(input));
  assert.equal(f.entries()[0].lead_id, LEAD);
  assert.equal(f.view().isCurrent(), false);
  assert.equal(f.published.length, 0);
});
test("detached provider cannot clean a rejected mutation marker", async () => {
  const f = fixture(),
    d = defer();
  f.post = () => d.promise;
  const submitted = f.owner.submit(input);
  f.detach();
  d.reject(new ApiError("rejected", 409));
  await assert.rejects(submitted);
  assert.equal(f.entries().length, 1);
  assert.equal(f.view().locked, true);
});

test("an operation ID collision cannot overwrite or dispatch against another owner's marker", async () => {
  const f = fixture();
  await unknown(f);
  const other = fixture({ storage: f.storage, userId: "10000000-0000-4000-8000-000000000002" });
  await assert.rejects(other.owner.submit(input));
  assert.equal(other.writes.length, 0);
  assert.equal(other.entries().length, 1);
});

for (const change of [(f) => f.detach(), (f) => f.publication++, (f) => f.invalidate()])
  test(`verification-read fence restores marker after ${change.toString()}`, async () => {
    const f = fixture();
    f.current = async () => {
      f.afterWrite = () => {
        f.afterRead = () => change(f);
      };
      return row();
    };
    await assert.rejects(f.owner.submit(input));
    f.afterRead = undefined;
    f.afterWrite = undefined;
    assert.equal(f.entries()[0].lead_id, LEAD);
    assert.equal(f.published.length, 0);
    assert.equal(f.view().locked, true);
  });

for (const held of ["post", "current"])
  test(`detached ${held}401 cannot revoke the replacement provider's current token`, async () => {
    const f = fixture(),
      pending = defer();
    f.detach();
    f.credentials = { token: "token-1" };
    f.detach = f.bind();
    let request;
    if (held === "post") {
      f.post = () => pending.promise;
      request = f.owner.submit(input);
    } else {
      await unknown(f);
      f.current = () => pending.promise;
      request = f.owner.check();
      await new Promise((resolve) => setImmediate(resolve));
    }
    f.detach();
    f.credentials = { token: "token-2" };
    f.detach = f.bind();
    pending.reject(new ApiError("Old provider unauthorized", 401));
    await assert.rejects(request);
    assert.equal(f.view().isCurrent(), true);
    assert.equal(f.view().locked, true);
    assert.equal(f.entries().length, 1);
    const readsBeforeCheck = f.reads.length;
    f.current = async () => row();
    await f.owner.check();
    assert.deepEqual(
      f.reads.slice(readsBeforeCheck).map((read) => read.token),
      ["token-2", "token-2"],
    );
    assert.equal(f.writes.length, 1);
    assert.equal(f.view().status, "confirmed");
  });

test("obsolete resource-scope denial cannot revoke the verified owner", async () => {
  const f = fixture(),
    pending = defer();
  f.post = () => pending.promise;
  const request = f.owner.submit(input);
  f.attachment = false;
  pending.reject(new ApiError("Old resource unauthorized", 403));
  await assert.rejects(request);
  assert.equal(f.view().isCurrent(), true);
  assert.equal(f.entries().length, 1);
  f.attachment = true;
  f.detach();
  f.detach = f.bind();
  await f.owner.check();
  assert.equal(f.view().status, "confirmed");
  assert.equal(f.writes.length, 1);
});

test("confirmed absence removes only its exact cached ID", async () => {
  const f = fixture();
  f.cached = [row(), row({ id: "30000000-0000-4000-8000-000000000002", first_name: "Other" })];
  await unknown(f);
  f.current = async () => {
    throw new ApiError("Deleted", 404);
  };
  await f.owner.check();
  assert.deepEqual(f.observations, [{ id: LEAD, lead: null }]);
  assert.equal(f.cached.length, 1);
  assert.equal(f.cached[0].first_name, "Other");
  assert.equal(f.view().status, "unavailable");
  assert.equal(f.entries().length, 0);
});

test("a held absence cannot remove a newer row publication", async () => {
  const f = fixture(),
    pending = defer();
  f.cached = [row()];
  await unknown(f);
  f.current = () => pending.promise;
  const request = f.owner.check();
  await new Promise((resolve) => setImmediate(resolve));
  f.publication++;
  f.cached = [row({ first_name: "Newer observation" })];
  pending.reject(new ApiError("Old absence", 404));
  await assert.rejects(request);
  assert.equal(f.cached[0].first_name, "Newer observation");
  assert.equal(f.observations.length, 0);
  assert.equal(f.entries().length, 1);
  assert.equal(f.view().locked, true);
});
