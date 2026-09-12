import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationRecoveryPath } from "../src/lib/navigation-recovery.ts";
import { requestAuthUser, AuthProviderUnavailable } from "../src/lib/auth-user-request.ts";
import { createResumeCheck } from "../src/lib/app-resume.ts";
import { beginPendingCommand, pendingCommands } from "../src/lib/pending-commands.ts";

test("recovery preserves application filters but rejects external and recursive destinations", () => {
  assert.equal(
    navigationRecoveryPath("/schedule?view=week&date=2026-09-06"),
    "/schedule?view=week&date=2026-09-06",
  );
  assert.equal(navigationRecoveryPath("/billing?tab=plans&_rsc=internal"), "/billing?tab=plans");
  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "/503?returnTo=/503",
    "/api/proxy",
    null,
    ["/billing"],
    "/schedule\n",
  ]) {
    assert.equal(navigationRecoveryPath(path), "/dashboard");
  }
});

test("auth provider retry recovers without treating outage as missing credentials", async () => {
  let reads = 0;
  const user = { id: "synthetic-user" };
  const result = await requestAuthUser(
    async () =>
      ++reads === 1 ? { data: { user: null }, error: { status: 503 } } : { data: { user } },
    new AbortController().signal,
  );
  assert.equal(result, user);
  assert.equal(reads, 2);
  await assert.rejects(
    requestAuthUser(
      async () => ({ data: { user: null }, error: { status: 503 } }),
      new AbortController().signal,
    ),
    AuthProviderUnavailable,
  );
});

test("auth rejection is not retried and a stalled SDK call respects cancellation", async () => {
  let reads = 0;
  assert.equal(
    await requestAuthUser(async () => {
      reads++;
      return { data: { user: null }, error: { status: 401 } };
    }, new AbortController().signal),
    null,
  );
  assert.equal(reads, 1);
  const controller = new AbortController();
  const work = requestAuthUser(() => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
});

const loaded = { environment: "production", commit_sha: "a".repeat(40) };
const current = { service: "koaryu-frontend", ...loaded };

test("restoration deduplicates requests, refreshes current data, and only notifies for a new build", async () => {
  let now = 0,
    reads = 0,
    refreshes = 0,
    updates = 0,
    resolve;
  const checker = createResumeCheck({
    loaded,
    now: () => now,
    readVersion: () => {
      reads++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    onCurrent: () => refreshes++,
    onUpdate: () => updates++,
  });
  const first = checker.check();
  assert.equal(first, checker.check());
  resolve(current);
  await first;
  await checker.check();
  assert.equal(reads, 1);
  assert.equal(refreshes, 1);
  assert.equal(updates, 0);
  now = 31000;
  const second = checker.check();
  resolve({ ...current, commit_sha: "b".repeat(40) });
  await second;
  assert.equal(updates, 1);
  assert.equal(refreshes, 1);
});

test("offline, malformed, other-environment and late version responses cannot replace the app", async () => {
  for (const response of [
    null,
    { ...current, environment: "staging" },
    { ...current, commit_sha: "bad" },
    new Error("Offline"),
  ]) {
    const checker = createResumeCheck({
      loaded,
      readVersion: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
      onCurrent: () => assert.fail(),
      onUpdate: () => assert.fail(),
    });
    await checker.check();
  }
  let resolve;
  const checker = createResumeCheck({
    loaded,
    readVersion: () =>
      new Promise((r) => {
        resolve = r;
      }),
    onCurrent: () => assert.fail(),
    onUpdate: () => assert.fail(),
  });
  const pending = checker.check();
  checker.dispose();
  resolve(current);
  await pending;
});

test("reconnecting immediately after an offline failure retries without waiting for the throttle", async () => {
  let reads = 0,
    refreshed = 0;
  const checker = createResumeCheck({
    loaded,
    now: () => 1000,
    readVersion: async () => {
      if (++reads === 1) throw new Error("Offline");
      return current;
    },
    onCurrent: () => refreshed++,
    onUpdate: () => assert.fail(),
  });
  await checker.check();
  await checker.check();
  assert.equal(reads, 2);
  assert.equal(refreshed, 1);
});

test("reload protection tracks all concurrent commands until each settles", () => {
  const first = beginPendingCommand(),
    second = beginPendingCommand();
  assert.equal(pendingCommands(), 2);
  first();
  first();
  assert.equal(pendingCommands(), 1);
  second();
  assert.equal(pendingCommands(), 0);
});
