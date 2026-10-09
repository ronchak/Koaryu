import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKFLOW_ACTIVITY_JOURNAL_KEY,
  WORKFLOW_ACTIVITY_JOURNAL_LIMIT,
  parseWorkflowActivityJournal as parse,
  serializeWorkflowActivityJournal as serialize,
  workflowActivityTargetKey as key,
} from "../src/lib/automation-workflow-activity-state.ts";

const id = (number) => `abcdefab-0000-4000-8000-${String(number).padStart(12, "0")}`;
const target = { kind: "test", workflowId: id(2) };
const marker = (patch = {}) => ({
  operation_id: id(6),
  command: "test_email.create",
  owner_user_id: id(8),
  owner_studio_id: id(1),
  target,
  email_node_id: "__proto__",
  ...patch,
});
const raw = (entries) => JSON.stringify({ version: 1, entries });
const unavailable = (call) =>
  assert.throws(call, {
    message: "Workflow activity recovery storage is unavailable. Check storage access.",
  });

test("strict journal canonicalizes only validated UUIDs, preserves node IDs and freezes detached metadata", () => {
  const original = marker({
    test_delivery_id: id(7).toUpperCase(),
    target: { workflowId: id(2).toUpperCase(), kind: "test" },
  });
  const result = parse(raw([original]));
  assert.deepEqual(result, [marker({ test_delivery_id: id(7) })]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(result[0].target), true);
  assert.equal(serialize(result), serialize([marker({ test_delivery_id: id(7) })]));
  assert.deepEqual(parse(null), []);
  assert.equal(WORKFLOW_ACTIVITY_JOURNAL_KEY, "koaryu-workflow-activity-v1");
  assert.equal(WORKFLOW_ACTIVITY_JOURNAL_LIMIT, 100);
  for (const node of [
    "constructor",
    "hasOwnProperty",
    "toString",
    "__defineGetter__",
    "a".repeat(64),
  ])
    assert.equal(parse(serialize([marker({ email_node_id: node })]))[0].email_node_id, node);
});

test("own-key validation rejects malformed envelopes, extra fields, mismatched targets and non-UUID strings", () => {
  for (const value of [
    "{broken secret",
    "null",
    "[]",
    "{}",
    "true",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [], token: "private" }),
    JSON.stringify({ version: 1, entries: null }),
  ])
    unavailable(() => parse(value));
  const invalid = [
    { token: "private" },
    { graph: {} },
    { terminal: true },
    { test_delivery_id: null },
    { operation_id: "not-uuid" },
    { owner_user_id: 1 },
    { owner_studio_id: `${id(1)}\n` },
    { command: "workflow.create" },
    { command: "run.cancel" },
    { email_node_id: "" },
    { email_node_id: " a" },
    { email_node_id: "a.b" },
    { email_node_id: "é" },
    { email_node_id: "a".repeat(65) },
    { target: { ...target, runId: id(3) } },
    { target: { kind: "draft", workflowId: id(2) } },
    { target: { kind: "test", workflowId: {} } },
  ];
  for (const patch of invalid) {
    unavailable(() => serialize([marker(patch)]));
    unavailable(() => parse(raw([marker(patch)])));
  }
  unavailable(() => serialize([marker({ test_delivery_id: undefined })]));
  unavailable(() => serialize([marker({ email_node_id: undefined })]));
  unavailable(() => key({ kind: "run", workflowId: id(2) }));
  unavailable(() => key({ ...target, body: "private" }));
});

test("inherited substitute fields and accessor getters are rejected without invoking getters", () => {
  for (const field of Object.keys(marker())) {
    const value = marker();
    delete value[field];
    Object.setPrototypeOf(value, { [field]: marker()[field] });
    unavailable(() => serialize([value]));
    Object.defineProperty(value, field, {
      get() {
        assert.fail("getter must not run");
      },
      enumerable: true,
    });
    unavailable(() => serialize([value]));
  }
  const value = marker();
  Object.defineProperty(value, Symbol("token"), { value: "private" });
  unavailable(() => serialize([value]));
  const inheritedTarget = Object.create(target);
  unavailable(() => serialize([marker({ target: inheritedTarget })]));
  const inheritedAlias = marker();
  Object.setPrototypeOf(inheritedAlias, { test_delivery_id: id(7) });
  assert.equal(Object.hasOwn(parse(serialize([inheritedAlias]))[0], "test_delivery_id"), false);
});

test("sparse, accessor, extra-key arrays and duplicate normalized identities are rejected", () => {
  const sparse = [marker(), , marker({ operation_id: id(9) })];
  unavailable(() => serialize(sparse));
  unavailable(() => parse(raw(sparse)));
  const array = [marker()];
  array.token = "private";
  unavailable(() => serialize(array));
  const accessor = [];
  Object.defineProperty(accessor, 0, {
    get() {
      assert.fail("getter must not run");
    },
    enumerable: true,
  });
  unavailable(() => serialize(accessor));
  for (const second of [
    marker({ operation_id: id(6).toUpperCase(), owner_user_id: id(9) }),
    marker({ operation_id: id(9), target: { kind: "test", workflowId: id(2).toUpperCase() } }),
  ])
    unavailable(() => serialize([marker(), second]));
});

test("namespaces and owners are independent; limit 100 never evicts metadata", () => {
  const run = {
    operation_id: id(9),
    command: "run.cancel",
    owner_user_id: id(8),
    owner_studio_id: id(1),
    target: { kind: "run", workflowId: id(2), runId: id(2) },
  };
  const values = [marker(), run, marker({ operation_id: id(10), owner_user_id: id(11) })];
  assert.equal(parse(serialize(values)).length, 3);
  assert.notEqual(key(target), key(run.target));
  assert.equal(key({ ...target, workflowId: id(2).toUpperCase() }), key(target));
  const hundred = Array.from({ length: 100 }, (_, index) =>
    marker({
      operation_id: id(index + 100),
      target: { kind: "test", workflowId: id(index + 1000) },
    }),
  );
  assert.equal(parse(serialize(hundred)).length, 100);
  unavailable(() => serialize([...hundred, marker()]));
  unavailable(() => parse(raw([...hundred, marker()])));
});
