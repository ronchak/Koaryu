import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as p from "../src/lib/dashboard/home-preferences.ts";

const scope = { userId: "user-a", studioId: "studio-a" };
const defaults = () => p.defaultHomePreferences("admin");
const hidden = () => p.setHomePanelShown(defaults(), "follow_ups", false);
function storage(entries = []) {
  const data = new Map(entries);
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
function clock() {
  let id = 0;
  const callbacks = new Map();
  return {
    callbacks,
    set(fn, ms) {
      assert.equal(ms, 400);
      callbacks.set(++id, fn);
      return id;
    },
    clear(id) {
      callbacks.delete(id);
    },
    run() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const fn of pending) fn();
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function engine(options = {}) {
  const timers = clock(),
    saves = [];
  const sync = p.createHomePreferencesSync({
    scope,
    role: "admin",
    storage: storage(),
    timers,
    saver: (value, identity) => {
      const request = deferred();
      saves.push({ value, identity, ...request });
      return request.promise;
    },
    ...options,
  });
  return { sync, timers, saves };
}
afterEach(() => p.forgetHomePreferencesSyncs());

for (const [role, order] of [
  ["admin", p.HOME_PANEL_IDS],
  ["front_desk", ["follow_ups", "recent_students"]],
  ["instructor", ["ready_to_promote", "recent_students"]],
  [null, []],
])
  test(`defaults and reset for ${role ?? "no role"}`, () => {
    const expected = { version: 1, order, hidden: role ? ["recent_students"] : [], size: {} };
    assert.deepEqual(p.defaultHomePreferences(role), expected);
    assert.deepEqual(p.resetHomePreferences(role), expected);
    assert.deepEqual(p.homePanelIdsForRole(role), order);
    assert.equal(p.isDefaultHomePreferences(expected, role), true);
    assert.deepEqual(
      p.homeVisiblePanelIds(expected),
      order.filter((id) => id !== "recent_students"),
    );
  });
test("reconcile drops unknown, duplicate and non-entitled ids, appends defaults, orders hidden and clamps sizes", () => {
  assert.deepEqual(
    p.parseHomePreferences(
      {
        version: 1,
        order: ["recent_students", "alien", "ready_to_promote", "recent_students"],
        hidden: ["follow_ups", "alien", "recent_students", "follow_ups"],
        size: { recent_students: "expanded", follow_ups: "compact", alien: "compact" },
      },
      "front_desk",
    ),
    {
      version: 1,
      order: ["recent_students", "follow_ups"],
      hidden: ["recent_students", "follow_ups"],
      size: {},
    },
  );
  assert.deepEqual(p.reconcileHomePreferences({ version: 1, order: [] }, "admin"), defaults());
  assert.deepEqual(
    p.reconcileHomePreferences({ version: 1, order: ["ready_to_promote"] }, "admin"),
    { ...defaults(), order: ["ready_to_promote", "follow_ups", "recent_students"] },
  );
  assert.deepEqual(
    p.reconcileHomePreferences(
      { version: 1, order: p.HOME_PANEL_IDS, hidden: null, size: [] },
      "admin",
    ),
    { ...defaults(), hidden: [] },
  );
  assert.deepEqual(p.reconcileHomePreferences(defaults(), null), p.defaultHomePreferences(null));
});
test("wrong version and shape parse as null and reconcile to defaults", () => {
  for (const raw of [
    null,
    undefined,
    [],
    "value",
    {},
    { version: 2, order: [] },
    { version: "1", order: [] },
    { version: 1, order: {} },
  ]) {
    assert.equal(p.parseHomePreferences(raw, "admin"), null);
    assert.deepEqual(p.reconcileHomePreferences(raw, "admin"), defaults());
  }
});
test("move and show helpers preserve identity at edges and maintain hidden order", () => {
  const value = defaults();
  for (const result of [
    p.moveHomePanel(value, "follow_ups", -1),
    p.moveHomePanel(value, "recent_students", 1),
    p.moveHomePanel(value, "missing", 1),
    p.moveHomePanelTo(value, "follow_ups", -9),
    p.moveHomePanelTo(value, "follow_ups", 1.5),
    p.moveHomePanelTo(value, "missing", 0),
    p.setHomePanelShown(value, "follow_ups", true),
    p.setHomePanelShown(value, "recent_students", false),
    p.setHomePanelShown(value, "missing", false),
  ])
    assert.equal(result, value);
  const moved = p.moveHomePanelTo(hidden(), "recent_students", 0);
  assert.deepEqual(moved.order, ["recent_students", "follow_ups", "ready_to_promote"]);
  assert.deepEqual(moved.hidden, ["recent_students", "follow_ups"]);
  assert.deepEqual(p.setHomePanelShown(moved, "recent_students", true).hidden, ["follow_ups"]);
  assert.equal(
    p.sameHomePreferences(moved, { ...moved, hidden: [...moved.hidden].reverse() }),
    true,
  );
  assert.equal(p.isDefaultHomePreferences(hidden(), "admin"), false);
});
test("storage keys encode trimmed identities and reject empty or overlong identities", () => {
  assert.equal(
    p.homePreferencesStorageKey(" user:a / ", " studio:b/ "),
    "koaryu:home-preferences:v1:user%3Aa%20%2F:studio%3Ab%2F",
  );
  for (const id of [null, undefined, 1, "", "  ", "x".repeat(257)]) {
    assert.equal(p.homePreferencesStorageKey(id, "s"), null);
    assert.equal(p.homePreferencesStorageKey("u", id), null);
  }
  assert.ok(p.homePreferencesStorageKey("x".repeat(256), "s"));
  assert.equal(p.getBrowserHomePreferencesStorage(), null);
});
test("storage read/write tolerate missing, malformed, denied and quota-limited storage", () => {
  const s = storage(),
    key = p.homePreferencesStorageKey(scope.userId, scope.studioId);
  const value = { preferences: hidden(), unsynced: true };
  assert.equal(p.writeStoredHomePreferences(s, scope, value), true);
  assert.deepEqual(p.readStoredHomePreferences(s, scope, "admin"), value);
  for (const raw of [
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ preferences: { version: 2, order: [] } }),
  ]) {
    s.setItem(key, raw);
    assert.equal(p.readStoredHomePreferences(s, scope, "admin"), null);
  }
  s.setItem(key, JSON.stringify({ preferences: defaults(), unsynced: "true" }));
  assert.equal(p.readStoredHomePreferences(s, scope, "admin").unsynced, false);
  const denied = {
    getItem() {
      throw Error("denied");
    },
    setItem() {
      throw Error("quota");
    },
  };
  for (const target of [null, denied]) {
    assert.equal(p.readStoredHomePreferences(target, scope, "admin"), null);
    assert.equal(p.writeStoredHomePreferences(target, scope, value), false);
  }
  assert.equal(p.writeStoredHomePreferences(s, { userId: "", studioId: "s" }, value), false);
});
test("purge removes only namespace keys, tolerates enumeration/removal faults and disposes registry syncs", () => {
  const key = p.homePreferencesStorageKey("u", "s"),
    s = storage([
      [key, "a"],
      [key + "2", "b"],
      ["koaryu-theme", "dark"],
      ["koaryu:dashboard-layout:v1:u:s", "old"],
    ]);
  const sync = p.homePreferencesSync({ scope, role: "admin", storage: null });
  assert.equal(p.purgeHomePreferencesNamespace(s), 2);
  assert.deepEqual([...s.data.keys()], ["koaryu-theme", "koaryu:dashboard-layout:v1:u:s"]);
  sync.change(hidden());
  assert.deepEqual(sync.getSnapshot(), defaults());
  assert.equal(p.purgeHomePreferencesNamespace(null), 0);
  assert.equal(
    p.purgeHomePreferencesNamespace({
      get length() {
        throw Error("denied");
      },
    }),
    0,
  );
  const broken = storage([
    [key, "a"],
    [key + "2", "b"],
  ]);
  broken.removeItem = (k) => {
    if (k === key) throw Error("denied");
    broken.data.delete(k);
  };
  assert.equal(p.purgeHomePreferencesNamespace(broken), 1);
});
test("sync sends one debounced PUT per burst containing the latest value and exact scope", async () => {
  const { sync, timers, saves } = engine();
  sync.change(hidden());
  sync.change(p.moveHomePanel(hidden(), "ready_to_promote", -1));
  assert.equal(saves.length, 0);
  assert.equal(timers.callbacks.size, 1);
  timers.run();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].value, sync.getSnapshot());
  assert.deepEqual(saves[0].identity, scope);
  saves[0].resolve(saves[0].value);
  await settle();
  assert.equal(sync.isPending(), false);
  sync.dispose();
});
test("sync has one save in flight and sends the newer edit after it", async () => {
  const { sync, timers, saves } = engine();
  sync.change(hidden());
  timers.run();
  sync.change(p.moveHomePanel(hidden(), "ready_to_promote", -1));
  timers.run();
  assert.equal(saves.length, 1);
  saves[0].resolve(saves[0].value);
  await settle();
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1].value, sync.getSnapshot());
  saves[1].resolve(saves[1].value);
  await settle();
  assert.equal(sync.isPending(), false);
  sync.dispose();
});
for (const retry of ["edit", "flush"])
  test(`failure keeps the local value and retries only on next ${retry}`, async () => {
    const { sync, timers, saves } = engine();
    sync.change(hidden());
    timers.run();
    saves[0].reject(Error("offline"));
    await settle();
    assert.deepEqual(sync.getSnapshot(), hidden());
    assert.equal(sync.isPending(), true);
    timers.run();
    assert.equal(saves.length, 1);
    if (retry === "edit") {
      sync.change(p.moveHomePanel(hidden(), "ready_to_promote", -1));
      timers.run();
    } else sync.flush();
    assert.equal(saves.length, 2);
    saves[1].resolve(saves[1].value);
    await settle();
    sync.dispose();
  });
test("flush during a failed save retries once without an automatic retry loop", async () => {
  const { sync, timers, saves } = engine();
  sync.change(hidden());
  timers.run();
  sync.flush();
  sync.flush();
  saves[0].reject(Error("offline"));
  await settle();
  assert.equal(saves.length, 2);
  saves[1].reject(Error("still offline"));
  await settle();
  timers.run();
  assert.equal(saves.length, 2);
  sync.dispose();
});
test("server save response differing from the sent value is adopted", async () => {
  const { sync, timers, saves } = engine();
  sync.change(hidden());
  timers.run();
  const server = p.moveHomePanel(hidden(), "ready_to_promote", -1);
  saves[0].resolve(server);
  await settle();
  assert.deepEqual(sync.getSnapshot(), server);
  assert.equal(sync.isPending(), false);
  sync.dispose();
});
test("offerServer adopts idle values, ignores pending edits and values this tab replaced", async () => {
  const { sync, timers, saves } = engine();
  const server = p.moveHomePanel(defaults(), "ready_to_promote", -1);
  sync.offerServer(server);
  assert.deepEqual(sync.getSnapshot(), server);
  sync.change(hidden());
  sync.offerServer(defaults());
  assert.deepEqual(sync.getSnapshot(), hidden());
  timers.run();
  sync.offerServer(server);
  assert.deepEqual(sync.getSnapshot(), hidden());
  saves[0].resolve(hidden());
  await settle();
  sync.offerServer(server);
  assert.deepEqual(sync.getSnapshot(), hidden());
  sync.offerServer(null);
  sync.offerServer({ version: 2, order: [] });
  assert.deepEqual(sync.getSnapshot(), hidden());
  sync.dispose();
});
test("an unconfirmed stored copy is retried when setSaver attaches", async () => {
  const s = storage();
  p.writeStoredHomePreferences(s, scope, { preferences: hidden(), unsynced: true });
  const { sync, timers } = engine({ storage: s, saver: undefined });
  const sent = [];
  sync.setSaver(async (value) => {
    sent.push(value);
    return value;
  });
  assert.equal(sent.length, 0);
  timers.run();
  await settle();
  assert.deepEqual(sent, [hidden()]);
  assert.equal(sync.isPending(), false);
  sync.dispose();
});
test("setRole reconciles immediately and subscribe unsubscribe track changes", () => {
  const { sync } = engine();
  let notifications = 0;
  const unsubscribe = sync.subscribe(() => notifications++);
  sync.setRole("instructor");
  assert.deepEqual(sync.getSnapshot(), p.defaultHomePreferences("instructor"));
  assert.equal(notifications, 1);
  sync.setRole("instructor");
  assert.equal(notifications, 1);
  unsubscribe();
  sync.setRole("front_desk");
  assert.equal(notifications, 1);
  sync.dispose();
});
test("dispose cancels timers, listeners, late responses and future changes", async () => {
  const { sync, timers, saves } = engine();
  let notified = 0;
  sync.subscribe(() => notified++);
  sync.change(hidden());
  timers.run();
  sync.dispose();
  saves[0].resolve(defaults());
  await settle();
  sync.change(defaults());
  sync.offerServer(defaults());
  sync.setRole("instructor");
  sync.setSaver(async (value) => value);
  sync.flush();
  timers.run();
  assert.deepEqual(sync.getSnapshot(), hidden());
  assert.equal(notified, 1);
  assert.equal(saves.length, 1);
  const pending = engine();
  pending.sync.change(hidden());
  pending.sync.dispose();
  pending.timers.run();
  assert.equal(pending.saves.length, 0);
});
test("registry is scoped by user and studio and forgetting creates a new sync", () => {
  const options = { scope, role: "admin", storage: null };
  const a = p.homePreferencesSync(options);
  assert.equal(p.homePreferencesSync(options), a);
  assert.notEqual(p.homePreferencesSync({ ...options, scope: { ...scope, userId: "user-b" } }), a);
  assert.notEqual(
    p.homePreferencesSync({ ...options, scope: { ...scope, studioId: "studio-b" } }),
    a,
  );
  assert.equal(p.homePreferencesSync({ ...options, scope: { userId: "", studioId: "s" } }), null);
  p.forgetHomePreferencesSyncs();
  assert.notEqual(p.homePreferencesSync(options), a);
});
