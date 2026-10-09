import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
register("./helpers/path-alias-loader.mjs", import.meta.url);
const { createWorkflowWorkspace, WORKFLOW_JOURNAL_KEY } =
  await import("../src/lib/automation-workflow-workspace-controller.ts");
const { ApiError, CommandOutcomeUnknown } = await import("../src/lib/api.ts");
const { workflowEditorDirty } = await import("../src/lib/automation-workflow-workspace-state.ts");
import {
  ids,
  owner,
  detail,
  catalog,
  receipt,
  fixture,
  deferred,
  tick,
  sizedRequest,
} from "./helpers/workflow-workspace-fixture.mjs";
const target = { kind: "draft", id: ids.draft };
const existing = { kind: "workflow", id: ids.workflow };
const key = (target) => `${target.kind}:${target.id}`;
const workspace = (f, scope = owner) =>
  createWorkflowWorkspace({ mode: "live", owner: scope, token: "token-1" }, f.dependencies);
const op = (w, target = target) => w.getSnapshot().operations[key(target)];
function markers(f) {
  return JSON.parse(f.saved.get(WORKFLOW_JOURNAL_KEY) ?? '{"entries":[]}').entries;
}

// A real component mounting this owner is covered separately by the Chromium test.
test("same-marker double click, detach, token renewal and create→save→save preserve command ownership", async () => {
  const f = fixture(),
    w = workspace(f),
    gate = deferred();
  let current = detail();
  f.api.create = async (request) => {
    f.calls.push({ name: "create", args: [request] });
    return gate.promise;
  };
  f.api.detail = async () => current;
  w.openNew(ids.draft);
  w.edit({ kind: "metadata", name: "A" });
  const unsubscribe = w.subscribe(() => {});
  const handle = w.submit("workflow.create");
  unsubscribe();
  w.updateToken("token-2");
  assert.equal(w.submit("workflow.create"), handle);
  assert.equal(f.allocations, 1);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(markers(f)[0]).sort(), [
    "command",
    "operation_id",
    "owner_studio_id",
    "owner_user_id",
    "target",
  ]);
  current = detail({ name: "A" });
  gate.resolve(current);
  await handle.settled;
  assert.equal(w.getSnapshot().editor.workflowId, ids.workflow);
  assert.equal(op(w, target).status, "resolved");
  assert.equal(await w.openWorkflow(ids.workflow), "opened");
  for (const revision of [2, 3]) {
    w.edit({ kind: "metadata", name: `Save ${revision}` });
    current = detail({ name: `Save ${revision}`, revision });
    f.api.save = async (_id, request) => {
      assert.equal(request.expected_revision, revision - 1);
      return current;
    };
    await w.submit("workflow.save").settled;
    assert.equal(w.getSnapshot().editor.baseline.revision, revision);
    assert.equal(workflowEditorDirty(w.getSnapshot().editor), false);
  }
  assert.equal(markers(f).length, 0);
});

test("unknown create stays locked through missing and wrong receipts, then resolves using current detail", async () => {
  const f = fixture(),
    w = workspace(f);
  f.api.create = async () => {
    throw new CommandOutcomeUnknown();
  };
  w.openNew(ids.draft);
  const handle = w.submit("workflow.create");
  await handle.settled;
  assert.equal(w.getSnapshot().editor.workflowId, null);
  for (const response of [
    new ApiError("Missing", 404),
    receipt(handle.operationId, "workflow.pause"),
    { ...receipt(handle.operationId), entity_id: ids.other },
    receipt(ids.other),
  ]) {
    f.api.operation = async () => {
      if (response instanceof Error) throw response;
      return response;
    };
    await w.reconcile(target);
    assert.equal(op(w, target).locked, true);
    assert.equal(w.submit("workflow.create"), handle);
  }
  f.api.operation = async () => receipt(handle.operationId);
  f.api.detail = async () => detail({ revision: 4, status: "archived", name: "Current" });
  await w.reconcile(target);
  assert.equal(op(w, target).status, "resolved");
  assert.equal(w.getSnapshot().editor.latest.status, "archived");
  assert.equal(w.getSnapshot().editor.conflict, true);
  assert.equal(f.allocations, 1);
});

test("committed receipt remains locked when current detail fails or is stale", async () => {
  const f = fixture(),
    w = workspace(f);
  await w.openWorkflow(ids.workflow);
  f.api.save = async () => {
    throw new CommandOutcomeUnknown();
  };
  const handle = w.submit("workflow.save");
  await handle.settled;
  f.api.operation = async () =>
    receipt(handle.operationId, "workflow.save", detail({ revision: 3 }));
  for (const current of [
    new ApiError("Missing", 404),
    detail({ revision: 2 }),
    detail({ id: ids.other, revision: 3 }),
  ]) {
    f.api.detail = async () => {
      if (current instanceof Error) throw current;
      return current;
    };
    await w.reconcile(existing);
    assert.equal(op(w, existing).status, "committed_needs_detail");
    assert.equal(op(w, existing).locked, true);
  }
  f.api.detail = async () => detail({ revision: 3 });
  await w.reconcile(existing);
  assert.equal(op(w, existing).status, "resolved");
});

test("reload adopts only same-owner markers and preserves edits made during create recovery", async () => {
  for (const changed of [false, true]) {
    const f = fixture(),
      first = workspace(f);
    f.api.create = async () => {
      throw new CommandOutcomeUnknown();
    };
    first.openNew(ids.draft);
    const handle = first.submit("workflow.create");
    await handle.settled;
    const other = workspace(f, { ...owner, userId: ids.other });
    other.openNew(ids.draft);
    assert.equal(Object.keys(other.getSnapshot().operations).length, 0);
    assert.throws(() => workspace(f, { ...owner, role: "front_desk" }), /administrator/);
    const reloaded = workspace(f);
    reloaded.openNew(ids.draft);
    if (changed) reloaded.edit({ kind: "metadata", name: "Recovery edit" });
    f.api.operation = async () => receipt(handle.operationId);
    await reloaded.reconcile(target);
    assert.equal(reloaded.getSnapshot().editor.name, changed ? "Recovery edit" : "Welcome");
    assert.equal(workflowEditorDirty(reloaded.getSnapshot().editor), changed);
    assert.equal(f.allocations, 1);
  }
});

test("access invalidation fences old callbacks and hides protected state across ABA", async () => {
  for (const reason of ["signout", "user", "studio", "role", "entitlement"]) {
    const f = fixture(),
      w = workspace(f),
      gate = deferred();
    f.api.create = async () => gate.promise;
    w.openNew(ids.draft);
    const handle = w.submit("workflow.create");
    await tick();
    f.auth[0].invalidate();
    assert.equal(w.getSnapshot().editor, null, reason);
    assert.deepEqual(w.getSnapshot().operations, {}, reason);
    const returned = workspace(f);
    returned.openNew(ids.draft);
    gate.resolve(detail());
    await handle.settled;
    assert.equal(w.isCurrent(), false);
    assert.equal(returned.getSnapshot().editor.workflowId, null);
    assert.equal(op(returned, target).status, "unknown");
    assert.equal(markers(f).length, 1);
  }
});

test("cookie mismatch and mutated caller identity cannot redirect a command", async () => {
  const f = fixture(),
    mutable = { ...owner },
    w = workspace(f, mutable);
  mutable.studioId = ids.other;
  mutable.userId = ids.other;
  w.openNew(ids.draft);
  f.api.create = async () => {
    throw new CommandOutcomeUnknown();
  };
  await w.submit("workflow.create").settled;
  assert.equal(markers(f)[0].owner_studio_id, owner.studioId);
  assert.equal(markers(f)[0].owner_user_id, owner.userId);
  const f2 = fixture(),
    w2 = workspace(f2);
  w2.openNew(ids.draft);
  f2.setStudio(ids.other);
  assert.throws(() => w2.submit("workflow.create"), /studio changed/);
  assert.equal(f2.calls.length, 0);
  assert.equal(markers(f2).length, 0);
  assert.equal(w2.getSnapshot().editor, null);
});

test("save A after local edit B, lifecycle actions and obsolete reads preserve current edits", async () => {
  const f = fixture(),
    w = workspace(f),
    save = deferred(),
    read = deferred();
  await w.openWorkflow(ids.workflow);
  f.api.detail = async () => read.promise;
  const oldRead = w.loadDetail();
  w.edit({ kind: "metadata", name: "A" });
  f.api.save = async (_id, body) => {
    assert.equal(body.name, "A");
    return save.promise;
  };
  const command = w.submit("workflow.save");
  await tick();
  w.edit({ kind: "metadata", name: "B" });
  f.api.detail = async () => detail({ name: "A", revision: 2 });
  save.resolve(detail({ name: "A", revision: 2 }));
  await command.settled;
  read.resolve(detail({ name: "Obsolete", revision: 1 }));
  await oldRead;
  assert.equal(w.getSnapshot().editor.name, "B");
  assert.equal(w.getSnapshot().editor.baseline.revision, 2);
  assert.equal(w.getSnapshot().editor.latest.revision, 2);
  assert.equal(workflowEditorDirty(w.getSnapshot().editor), true);
  assert.throws(() => w.submit("workflow.publish"), /Save or explicitly discard/);
  f.api.pause = async () => detail({ revision: 3, status: "paused" });
  f.api.detail = f.api.pause;
  await w.submit("workflow.pause").settled;
  assert.equal(w.getSnapshot().editor.name, "B");
  assert.equal(w.getSnapshot().editor.baseline.revision, 3);
});

test("409 preserves dirty content and exposes conflict; disabled start leaves save, pause and recovery usable", async () => {
  const f = fixture(),
    w = workspace(f);
  await w.loadCatalog();
  await w.openWorkflow(ids.workflow);
  assert.throws(() => w.submit("workflow.start"), /Sending is disabled/);
  w.edit({ kind: "metadata", name: "Dirty" });
  f.api.save = async () => {
    throw new ApiError("Conflict", 409);
  };
  await w.submit("workflow.save").settled;
  assert.equal(op(w, existing).status, "definitely_rejected");
  assert.equal(w.getSnapshot().editor.name, "Dirty");
  assert.equal(w.getSnapshot().editor.conflict, true);
  await w.openWorkflow(ids.workflow, true);
  f.api.pause = async () => {
    throw new CommandOutcomeUnknown();
  };
  const pause = w.submit("workflow.pause");
  await pause.settled;
  f.api.operation = async () =>
    receipt(pause.operationId, "workflow.pause", detail({ revision: 2, status: "paused" }));
  f.api.detail = async () => detail({ revision: 2, status: "paused" });
  await w.reconcile(existing);
  assert.equal(op(w, existing).status, "resolved");
});

test("journal corruption, quota failures and cap100 refuse dispatch but permit editing and reads", async () => {
  for (const bad of [
    "invalid json",
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":[{"operation_id":"bad"}]}',
  ]) {
    const f = fixture();
    f.saved.set(WORKFLOW_JOURNAL_KEY, bad);
    const w = workspace(f);
    w.openNew(ids.draft);
    w.edit({ kind: "metadata", name: "Editable" });
    assert.throws(() => w.submit("workflow.create"));
    await w.loadCatalog();
    assert.equal(f.calls.filter((call) => call.name === "create").length, 0);
    assert.equal(f.saved.get(WORKFLOW_JOURNAL_KEY), bad);
  }
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  f.storage.setItem = () => {
    throw new Error("Quota exceeded");
  };
  assert.throws(() => w.submit("workflow.create"), /Quota/);
  assert.equal(f.calls.length, 0);
  f.storage.setItem = (key, value) => f.saved.set(key, value);
  const entries = Array.from({ length: 100 }, (_, i) => ({
    operation_id: `60000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
    command: "workflow.create",
    target: { kind: "draft", id: `70000000-0000-4000-8000-${String(i).padStart(12, "0")}` },
    owner_user_id: ids.other,
    owner_studio_id: ids.studio,
  }));
  f.saved.set(WORKFLOW_JOURNAL_KEY, JSON.stringify({ version: 1, entries }));
  assert.throws(() => w.submit("workflow.create"), /100 recovery/);
  assert.deepEqual(markers(f), entries);
});

test("cleanup persistence failure keeps exact lock across reload, then receipt recovery clears only its own marker", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  const originalSet = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    if (JSON.parse(value).entries.length === 0) throw new Error("Storage unavailable");
    originalSet(key, value);
  };
  const handle = w.submit("workflow.create");
  await handle.settled;
  assert.equal(op(w, target).locked, true);
  assert.equal(w.submit("workflow.create"), handle);
  const reloaded = workspace(f);
  reloaded.openNew(ids.draft);
  assert.equal(op(reloaded, target).operationId, handle.operationId);
  f.storage.setItem = originalSet;
  f.api.operation = async () => receipt(handle.operationId);
  await reloaded.reconcile(target);
  assert.equal(markers(f).length, 0);
  assert.equal(op(reloaded, target).locked, false);
});

test("newer read owns loading/error and validation belongs to exact editor generation", async () => {
  const f = fixture(),
    w = workspace(f),
    first = deferred(),
    second = deferred();
  w.openNew(ids.draft);
  f.api.validate = () => first.promise;
  const old = w.validate();
  w.edit({ kind: "metadata", name: "Changed" });
  f.api.validate = () => second.promise;
  const latest = w.validate();
  first.reject(new Error("Old error"));
  await old;
  assert.equal(w.getSnapshot().reads.validation.loading, true);
  assert.equal(w.getSnapshot().reads.validation.error, null);
  second.resolve({ valid: false, issues: [] });
  await latest;
  assert.equal(w.getSnapshot().editor.validation.generation, w.getSnapshot().editor.generation);
  assert.equal(w.getSnapshot().reads.validation.loading, false);
});

test("target switch requires explicit discard; old callback cannot acknowledge replacement content", async () => {
  const f = fixture(),
    w = workspace(f),
    wait = deferred();
  w.openNew(ids.draft);
  assert.equal(await w.openWorkflow(ids.workflow), "discard_required");
  f.api.create = () => wait.promise;
  const handle = w.submit("workflow.create");
  await tick();
  w.openNew(
    ids.draft,
    {
      name: "Replacement",
      description: "",
      graph: detail().draft_graph,
      layout: detail().draft_layout,
    },
    true,
  );
  wait.resolve(detail());
  await handle.settled;
  assert.equal(w.getSnapshot().editor.name, "Replacement");
});

test("oversized full command fails before journal and fetch while server413/422 retain original attempt identity", async () => {
  const f = fixture(),
    w = workspace(f),
    big = sizedRequest(1_048_577);
  w.openNew(ids.draft, big);
  assert.throws(
    () => w.submit("workflow.create"),
    (error) => error.status === 413,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.size, 0);
  for (const status of [413, 422]) {
    const f = fixture(),
      w = workspace(f);
    w.openNew(ids.draft);
    f.api.create = async (body) => {
      assert.equal(body.operation_id, handle.operationId);
      throw new ApiError("Rejected", status);
    };
    const handle = w.submit("workflow.create");
    await handle.settled;
    assert.equal(op(w, target).operationId, handle.operationId);
    assert.equal(op(w, target).status, "definitely_rejected");
    assert.equal(f.allocations, 1);
  }
});

test("preview branches before every API/auth/journal dependency and cannot fall back from live errors", async () => {
  const bomb = new Proxy(
    {},
    {
      get: () => {
        throw new Error("Live dependency used");
      },
    },
  );
  const w = createWorkflowWorkspace(
    {
      mode: "preview",
      source: {
        catalog: {
          ...catalog,
          capabilities: { can_start: true, can_test_email: true, disabled_reason: null },
        },
        list: { items: [], next_cursor: null, has_more: false },
        details: { [ids.workflow]: detail() },
      },
    },
    bomb,
  );
  await w.openWorkflow(ids.workflow);
  w.edit({ kind: "metadata", name: "Preview edit" });
  await w.loadCatalog();
  await w.loadList();
  await w.loadDetail();
  assert.equal(w.getSnapshot().catalog.capabilities.can_start, false);
  assert.equal(w.getSnapshot().catalog.capabilities.can_test_email, false);
  assert.throws(() => w.submit("workflow.start"), /preview/);
  assert.throws(() => w.reconcile(existing), /preview/);
  await assert.rejects(w.validate(), /preview/);
  const f = fixture(),
    live = workspace(f);
  f.api.catalog = async () => {
    throw new ApiError("Unavailable", 503);
  };
  await live.loadCatalog();
  assert.equal(live.getSnapshot().catalog, null);
  assert.equal(live.getSnapshot().mode, "live");
});

test("an old receipt cannot regress a newer baseline; unseen server edits still expose conflict", async () => {
  for (const initialRevision of [3, 5]) {
    const f = fixture();
    f.saved.set(
      WORKFLOW_JOURNAL_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            operation_id: ids.other,
            command: "workflow.save",
            target: existing,
            owner_user_id: ids.user,
            owner_studio_id: ids.studio,
          },
        ],
      }),
    );
    f.api.detail = async () => detail({ revision: initialRevision });
    const w = workspace(f);
    await w.openWorkflow(ids.workflow);
    w.edit({ kind: "metadata", name: "Local edit" });
    f.api.operation = async () =>
      receipt(ids.other, "workflow.save", detail({ revision: 4, name: "Original" }));
    f.api.detail = async () => detail({ revision: 5 });
    await w.reconcile(existing);
    assert.equal(w.getSnapshot().editor.name, "Local edit");
    assert.equal(w.getSnapshot().editor.baseline.revision, initialRevision === 5 ? 5 : 4);
    assert.equal(w.getSnapshot().editor.conflict, initialRevision === 3);
  }
});

test("malformed success remains unknown and malformed readiness never enables start", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  f.api.create = async () => ({ ...detail(), revision: 2 });
  const handle = w.submit("workflow.create");
  await handle.settled;
  assert.equal(op(w, target).status, "unknown");
  assert.equal(markers(f).length, 1);
  f.api.catalog = async () => ({
    ...catalog,
    capabilities: { ...catalog.capabilities, can_start: "true" },
  });
  await w.loadCatalog();
  assert.equal(w.getSnapshot().catalog, null);
  assert.match(w.getSnapshot().reads.catalog.error, /unavailable/);
});

test("confirmed create identity also locks its discovered workflow while detail recovery is pending", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  f.api.detail = async () => {
    throw new ApiError("Temporarily missing", 404);
  };
  const handle = w.submit("workflow.create");
  await handle.settled;
  assert.equal(op(w, target).status, "committed_needs_detail");
  f.api.detail = async () => detail();
  await w.openWorkflow(ids.workflow, true);
  assert.equal(w.submit("workflow.save"), handle);
  assert.equal(w.submit("workflow.pause"), handle);
  assert.equal(f.allocations, 1);
  await w.reconcile(target);
  assert.equal(op(w, target).locked, false);
});

test("reload reserves confirmed create alias and unidentified creates fence new owner commands", async () => {
  const f = fixture(),
    first = workspace(f);
  first.openNew(ids.draft);
  f.api.detail = async () => {
    throw new ApiError("Pending detail", 404);
  };
  const handle = first.submit("workflow.create");
  await handle.settled;
  assert.equal(markers(f)[0].workflow_id, ids.workflow);
  const reloaded = workspace(f);
  f.api.detail = async () => detail();
  await reloaded.openWorkflow(ids.workflow);
  assert.equal(reloaded.submit("workflow.save").operationId, handle.operationId);
  await reloaded.loadCatalog();
  assert.equal(reloaded.getSnapshot().catalog.schema_version, 1);
  f.api.operation = async () => receipt(handle.operationId);
  await reloaded.reconcile(existing);
  assert.equal(op(reloaded, target).locked, false);

  const unknown = fixture(),
    w = workspace(unknown);
  w.openNew(ids.draft);
  unknown.api.create = async () => {
    throw new CommandOutcomeUnknown();
  };
  await w.submit("workflow.create").settled;
  const again = workspace(unknown);
  await again.openWorkflow(ids.workflow);
  assert.throws(() => again.submit("workflow.pause"), /unresolved create/);
  again.edit({ kind: "metadata", name: "Local work remains usable" });
  await again.loadCatalog();
  assert.equal(unknown.allocations, 1);
});

test("forged recovery alias, mismatched receipt and alias persistence failure never unlock dispatch", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  const originalSet = f.storage.setItem;
  f.storage.setItem = (key, value) => {
    if (JSON.parse(value).entries.some((item) => item.workflow_id))
      throw new Error("Alias storage failed");
    originalSet(key, value);
  };
  const handle = w.submit("workflow.create");
  await handle.settled;
  assert.equal(op(w, target).status, "unknown");
  assert.equal(markers(f)[0].workflow_id, undefined);
  await w.openWorkflow(ids.workflow, true);
  assert.throws(() => w.submit("workflow.pause"), /unresolved create/);
  f.storage.setItem = originalSet;
  const entries = markers(f);
  entries[0].workflow_id = ids.other;
  f.saved.set(WORKFLOW_JOURNAL_KEY, JSON.stringify({ version: 1, entries }));
  const reload = workspace(f);
  reload.openNew(ids.draft);
  f.api.operation = async () => receipt(handle.operationId);
  await reload.reconcile(target);
  assert.equal(op(reload, target).status, "unknown");
  assert.equal(markers(f)[0].workflow_id, ids.other);
  assert.equal(reload.getSnapshot().editor.workflowId, null);
});

test("read of this save's revision while its response is pending does not leave a phantom conflict", async () => {
  const f = fixture(),
    w = workspace(f),
    gate = deferred();
  await w.openWorkflow(ids.workflow);
  w.edit({ kind: "metadata", name: "A" });
  f.api.save = async () => gate.promise;
  const handle = w.submit("workflow.save");
  await tick();
  f.api.detail = async () => detail({ revision: 2, name: "A" });
  await w.loadDetail();
  assert.equal(w.getSnapshot().editor.conflict, true);
  gate.resolve(detail({ revision: 2, name: "A" }));
  await handle.settled;
  assert.equal(w.getSnapshot().editor.conflict, false);
  assert.equal(w.getSnapshot().editor.baseline.revision, 2);
  w.edit({ kind: "metadata", name: "B" });
  f.api.save = async () => detail({ revision: 3, name: "B" });
  f.api.detail = f.api.save;
  await w.submit("workflow.save").settled;
  assert.equal(w.getSnapshot().editor.baseline.revision, 3);
});

test("navigation from a created draft to its server route preserves unsaved edits without discard", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  await w.submit("workflow.create").settled;
  w.edit({ kind: "metadata", name: "Still editing" });
  assert.equal(await w.openWorkflow(ids.workflow), "opened");
  assert.equal(w.getSnapshot().editor.name, "Still editing");
});

test("create alias recovery refreshes the opened server editor and exposes newer current detail", async () => {
  const f = fixture(),
    w = workspace(f);
  w.openNew(ids.draft);
  f.api.detail = async () => {
    throw new ApiError("Unavailable", 503);
  };
  await w.submit("workflow.create").settled;
  f.api.detail = async () => detail({ revision: 2 });
  await w.openWorkflow(ids.workflow, true);
  w.edit({ kind: "metadata", name: "Local edit on server route" });
  f.api.detail = async () => detail({ revision: 3 });
  await w.reconcile(target);
  assert.equal(w.getSnapshot().editor.baseline.revision, 2);
  assert.equal(w.getSnapshot().editor.latest.revision, 3);
  assert.equal(w.getSnapshot().editor.conflict, true);
  assert.equal(w.getSnapshot().editor.name, "Local edit on server route");
});

test("a delayed reconciliation detail cannot replace an already observed newer server revision", async () => {
  const f = fixture(),
    w = workspace(f),
    readback = deferred();
  await w.openWorkflow(ids.workflow);
  f.api.save = async () => detail({ revision: 2 });
  f.api.detail = async () => readback.promise;
  const handle = w.submit("workflow.save");
  await tick();
  f.api.detail = async () => detail({ revision: 3 });
  await w.loadDetail();
  readback.resolve(detail({ revision: 2 }));
  await handle.settled;
  assert.equal(w.getSnapshot().editor.latest.revision, 3);
  assert.equal(w.getSnapshot().editor.conflict, true);
  assert.equal(op(w, existing).status, "committed_needs_detail");
  assert.equal(op(w, existing).locked, true);
});

test("obsolete-token401 retries reads with current credentials and preserves dirty content, with three-attempt bound", async () => {
  const f = fixture(),
    w = workspace(f),
    old = deferred();
  w.openNew(ids.draft);
  w.edit({ kind: "metadata", name: "Keep me" });
  const tokens = [];
  f.api.catalog = async (token) => {
    tokens.push(token);
    return tokens.length === 1 ? old.promise : structuredClone(catalog);
  };
  const request = w.loadCatalog();
  w.updateToken("token-2");
  old.reject(new ApiError("Expired", 401));
  await request;
  assert.deepEqual(tokens, ["token-1", "token-2"]);
  assert.equal(w.getSnapshot().editor.name, "Keep me");
  assert.equal(w.isCurrent(), true);
  let attempts = 0;
  f.api.catalog = async () => {
    w.updateToken(`renewed-${++attempts}`);
    throw new ApiError("Expired again", 401);
  };
  await w.loadCatalog();
  assert.equal(attempts, 3);
  assert.equal(w.getSnapshot().editor.name, "Keep me");
  assert.match(w.getSnapshot().reads.catalog.error, /Session changed repeatedly/);
});

test("receipt and current-detail reads renew tokens without losing the original operation marker", async () => {
  for (const phase of ["receipt", "current_detail"]) {
    const f = fixture(),
      w = workspace(f),
      old = deferred();
    w.openNew(ids.draft);
    f.api.create = async () => {
      throw new CommandOutcomeUnknown();
    };
    const handle = w.submit("workflow.create");
    await handle.settled;
    const tokens = [];
    f.api.operation = async (_id, token) => {
      if (phase === "receipt") {
        tokens.push(token);
        if (tokens.length === 1) return old.promise;
      }
      return receipt(handle.operationId);
    };
    f.api.detail = async (_id, token) => {
      if (phase === "current_detail") {
        tokens.push(token);
        if (tokens.length === 1) return old.promise;
      }
      return detail();
    };
    const recovery = w.reconcile(target);
    await tick();
    w.updateToken("token-2");
    old.reject(new ApiError("Expired", 401));
    await recovery;
    assert.deepEqual(tokens, ["token-1", "token-2"]);
    assert.equal(op(w, target).status, "resolved");
    assert.equal(w.isCurrent(), true);
    assert.equal(f.allocations, 1);
  }
});

test("obsolete-token mutation401 remains unknown and recovers with current credentials without replay", async () => {
  const f = fixture(),
    w = workspace(f),
    response = deferred();
  w.openNew(ids.draft);
  w.edit({ kind: "metadata", name: "Keep edit" });
  let mutations = 0;
  f.api.create = async () => {
    mutations++;
    return response.promise;
  };
  const handle = w.submit("workflow.create");
  await tick();
  w.updateToken("token-2");
  response.reject(new ApiError("Expired", 401));
  await handle.settled;
  assert.equal(mutations, 1);
  assert.equal(w.getSnapshot().editor.name, "Keep edit");
  assert.equal(op(w, target).status, "unknown");
  assert.equal(markers(f).length, 1);
  f.api.operation = async (_id, token) => {
    assert.equal(token, "token-2");
    throw new ApiError("Missing", 404);
  };
  await w.reconcile(target);
  assert.equal(op(w, target).locked, true);
  f.api.operation = async (_id, token) => {
    assert.equal(token, "token-2");
    return receipt(handle.operationId);
  };
  await w.reconcile(target);
  assert.equal(mutations, 1);
  assert.equal(op(w, target).status, "resolved");
});

test("current-token401/402/403 fence read and mutation ownership while retaining recovery metadata", async () => {
  for (const status of [401, 402, 403]) {
    const f = fixture(),
      w = workspace(f);
    w.openNew(ids.draft);
    f.api.create = async () => {
      throw new ApiError("Access denied", status);
    };
    await w.submit("workflow.create").settled;
    assert.equal(w.getSnapshot().editor, null);
    assert.equal(w.isCurrent(), false);
    assert.equal(markers(f).length, 1);
    const reads = fixture(),
      reader = workspace(reads);
    reader.openNew(ids.draft);
    reads.api.catalog = async () => {
      throw new ApiError("Access denied", status);
    };
    await reader.loadCatalog();
    assert.equal(reader.getSnapshot().editor, null);
    assert.equal(reader.isCurrent(), false);
  }
});

test("untouched restored create loads newer current content while recovery edits retain conflict", async () => {
  for (const edited of [false, true]) {
    const f = fixture(),
      original = workspace(f);
    original.openNew(ids.draft);
    f.api.create = async () => {
      throw new CommandOutcomeUnknown();
    };
    const handle = original.submit("workflow.create");
    await handle.settled;
    const restored = workspace(f);
    restored.openNew(ids.draft);
    if (edited) restored.edit({ kind: "metadata", name: "Recovery edit" });
    f.api.operation = async () => receipt(handle.operationId);
    f.api.detail = async () => detail({ name: "Current server content", revision: 3 });
    await restored.reconcile(target);
    assert.equal(
      restored.getSnapshot().editor.name,
      edited ? "Recovery edit" : "Current server content",
    );
    assert.equal(restored.getSnapshot().editor.baseline.revision, edited ? 1 : 3);
    assert.equal(restored.getSnapshot().editor.conflict, edited);
    assert.equal(workflowEditorDirty(restored.getSnapshot().editor), edited);
  }
});

test("cross-workflow mutation or receipt check supersedes recovery without leaving a completed checking state", async () => {
  for (const supersession of ["mutation", "receipt"]) {
    const f = fixture(),
      w = workspace(f),
      firstReceipt = deferred();
    await w.openWorkflow(ids.workflow);
    f.api.save = async () => {
      throw new CommandOutcomeUnknown();
    };
    const a = w.submit("workflow.save");
    await a.settled;
    f.api.detail = async (id) => detail({ id });
    await w.openWorkflow(ids.other, true);
    let b;
    if (supersession === "receipt") {
      b = w.submit("workflow.save");
      await b.settled;
    }
    f.api.operation = async (operationId) => {
      if (operationId === a.operationId) return firstReceipt.promise;
      throw new ApiError("Still missing", 404);
    };
    const recovery = w.reconcile(existing);
    await tick();
    if (supersession === "mutation") {
      b = w.submit("workflow.save");
      await b.settled;
    } else await w.reconcile({ kind: "workflow", id: ids.other });
    firstReceipt.resolve(receipt(a.operationId, "workflow.save", detail({ revision: 2 })));
    await recovery;
    assert.equal(op(w, existing).status, "unknown");
    assert.equal(op(w, existing).locked, true);
    assert.equal(op(w, existing).result, null);
    assert.equal(markers(f).length, 2);
    assert.equal(f.allocations, 2);
    assert.equal(w.getSnapshot().reads.receipt.loading, false);
  }
});

test("failed authority capture uses workflow copy before any protected read or journal access", () => {
  const f = fixture();
  let storageReads = 0;
  f.dependencies.capture = () => {
    throw new Error("Sign in again before exporting CSVs.");
  };
  f.dependencies.storage = () => {
    storageReads++;
    return f.storage;
  };
  assert.throws(() => workspace(f), /Verify current administrator access before continuing/);
  assert.equal(storageReads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.size, 0);
});

for (const confirmation of ["direct response", "receipt recovery"]) {
  test(`colliding draft/workflow UUIDs keep B's next save on B after ${confirmation} for A`, async () => {
    const f = fixture(),
      w = workspace(f),
      response = deferred();
    const created = detail({ name: "Created A" });
    let savedB = detail({ id: ids.draft, name: "Existing B", revision: 7 });
    f.api.create = async () => response.promise;
    f.api.detail = async (id) => (id === ids.draft ? savedB : created);
    w.openNew(ids.draft);
    const create = w.submit("workflow.create");
    await tick();
    await w.openWorkflow(ids.draft, true);
    w.edit({ kind: "metadata", name: "Local B content" });
    const editorB = w.getSnapshot().editor;
    if (confirmation === "direct response") {
      response.resolve(created);
      await create.settled;
    } else {
      response.reject(new CommandOutcomeUnknown());
      await create.settled;
      f.api.operation = async (operationId) => {
        assert.equal(operationId, create.operationId);
        return receipt(operationId, "workflow.create", created);
      };
      await w.reconcile(target);
    }
    assert.equal(op(w, target).status, "resolved");
    assert.equal(op(w, target).locked, false);
    assert.equal(w.getSnapshot().editor, editorB);
    assert.equal(editorB.workflowId, ids.draft);
    assert.equal(editorB.baseline.id, ids.draft);
    assert.equal(editorB.latest.id, ids.draft);
    assert.equal(editorB.name, "Local B content");
    assert.equal(markers(f).length, 0);
    const saves = [];
    f.api.save = async (id, body) => {
      saves.push({ id, body });
      savedB = detail({ id, name: body.name, revision: body.expected_revision + 1 });
      return savedB;
    };
    await w.submit("workflow.save").settled;
    assert.equal(saves.length, 1);
    assert.equal(saves[0].id, ids.draft);
    assert.equal(saves[0].body.name, "Local B content");
    assert.equal(saves[0].body.expected_revision, 7);
    assert.equal(w.getSnapshot().editor.baseline.id, ids.draft);
    assert.equal(w.getSnapshot().editor.baseline.revision, 8);
  });
}

test("pendingOperation exposes immutable exact/confirmed-alias reservations after reload without I/O", async () => {
  const f = fixture(),
    original = workspace(f);
  f.api.detail = async () => {
    throw new ApiError("Unavailable", 503);
  };
  original.openNew(ids.draft);
  await original.submit("workflow.create").settled;
  assert.equal(markers(f)[0].workflow_id, ids.workflow);
  const restored = workspace(f);
  const beforeCalls = f.calls.length,
    beforeJournal = f.saved.get(WORKFLOW_JOURNAL_KEY);
  const pending = restored.pendingOperation(existing);
  assert.equal(pending, restored.getSnapshot().operations[key(target)]);
  assert.equal(pending.result, null);
  assert.equal(pending.status, "unknown");
  assert.ok(Object.isFrozen(pending));
  assert.equal(restored.pendingOperation(target), pending);
  assert.equal(restored.pendingOperation({ kind: "workflow", id: ids.draft }), undefined);
  assert.equal(restored.pendingOperation({ kind: "draft", id: ids.workflow }), undefined);
  assert.equal(f.calls.length, beforeCalls);
  assert.equal(f.saved.get(WORKFLOW_JOURNAL_KEY), beforeJournal);
  f.auth.at(-1).invalidate();
  assert.equal(restored.pendingOperation(existing), undefined);
});

test("pendingOperation prefers exact reservations and confirmed aliases before an unidentified create blocker", () => {
  const f = fixture();
  const createId = "60000000-0000-4000-8000-000000000101";
  const saveId = "60000000-0000-4000-8000-000000000102";
  f.saved.set(
    WORKFLOW_JOURNAL_KEY,
    JSON.stringify({
      version: 1,
      entries: [
        {
          operation_id: createId,
          command: "workflow.create",
          target,
          owner_user_id: owner.userId,
          owner_studio_id: owner.studioId,
        },
        {
          operation_id: saveId,
          command: "workflow.save",
          target: existing,
          owner_user_id: owner.userId,
          owner_studio_id: owner.studioId,
        },
      ],
    }),
  );
  const w = workspace(f);
  assert.equal(w.pendingOperation(existing).operationId, saveId);
  assert.equal(w.pendingOperation(target).operationId, createId);
  const other = { kind: "workflow", id: ids.other };
  assert.equal(w.pendingOperation(other).operationId, createId);
  // Same UUID does not turn the draft into a workflow alias: this is the owner blocker.
  assert.deepEqual(w.pendingOperation({ kind: "workflow", id: ids.draft }).target, target);
  assert.equal(f.calls.length, 0);
  const data = JSON.parse(f.saved.get(WORKFLOW_JOURNAL_KEY));
  data.entries[0].workflow_id = ids.other;
  f.saved.set(WORKFLOW_JOURNAL_KEY, JSON.stringify(data));
  const known = workspace(f);
  assert.equal(known.pendingOperation(other).operationId, createId);
  assert.equal(known.pendingOperation(existing).operationId, saveId);
  assert.equal(known.pendingOperation({ kind: "workflow", id: ids.draft }), undefined);
  assert.equal(known.pendingOperation({ kind: "draft", id: ids.other }), undefined);
});
