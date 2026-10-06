import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  CommandOutcomeUnknown,
  createWorkflowWorkspace,
  specimen,
  ids,
  scope,
  graph,
  nodeId,
  runTarget,
  testTarget,
  marker,
  delivery,
  receipt,
  workflowDetail,
  activityCatalog,
  JOURNAL,
  markers,
  operation,
  fixture,
  workspace,
  opened,
  clone,
  deferred,
  tick,
} from "./helpers/workflow-activity-fixture.mjs";

const create = (w, value = graph()) => w.activity.createTest(ids.workflow, value, nodeId);
const setJournal = (f, entries) => f.saved.set(JOURNAL, JSON.stringify({ version: 1, entries }));
const check = (w, target = testTarget) => w.activity.checkResult(target);
const throws = async (call, pattern) => assert.rejects(Promise.resolve().then(call), pattern);
const names = (f) => f.calls.map((call) => call.name);
function failReadback(f, when = () => true) {
  const get = f.storage.getItem,
    set = f.storage.setItem;
  let failed = false,
    written = false;
  f.storage.setItem = (key, value) => {
    set(key, value);
    if (key === JOURNAL && when(JSON.parse(value).entries)) written = true;
  };
  f.storage.getItem = (key) => {
    if (key === JOURNAL && written && !failed) {
      failed = true;
      throw new Error("failed readback");
    }
    return get(key);
  };
}

test("one test POST owns double activation and captured graph across detach and token renewal", async () => {
  const f = fixture(),
    gate = deferred(),
    w = await opened(f),
    held = graph();
  f.responses.sendTestEmail = () => gate.promise;
  const unsubscribe = w.activity.subscribe(() => {});
  const first = create(w, held);
  assert.equal(create(w), first);
  unsubscribe();
  held.nodes.find((node) => node.id === nodeId).config.subject_template = "Changed caller";
  w.edit({ kind: "metadata", name: "New name" });
  w.updateToken("token-2");
  await tick();
  assert.equal(f.allocations, 1);
  assert.deepEqual(names(f), ["sendTestEmail"]);
  assert.notEqual(
    f.calls[0].args[1].graph.nodes.find((node) => node.id === nodeId).config.subject_template,
    "Changed caller",
  );
  gate.resolve(delivery("queued"));
  await first;
  assert.equal(operation(w).current.state, "queued");
  assert.equal(operation(w).locked, true);
  assert.equal(markers(f)[0].test_delivery_id, ids.delivery);
  assert.deepEqual(names(f), ["sendTestEmail"]);
  assert.equal(w.getSnapshot().editor.name, "New name");
  for (const secret of [
    "graph",
    "subject_template",
    "recipient",
    "token-",
    "body",
    "revision",
    "source",
    "fingerprint",
  ])
    assert.equal(f.saved.get(JOURNAL).includes(secret), false, secret);
});

test("run CAS is captured and direct acknowledgment requires exact current read before cleanup", async () => {
  const f = fixture(),
    gate = deferred(),
    w = workspace(f),
    baseline = clone(specimen.cancellation.baseline);
  f.responses.cancelRun = () => gate.promise;
  const first = w.activity.cancelRun(baseline);
  assert.equal(w.activity.cancelRun(clone(baseline)), first);
  baseline.run.revision = 100;
  baseline.run.id = ids.other;
  await tick();
  assert.equal(f.calls[0].args[0].run.revision, specimen.cancellation.baseline.run.revision);
  assert.equal(f.calls[0].args[0].run.id, ids.run);
  gate.resolve(clone(specimen.cancellation.result));
  await first;
  assert.deepEqual(names(f), ["cancelRun", "getRun"]);
  assert.equal(w.activity.pendingOperation(runTarget), undefined);
  assert.equal(operation(w, runTarget).status, "confirmed");
  assert.equal(markers(f).length, 0);
});

test("run sending acknowledgment retains sending truth and does not claim transmission stopped", async () => {
  const f = fixture(),
    w = workspace(f);
  f.responses.cancelRun = () => clone(specimen.cancellation.sending_result);
  f.responses.getRun = () => clone(specimen.cancellation.sending_result);
  await w.activity.cancelRun(clone(specimen.cancellation.sending_baseline));
  assert.equal(operation(w, runTarget).current.run.state, "sending");
  assert.equal(operation(w, runTarget).message, null);
});

test("reload with alias reads immutable receipt then current delivery and keeps terminal reservation", async () => {
  const f = fixture(),
    w = await opened(f);
  await create(w);
  f.auth[0].invalidate();
  const next = workspace(f);
  assert.equal(operation(next).status, "confirmed_needs_refresh");
  assert.equal(operation(next).current, null);
  await throws(() => next.activity.dismissTestResult(ids.workflow, ids.operation), /terminal/);
  await check(next);
  assert.deepEqual(names(f), ["sendTestEmail", "getOperation", "getTestDelivery"]);
  assert.equal(operation(next).status, "confirmed");
  assert.equal(operation(next).current.state, "accepted");
  assert.equal(operation(next).locked, true);
  assert.equal(markers(f).length, 1);
});

for (const command of ["run.cancel", "test_email.create"])
  test(`${command} missing/mismatched/malformed receipt never releases reservation`, async () => {
    const f = fixture(),
      w = await opened(f),
      target = command === "run.cancel" ? runTarget : testTarget;
    f.responses[command === "run.cancel" ? "cancelRun" : "sendTestEmail"] = () => {
      throw new CommandOutcomeUnknown(ids.operation);
    };
    await (command === "run.cancel"
      ? w.activity.cancelRun(clone(specimen.cancellation.baseline))
      : create(w));
    const wrong = receipt(ids.operation, command);
    wrong.entity_id = ids.other;
    for (const response of [
      new ApiError("missing", 404),
      null,
      wrong,
      receipt(ids.other, command),
    ]) {
      f.responses.getOperation = () => {
        if (response instanceof Error) throw response;
        return response;
      };
      await check(w, target);
      assert.equal(operation(w, target).status, "unknown");
      assert.equal(operation(w, target).locked, true);
    }
    assert.equal(f.allocations, 1);
    assert.equal(names(f).includes(command === "run.cancel" ? "getRun" : "getTestDelivery"), false);
    f.responses.getOperation = (identity) => receipt(identity.operationId, identity.command);
    await check(w, target);
    assert.notEqual(operation(w, target).status, "checking");
    assert.equal(operation(w, target).status, "confirmed");
  });

for (const command of ["run.cancel", "test_email.create"])
  test(`${command} malformed direct success is unknown; malformed current success is never absence`, async () => {
    for (const value of [null, {}]) {
      const f = fixture(),
        w = await opened(f),
        target = command === "run.cancel" ? runTarget : testTarget;
      f.responses[command === "run.cancel" ? "cancelRun" : "sendTestEmail"] = () => value;
      await (command === "run.cancel"
        ? w.activity.cancelRun(clone(specimen.cancellation.baseline))
        : create(w));
      assert.equal(operation(w, target).status, "unknown");
      f.responses[command === "run.cancel" ? "getRun" : "getTestDelivery"] = () => value;
      await check(w, target);
      assert.equal(operation(w, target).status, "confirmed_needs_refresh");
      assert.equal(operation(w, target).locked, true);
      assert.equal(markers(f).length, 1);
      assert.equal(operation(w, target).current, null);
    }
  });

test("only acknowledged current run404 cleans its exact marker; test404 keeps its reservation", async () => {
  const f = fixture(),
    w = await opened(f);
  await create(w);
  f.responses.getRun = () => {
    throw new ApiError("missing", 404);
  };
  await w.activity.cancelRun(clone(specimen.cancellation.baseline));
  assert.equal(operation(w, runTarget).status, "unavailable");
  assert.equal(operation(w, runTarget).locked, false);
  assert.equal(markers(f).length, 1);
  f.responses.getTestDelivery = () => {
    throw new ApiError("missing", 404);
  };
  await check(w);
  assert.equal(operation(w).status, "confirmed_needs_refresh");
  assert.equal(operation(w).locked, true);
  await throws(() => w.activity.dismissTestResult(ids.workflow, ids.operation), /terminal/);
});

for (const state of ["queued", "sending", "accepted", "failed", "unknown"])
  test(`test ${state} permits replacement/Dismiss only for verified terminal facts`, async () => {
    const f = fixture(),
      w = await opened(f);
    f.responses.sendTestEmail = (_workflow, body) => delivery(state, body.operation_id);
    await create(w);
    const old = operation(w),
      terminal = ["accepted", "failed", "unknown"].includes(state);
    assert.equal(old.status, "confirmed");
    assert.equal(old.locked, true);
    if (state === "unknown")
      assert.match(old.message, /may have been accepted.*will not be retried/);
    await throws(
      () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.other),
      /terminal/,
    );
    await throws(() => w.activity.dismissTestResult(ids.workflow, ids.other), /terminal/);
    if (!terminal) {
      await throws(
        () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, old.operationId),
        /terminal/,
      );
      await throws(() => w.activity.dismissTestResult(ids.workflow, old.operationId), /terminal/);
      assert.equal(f.calls.length, 1);
      return;
    }
    const writeStart = f.writes.length;
    await w.activity.createAnotherTest(ids.workflow, graph(), nodeId, old.operationId);
    const next = operation(w);
    assert.notEqual(next.operationId, old.operationId);
    assert.equal(old.isCurrent(), false);
    assert.equal(f.allocations, 2);
    assert.equal(
      f.writes.slice(writeStart).every((write) => JSON.parse(write.value).entries.length === 1),
      true,
    );
    await w.activity.dismissTestResult(ids.workflow, next.operationId);
    assert.equal(next.isCurrent(), false);
    assert.equal(markers(f).length, 0);
    assert.equal(operation(w), undefined);
    assert.equal(f.calls.length, 2);
  });

test("recovery and Dismiss remain usable with removed node and disabled test capability", async () => {
  const f = fixture(),
    w = await opened(f);
  await create(w);
  w.edit({ kind: "remove_node", node_id: nodeId });
  f.api.catalog = async () => ({
    ...clone(activityCatalog),
    capabilities: { can_start: false, can_test_email: false, disabled_reason: "disabled" },
  });
  await w.loadCatalog();
  await check(w);
  assert.equal(operation(w).current.state, "accepted");
  f.responses.getOperation = () => {
    throw new ApiError("temporary private message", 503);
  };
  await check(w);
  assert.equal(operation(w).status, "confirmed");
  await w.activity.dismissTestResult(ids.workflow, ids.operation);
  assert.equal(markers(f).length, 0);
  await throws(() => create(w, w.getSnapshot().editor.history.present.graph), /unavailable/);
});

test("same-workflow nodes share a target; different workflows and run/test namespaces remain independent", async () => {
  const f = fixture(),
    w = await opened(f);
  await create(w);
  assert.equal(await w.activity.createTest(ids.workflow, graph(), "other_node"), undefined);
  await w.openWorkflow(ids.other, true);
  await w.activity.createTest(ids.other, graph(), nodeId);
  const run = clone(specimen.cancellation.baseline);
  run.run.id = ids.workflow;
  const cancelled = clone(specimen.cancellation.result);
  cancelled.run.id = ids.workflow;
  f.responses.cancelRun = () => cancelled;
  f.responses.getRun = () => cancelled;
  await w.activity.cancelRun(run);
  assert.equal(names(f).filter((name) => name === "sendTestEmail").length, 2);
  assert.equal(markers(f).length, 2);
});

test("initial malformed/inaccessible storage trusts no marker; local edits and reads still work", async () => {
  for (const mode of ["malformed", "inaccessible"]) {
    const f = fixture();
    if (mode === "malformed") f.saved.set(JOURNAL, "private invalid data");
    else
      f.storage.getItem = () => {
        throw new Error("private storage detail");
      };
    const w = await opened(f);
    assert.equal(w.activity.getSnapshot().storage.status, "blocked");
    assert.equal(w.activity.getSnapshot().operations.size, 0);
    w.edit({ kind: "metadata", name: "Editable" });
    assert.equal((await w.activity.listRuns(ids.workflow)).status, "ready");
    await throws(() => create(w), /storage is unavailable/);
    assert.equal(f.allocations, 0);
    assert.equal(names(f).includes("sendTestEmail"), false);
  }
});

test("later storage loss keeps trusted reservations and equivalent reordered metadata restores access", async () => {
  const f = fixture(),
    w = await opened(f);
  await create(w);
  const trusted = markers(f),
    oldGet = f.storage.getItem;
  f.storage.getItem = () => {
    throw new Error("private");
  };
  await w.activity.checkStorage();
  assert.equal(operation(w).locked, true);
  assert.equal(w.activity.getSnapshot().storage.status, "blocked");
  f.storage.getItem = oldGet;
  setJournal(
    f,
    trusted.map((item) =>
      Object.fromEntries(
        Object.entries(item)
          .reverse()
          .map(([key, value]) => [
            key,
            typeof value === "string" && value.includes("abcdefab-") ? value.toUpperCase() : value,
          ]),
      ),
    ),
  );
  await w.activity.checkStorage();
  assert.equal(w.activity.getSnapshot().storage.status, "ready");
  for (const entries of [[], [{ ...trusted[0], test_delivery_id: ids.other }]]) {
    setJournal(f, entries);
    await w.activity.checkStorage();
    assert.equal(w.activity.getSnapshot().storage.status, "blocked");
    assert.equal(operation(w).operationId, ids.operation);
  }
});

test("pre-dispatch capacity, write failure and readback mismatch never send", async () => {
  for (const mode of ["capacity", "write", "readback"]) {
    const f = fixture(),
      w = await opened(f);
    if (mode === "capacity")
      setJournal(
        f,
        Array.from({ length: 100 }, (_, n) =>
          marker({
            operation_id: `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
            owner_user_id: ids.other,
            target: {
              kind: "test",
              workflowId: `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
            },
          }),
        ),
      );
    else if (mode === "write")
      f.storage.setItem = () => {
        throw new Error("private");
      };
    else f.storage.setItem = () => {};
    await throws(() => create(w), /storage is unavailable/);
    assert.equal(names(f).includes("sendTestEmail"), false);
    assert.equal(w.activity.getSnapshot().storage.status, "blocked");
  }
});

test("validated alias write with failed readback remains locked and explicit recovery can verify that same alias", async () => {
  const f = fixture(),
    w = await opened(f),
    oldGet = f.storage.getItem;
  let failAlias = true;
  f.storage.getItem = (key) => {
    const value = oldGet(key);
    if (key === JOURNAL && failAlias && value?.includes("test_delivery_id")) {
      failAlias = false;
      throw new Error("private");
    }
    return value;
  };
  await create(w);
  assert.equal(operation(w).status, "confirmed_needs_refresh");
  assert.equal(operation(w).current, null);
  assert.equal(operation(w).locked, true);
  assert.equal(w.activity.getSnapshot().storage.status, "blocked");
  await check(w);
  assert.equal(operation(w).current.state, "accepted");
  assert.equal(w.activity.getSnapshot().storage.status, "ready");
  assert.deepEqual(names(f), ["sendTestEmail", "getOperation", "getTestDelivery"]);
});

test("atomic replacement, Dismiss and run cleanup failures retain prior trusted reservation", async () => {
  for (const action of ["replace", "dismiss", "run"]) {
    const f = fixture(),
      w = await opened(f);
    if (action !== "run") {
      f.responses.sendTestEmail = () => delivery("accepted");
      await create(w);
    }
    const stored = f.saved.get(JOURNAL),
      oldSet = f.storage.setItem;
    f.storage.setItem = (key, value) => {
      if (action === "run" && JSON.parse(value).entries.length) return oldSet(key, value);
      throw new Error("private storage error");
    };
    if (action === "replace")
      await throws(
        () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
        /storage/,
      );
    if (action === "dismiss")
      await throws(() => w.activity.dismissTestResult(ids.workflow, ids.operation), /storage/);
    if (action === "run") await w.activity.cancelRun(clone(specimen.cancellation.baseline));
    assert.equal(operation(w, action === "run" ? runTarget : testTarget).locked, true);
    assert.equal(w.activity.getSnapshot().storage.status, "blocked");
    assert.equal(
      names(f).filter((name) => name === "sendTestEmail").length,
      action === "run" ? 0 : 1,
    );
    if (action !== "run") assert.equal(f.saved.get(JOURNAL), stored);
  }
});

test("other owners and legacy journal are preserved and never adopted", async () => {
  const f = fixture(),
    foreign = marker({ operation_id: ids.other, owner_user_id: ids.other });
  setJournal(f, [foreign]);
  f.saved.set("koaryu-workflow-operations-v1", '{"version":1,"entries":[]}');
  const w = await opened(f);
  assert.equal(w.activity.getSnapshot().operations.size, 0);
  await create(w);
  assert.deepEqual(
    markers(f).find((entry) => entry.owner_user_id === ids.other),
    foreign,
  );
  assert.equal(f.saved.get("koaryu-workflow-operations-v1"), '{"version":1,"entries":[]}');
});

for (const status of [400, 404, 409, 413, 422, 429])
  test(`definitive mutation${status} cleans only dispatched marker without replay`, async () => {
    const f = fixture(),
      w = await opened(f);
    f.responses.sendTestEmail = () => {
      throw new ApiError("private rejection", status);
    };
    await create(w);
    assert.equal(operation(w).status, "rejected");
    assert.equal(operation(w).locked, false);
    assert.equal(operation(w).message.includes("private"), false);
    assert.equal(markers(f).length, 0);
    assert.equal(f.calls.length, 1);
  });

for (const status of [401, 402, 403])
  test(`current read/mutation${status} fences and keeps original read denial and durable command`, async () => {
    const f = fixture(),
      w = await opened(f),
      error = new ApiError("fixed denial", status);
    f.responses.listRuns = () => {
      throw error;
    };
    await assert.rejects(w.activity.listRuns(ids.workflow), (actual) => actual === error);
    assert.equal(w.isCurrent(), false);
    const next = await opened(f);
    f.responses.sendTestEmail = () => {
      throw error;
    };
    await assert.rejects(create(next), (actual) => actual === error);
    assert.equal(next.isCurrent(), false);
    assert.equal(markers(f).length, 1);
  });

test("obsolete read401 retries with renewed token; renewed second-attempt denial still remains denial", async () => {
  for (const freshDenied of [false, true]) {
    const f = fixture(),
      w = await opened(f),
      gate = deferred(),
      error = new ApiError("fixed denial", 403);
    f.responses.listRuns = (_identity, _options, token) =>
      token === "token-1"
        ? gate.promise
        : freshDenied
          ? Promise.reject(error)
          : clone(specimen.page);
    const pending = w.activity.listRuns(ids.workflow);
    w.updateToken("token-2");
    gate.reject(new ApiError("obsolete", 401));
    if (freshDenied) await assert.rejects(pending, (actual) => actual === error);
    else assert.equal((await pending).status, "ready");
    assert.deepEqual(
      f.calls.map((call) => call.args[2]),
      ["token-1", "token-2"],
    );
    assert.equal(w.isCurrent(), !freshDenied);
  }
});

test("obsolete mutation401 reconciles current receipt without replaying POST", async () => {
  const f = fixture(),
    w = await opened(f),
    gate = deferred();
  f.responses.sendTestEmail = () => gate.promise;
  const pending = create(w);
  await tick();
  w.updateToken("token-2");
  gate.reject(new ApiError("obsolete", 401));
  await pending;
  assert.deepEqual(names(f), ["sendTestEmail", "getOperation", "getTestDelivery"]);
  assert.equal(f.calls[1].args[1], "token-2");
  assert.equal(operation(w).current.state, "accepted");
});

test("authority ABA and late success/error cannot publish, fence or clean a replacement owner", async () => {
  for (const outcome of ["success", "denied"]) {
    const f = fixture(),
      w = await opened(f),
      gate = deferred();
    f.responses.sendTestEmail = () => gate.promise;
    const pending = create(w);
    await tick();
    const old = operation(w);
    f.auth[0].invalidate();
    const replacement = workspace(f);
    if (outcome === "success") gate.resolve(delivery("accepted"));
    else gate.reject(new ApiError("late denial", 403));
    await pending;
    assert.equal(old.isCurrent(), false);
    assert.equal(replacement.isCurrent(), true);
    assert.equal(operation(replacement).status, "unknown");
    assert.equal(markers(f).length, 1);
    await check(replacement);
    assert.equal(operation(replacement).current.state, "accepted");
  }
});

test("active-studio cookie change fences outstanding checks and held cleanup", async () => {
  const f = fixture(),
    w = await opened(f),
    gate = deferred();
  f.responses.cancelRun = () => gate.promise;
  const pending = w.activity.cancelRun(clone(specimen.cancellation.baseline));
  await tick();
  f.setStudio(ids.other);
  gate.resolve(clone(specimen.cancellation.result));
  await pending;
  assert.equal(w.isCurrent(), false);
  assert.equal(markers(f).length, 1);
  assert.deepEqual(names(f), ["cancelRun"]);
});

test("independent target checks and ordinary list/detail reads never strand each other checking", async () => {
  const f = fixture(),
    w = await opened(f),
    runGate = deferred(),
    testGate = deferred();
  f.responses.cancelRun = f.responses.sendTestEmail = () => {
    throw new CommandOutcomeUnknown();
  };
  await create(w);
  await w.activity.cancelRun(clone(specimen.cancellation.baseline));
  f.responses.getOperation = (identity) =>
    identity.command === "run.cancel" ? runGate.promise : testGate.promise;
  const runCheck = check(w, runTarget),
    testCheck = check(w);
  assert.equal(check(w), testCheck);
  await tick();
  await w.activity.listRuns(ids.workflow);
  await w.activity.getRun(ids.workflow, ids.run);
  runGate.resolve(receipt(operation(w, runTarget).operationId, "run.cancel"));
  await runCheck;
  testGate.resolve(receipt());
  await testCheck;
  assert.equal(operation(w, runTarget).status, "confirmed");
  assert.equal(operation(w).status, "confirmed");
});

test("simulation invalidates on semantics, source, newer request and workflow change; layout/metadata preserve it", async () => {
  const f = fixture(),
    w = await opened(f);
  const result = await w.activity.simulate(ids.workflow, graph(), { kind: "synthetic" });
  w.edit({ kind: "metadata", description: "New description" });
  w.edit({ kind: "commit_position", node_id: nodeId, position: { x: 20, y: 30 } });
  assert.equal(result.isCurrent(), true);
  const gate = deferred();
  f.responses.simulate = () => gate.promise;
  const pending = w.activity.simulate(ids.workflow, graph(), { kind: "synthetic" });
  assert.equal(result.isCurrent(), false);
  w.edit({
    kind: "update_config",
    node_id: nodeId,
    update: {
      type: "email",
      config: {
        ...graph().nodes.find((node) => node.id === nodeId).config,
        subject_template: "Changed",
      },
    },
  });
  gate.resolve(clone(specimen.simulations[0].response));
  assert.equal((await pending).status, "stale");
  f.responses.simulate = () => clone(specimen.simulations[0].response);
  const currentGraph = w.getSnapshot().editor.history.present.graph;
  const source = await w.activity.simulate(ids.workflow, currentGraph, { kind: "synthetic" });
  w.activity.invalidateSimulation();
  assert.equal(source.isCurrent(), false);
  const next = await w.activity.simulate(ids.workflow, currentGraph, { kind: "synthetic" });
  await w.openWorkflow(ids.other, true);
  assert.equal(next.isCurrent(), false);
  assert.equal(f.allocations, 0);
  assert.equal(f.writes.length, 0);
});

test("simulation delegated unknown is fixed read failure with zero UUID/journal/receipt; large finite graph reaches backend", async () => {
  const f = fixture(),
    w = await opened(f, clone(specimen.graphs.large_finite));
  f.responses.simulate = () => {
    throw new CommandOutcomeUnknown(ids.operation, "private");
  };
  await assert.rejects(
    w.activity.simulate(ids.workflow, clone(specimen.graphs.large_finite), { kind: "synthetic" }),
    (error) =>
      error instanceof ApiError && error.status === 503 && !error.message.includes("private"),
  );
  f.responses.simulate = () => clone(specimen.simulations.at(-1).response);
  assert.equal(
    (
      await w.activity.simulate(ids.workflow, clone(specimen.graphs.large_finite), {
        kind: "synthetic",
      })
    ).value.valid,
    false,
  );
  assert.deepEqual(names(f), ["simulate", "simulate"]);
  assert.equal(f.allocations, 0);
  assert.equal(f.writes.length, 0);
});

test("new explicit reads invalidate old rows while independent resources stay current", async () => {
  const f = fixture(),
    w = workspace(f);
  const list = await w.activity.listRuns(ids.workflow),
    detail = await w.activity.getRun(ids.workflow, ids.run);
  f.responses.listRuns = () => {
    throw new Error("private network");
  };
  await assert.rejects(w.activity.listRuns(ids.workflow), /could not be loaded/);
  assert.equal(list.isCurrent(), false);
  assert.equal(detail.isCurrent(), true);
  assert.equal(Object.isFrozen(detail.value.run), true);
});

test("preview tools reject with fixed live-only copy and zero storage, API or UUID I/O", async () => {
  const f = fixture();
  f.dependencies.storage = f.dependencies.uuid = () => assert.fail("preview I/O");
  const w = createWorkflowWorkspace(
    {
      mode: "preview",
      source: {
        catalog: clone(activityCatalog),
        list: { items: [], next_cursor: null, has_more: false },
        details: { [ids.workflow]: workflowDetail() },
      },
    },
    f.dependencies,
  );
  const a = w.activity;
  for (const call of [
    () => a.checkStorage(),
    () => a.invalidateSimulation(),
    () => a.simulate(ids.workflow, graph(), { kind: "synthetic" }),
    () => a.listRuns(ids.workflow),
    () => a.getRun(ids.workflow, ids.run),
    () => a.cancelRun(clone(specimen.cancellation.baseline)),
    () => a.createTest(ids.workflow, graph(), nodeId),
    () => a.checkResult(testTarget),
    () => a.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
    () => a.dismissTestResult(ids.workflow, ids.operation),
  ])
    await throws(call, /Live actions are unavailable in preview/);
  assert.equal(a.getSnapshot().storage.status, "inactive");
  assert.equal(f.calls.length, 0);
});

test("local invalid node/graph/CAS/capability creates no request, marker or UUID", async () => {
  const f = fixture(),
    w = await opened(f),
    different = graph();
  different.nodes.find((node) => node.id === nodeId).config.subject_template = "different";
  for (const call of [
    () => w.activity.createTest(ids.workflow, graph(), "missing"),
    () => create(w, different),
    () => w.activity.createTest(ids.other, graph(), nodeId),
    () => w.activity.cancelRun(clone(specimen.cancellation.result)),
    () => w.activity.cancelRun(null),
  ])
    await throws(call, Error);
  f.api.catalog = async () => ({
    ...clone(activityCatalog),
    capabilities: { can_start: false, can_test_email: false, disabled_reason: "disabled" },
  });
  await w.loadCatalog();
  await throws(() => create(w), /unavailable/);
  assert.equal(f.allocations, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test("direct wrong IDs and current wrong IDs cannot establish current truth", async () => {
  for (const command of ["run.cancel", "test_email.create"]) {
    const f = fixture(),
      w = await opened(f),
      run = command === "run.cancel",
      target = run ? runTarget : testTarget;
    const wrong = run ? clone(specimen.cancellation.result) : delivery();
    if (run) wrong.run.id = ids.other;
    else wrong.operation_id = ids.other;
    f.responses[run ? "cancelRun" : "sendTestEmail"] = () => wrong;
    await (run ? w.activity.cancelRun(clone(specimen.cancellation.baseline)) : create(w));
    assert.equal(operation(w, target).status, "unknown");
    f.responses[run ? "getRun" : "getTestDelivery"] = () => wrong;
    await check(w, target);
    assert.equal(operation(w, target).status, "confirmed_needs_refresh");
    assert.equal(operation(w, target).current, null);
    assert.equal(operation(w, target).locked, true);
  }
});

test("receipt/current denials preserve exact errors after fencing and retain durable recovery", async () => {
  for (const status of [401, 402, 403])
    for (const stage of ["receipt", "current", "direct-run-current"]) {
      const f = fixture(),
        w = await opened(f),
        error = new ApiError("fixed denial", status);
      if (stage === "direct-run-current") {
        f.responses.getRun = () => {
          throw error;
        };
        await assert.rejects(
          w.activity.cancelRun(clone(specimen.cancellation.baseline)),
          (actual) => actual === error,
        );
      } else {
        await create(w);
        f.responses[stage === "receipt" ? "getOperation" : "getTestDelivery"] = () => {
          throw error;
        };
        await assert.rejects(check(w), (actual) => actual === error);
      }
      assert.equal(w.isCurrent(), false);
      assert.equal(markers(f).length, 1);
      assert.equal(w.activity.getSnapshot().operations.size, 0);
    }
});

test("explicit storage recovery finishes only its own cleanup or restores an unsent replacement", async () => {
  for (const action of ["replace", "dismiss", "run"]) {
    const f = fixture(),
      w = await opened(f),
      oldGet = f.storage.getItem,
      oldSet = f.storage.setItem;
    if (action !== "run") {
      f.responses.sendTestEmail = () => delivery("accepted");
      await create(w);
    }
    let unreadable = false,
      fail = true;
    f.storage.setItem = (key, value) => {
      oldSet(key, value);
      if (key === JOURNAL && (action !== "run" || JSON.parse(value).entries.length === 0))
        unreadable = true;
    };
    f.storage.getItem = (key) => {
      if (key === JOURNAL && unreadable && fail) {
        fail = false;
        throw new Error("readback failed");
      }
      return oldGet(key);
    };
    if (action === "replace")
      await throws(
        () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
        /storage/,
      );
    if (action === "dismiss")
      await throws(() => w.activity.dismissTestResult(ids.workflow, ids.operation), /storage/);
    if (action === "run") await w.activity.cancelRun(clone(specimen.cancellation.baseline));
    const target = action === "run" ? runTarget : testTarget;
    assert.equal(operation(w, target).operationId, ids.operation);
    assert.equal(operation(w, target).locked, true);
    const calls = f.calls.length;
    await w.activity.checkStorage();
    assert.equal(w.activity.getSnapshot().storage.status, "ready");
    assert.equal(f.calls.length, calls);
    if (action === "dismiss") assert.equal(operation(w), undefined);
    else assert.equal(operation(w, target).status, "confirmed");
    if (action === "run") assert.equal(operation(w, target).locked, false);
    if (action === "replace") {
      assert.equal(operation(w).locked, true);
      assert.equal(operation(w).operationId, ids.operation);
      assert.equal(markers(f)[0].operation_id, ids.operation);
      assert.equal(markers(f)[0].test_delivery_id, ids.delivery);
    } else assert.equal(markers(f).length, 0);
    assert.equal(
      names(f).filter((name) => name === "sendTestEmail").length,
      action === "run" ? 0 : 1,
    );
  }
});

test("Check result preserves run404/rejection status and completes terminal Dismiss after its own failed readback", async () => {
  for (const action of ["run404", "rejection", "dismiss"]) {
    const f = fixture(),
      w = await opened(f);
    if (action === "dismiss") {
      f.responses.sendTestEmail = () => delivery("accepted");
      await create(w);
    }
    failReadback(f, (entries) => entries.length === 0);
    if (action === "run404") {
      f.responses.getRun = () => {
        throw new ApiError("missing", 404);
      };
      await w.activity.cancelRun(clone(specimen.cancellation.baseline));
    } else if (action === "rejection") {
      f.responses.sendTestEmail = () => {
        throw new ApiError("not accepted", 422);
      };
      await create(w);
    } else await throws(() => w.activity.dismissTestResult(ids.workflow, ids.operation), /storage/);
    const count = f.calls.length,
      target = action === "run404" ? runTarget : testTarget;
    assert.equal(operation(w, target).locked, true);
    await check(w, target);
    assert.equal(f.calls.length, count);
    assert.equal(w.activity.getSnapshot().storage.status, "ready");
    assert.equal(markers(f).length, 0);
    if (action === "dismiss") assert.equal(operation(w), undefined);
    else {
      assert.equal(operation(w, target).status, action === "run404" ? "unavailable" : "rejected");
      assert.equal(operation(w, target).locked, false);
    }
  }
});

test("unsent replacement recovery preserves other owners and exact prior marker when write never changed it", async () => {
  for (const failure of ["write", "readback"]) {
    const f = fixture(),
      foreign = marker({ owner_user_id: ids.other, operation_id: ids.other });
    setJournal(f, [foreign]);
    const w = await opened(f);
    f.responses.sendTestEmail = () => delivery("unknown");
    await create(w);
    const before = clone(markers(f)),
      set = f.storage.setItem;
    if (failure === "write")
      f.storage.setItem = () => {
        throw new Error("write failed");
      };
    else failReadback(f);
    await throws(
      () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
      /storage/,
    );
    if (failure === "write") f.storage.setItem = set;
    await check(w);
    assert.deepEqual(markers(f), before);
    assert.equal(operation(w).operationId, ids.operation);
    assert.equal(operation(w).current.state, "unknown");
    assert.match(operation(w).message, /will not be retried/);
    assert.equal(f.calls.length, 1);
  }
});

test("own storage proof cannot reconcile arbitrary absence or unrelated same-target markers", async () => {
  for (const action of ["cleanup", "replacement", "absence-before-attempt"]) {
    const f = fixture(),
      w = await opened(f);
    f.responses.sendTestEmail = () => delivery("accepted");
    await create(w);
    if (action === "absence-before-attempt") setJournal(f, []);
    else failReadback(f);
    await throws(
      () =>
        action === "replacement"
          ? w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation)
          : w.activity.dismissTestResult(ids.workflow, ids.operation),
      /storage/,
    );
    if (action !== "absence-before-attempt")
      setJournal(f, [marker({ operation_id: ids.subject, test_delivery_id: ids.delivery })]);
    const before = f.saved.get(JOURNAL);
    await w.activity.checkStorage();
    await check(w);
    assert.equal(w.activity.getSnapshot().storage.status, "blocked");
    assert.equal(operation(w).operationId, ids.operation);
    assert.equal(operation(w).locked, true);
    assert.equal(f.saved.get(JOURNAL), before);
    await w.openWorkflow(ids.other, true);
    await throws(() => w.activity.createTest(ids.other, graph(), nodeId), /storage/);
    assert.equal(f.calls.length, 1);
  }
});

test("authority fencing erases unsent replacement proof; reload and another owner cannot restore it", async () => {
  const f = fixture(),
    w = await opened(f);
  f.responses.sendTestEmail = () => delivery("accepted");
  await create(w);
  failReadback(f);
  await throws(
    () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
    /storage/,
  );
  const candidate = markers(f)[0].operation_id;
  f.auth[0].invalidate();
  await throws(() => w.activity.checkStorage(), /administrator/);
  const other = workspace(f, { ...scope, userId: ids.other });
  assert.equal(other.activity.getSnapshot().operations.size, 0);
  const reloaded = workspace(f);
  f.responses.getOperation = () => {
    throw new ApiError("missing", 404);
  };
  await reloaded.activity.checkStorage();
  await check(reloaded);
  assert.equal(operation(reloaded).status, "unknown");
  assert.equal(operation(reloaded).operationId, candidate);
  assert.equal(operation(reloaded).locked, true);
  assert.equal(markers(f)[0].operation_id, candidate);
  assert.equal(names(f).filter((name) => name === "sendTestEmail").length, 1);
});

test("an invoked replacement with a lost response never rolls back through storage recovery", async () => {
  const f = fixture(),
    w = await opened(f);
  f.responses.sendTestEmail = () => delivery("accepted");
  await create(w);
  f.responses.sendTestEmail = () => {
    throw new CommandOutcomeUnknown();
  };
  await w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation);
  const candidate = operation(w).operationId;
  f.responses.getOperation = () => {
    throw new ApiError("missing", 404);
  };
  await w.activity.checkStorage();
  await check(w);
  assert.equal(operation(w).operationId, candidate);
  assert.equal(operation(w).status, "unknown");
  assert.equal(operation(w).locked, true);
  assert.equal(markers(f)[0].operation_id, candidate);
  assert.equal(names(f).filter((name) => name === "sendTestEmail").length, 2);
});

test("authority loss while reading a repair prevents its storage write", async () => {
  const f = fixture(),
    w = await opened(f);
  f.responses.sendTestEmail = () => delivery("accepted");
  await create(w);
  failReadback(f);
  await throws(
    () => w.activity.createAnotherTest(ids.workflow, graph(), nodeId, ids.operation),
    /storage/,
  );
  const before = f.saved.get(JOURNAL),
    writes = f.writes.length,
    get = f.storage.getItem;
  let fence = true;
  f.storage.getItem = (key) => {
    if (key === JOURNAL && fence) {
      fence = false;
      f.auth[0].invalidate();
    }
    return get(key);
  };
  await w.activity.checkStorage();
  assert.equal(w.isCurrent(), false);
  assert.equal(f.saved.get(JOURNAL), before);
  assert.equal(f.writes.length, writes);
  const next = workspace(f);
  assert.equal(operation(next).operationId, markers(f)[0].operation_id);
  assert.equal(operation(next).status, "unknown");
});

test("held cleanup/current and obsolete read errors do not touch a replacement owner's reservation", async () => {
  for (const outcome of ["current-success", "current-denial", "list-denial"]) {
    const f = fixture(),
      w = await opened(f),
      gate = deferred();
    const isList = outcome === "list-denial";
    f.responses[isList ? "listRuns" : "getRun"] = () => gate.promise;
    const pending = isList
      ? w.activity.listRuns(ids.workflow)
      : w.activity.cancelRun(clone(specimen.cancellation.baseline));
    await tick();
    f.auth[0].invalidate();
    const next = workspace(f);
    if (outcome === "current-success") gate.resolve(clone(specimen.cancellation.result));
    else gate.reject(new ApiError("obsolete", 403));
    const result = await pending;
    if (isList) assert.equal(result.status, "stale");
    else {
      assert.equal(markers(f).length, 1);
      assert.equal(operation(next, runTarget).status, "unknown");
    }
    assert.equal(next.isCurrent(), true);
  }
});

test("pending run joins even a now-uncancellable accepted DTO; subscriber reactivation joins settlement", async () => {
  const f = fixture(),
    w = await opened(f),
    gate = deferred();
  f.responses.cancelRun = () => gate.promise;
  let nested;
  const unsubscribe = w.activity.subscribe(() => {
    if (operation(w, runTarget)?.status === "submitting")
      nested = w.activity.cancelRun(clone(specimen.cancellation.result));
  });
  const first = w.activity.cancelRun(clone(specimen.cancellation.baseline));
  assert.equal(nested, first);
  unsubscribe();
  gate.resolve(clone(specimen.cancellation.result));
  await first;
  assert.equal(f.allocations, 1);
});

test("terminal unknown keeps its nonretry copy after optional current refresh failure", async () => {
  const f = fixture(),
    w = await opened(f);
  f.responses.sendTestEmail = () => delivery("unknown");
  await create(w);
  f.responses.getTestDelivery = () => {
    throw new ApiError("temporary", 503);
  };
  await check(w);
  assert.equal(operation(w).status, "confirmed");
  assert.match(operation(w).message, /may have been accepted.*will not be retried/);
  await w.activity.dismissTestResult(ids.workflow, ids.operation);
});

test("network,5xx and post-dispatch abort remain unknown without replay", async () => {
  for (const error of [
    new Error("private network"),
    new ApiError("private server", 503),
    new DOMException("private abort", "AbortError"),
  ]) {
    const f = fixture(),
      w = await opened(f);
    f.responses.sendTestEmail = () => {
      throw error;
    };
    await create(w);
    assert.equal(operation(w).status, "unknown");
    assert.equal(operation(w).locked, true);
    assert.equal(operation(w).message.includes("private"), false);
    assert.equal(f.calls.length, 1);
  }
});
