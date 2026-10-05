import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Exercise the real action orchestration without mounting React. Browser-control
// and lifecycle coverage lives in lead-commands-mounted.test.mjs.
function actionsFixture({ preview, converted = true, currentIdentity = true } = {}) {
  const f = { writes: [], studentWrites: 0, refreshes: 0, mutations: 0, finishes: 0 };
  const { add, modules } = createCommonJsPacker({
    react: `exports.useCallback=fn=>fn;exports.useRef=value=>({current:value});exports.useMemo=fn=>fn();exports.useState=value=>[typeof value==='function'?value():value,()=>{}];exports.useLayoutEffect=()=>{};exports.useSyncExternalStore=(_,get)=>get();`,
    "@/lib/api": `exports.api=f.api;exports.ApiError=class extends Error{};`,
    "@/lib/lead-create-operation": `exports.INACTIVE_LEAD_CREATE_VIEW={isCurrent:()=>false};`,
    "@/lib/lead-operation-reservations": `exports.useLeadOperationReservations=()=>({});`,
  });
  const id = add("@/lib/store-lead-actions");
  const load = new Function(
    "f",
    `const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}return require(${id}).useStoreLeadActions;`,
  );
  const leadsRef = {
    current: [
      {
        id: "lead-a",
        first_name: "A",
        last_name: "Lead",
        stage: "offer_sent",
        converted_student_id: converted ? "existing-student" : null,
        follow_up_date: "2026-09-30",
        program_id: null,
      },
    ],
  };
  const studentsRef = {
    current: converted
      ? [
          {
            id: "existing-student",
            status: "paused",
            program_id: "archived-program",
            membership_start_date: "2020-01-01",
          },
        ]
      : [],
  };
  f.api = {
    post: async (path, body, token) => {
      f.writes.push({ path, body, token });
      if (f.error) throw f.error;
      return {
        ...leadsRef.current[0],
        stage: "enrolled",
        follow_up_date: null,
        converted_student_id: "existing-student",
      };
    },
  };
  const actions = load(f)({
    leadsRef,
    studentsRef,
    isPreviewMode: preview,
    businessDateRef: { current: "2026-09-30" },
    leadMutationScopeRef: { current: {} },
    beltLaddersRef: { current: [] },
    beltRanksRef: { current: [] },
    programsRef: { current: [] },
    beginLiveAuthRequest: () => ({ token: "test-token", isCurrent: () => currentIdentity }),
    beginLeadMutation: () => () => {
      f.finishes++;
    },
    persistLeads: (next) => {
      leadsRef.current = next;
    },
    persistStudents: (next) => {
      f.studentWrites++;
      studentsRef.current = next;
    },
    setLeads: (next) => {
      leadsRef.current = typeof next === "function" ? next(leadsRef.current) : next;
    },
    setLeadsLoaded: () => {},
    setLeadsLoadError: () => {},
    onStudentMutation: () => {
      f.mutations++;
    },
    refreshStudents: async () => {
      f.refreshes++;
      return studentsRef.current;
    },
  });
  return { f, actions, leadsRef, studentsRef };
}

for (const preview of [true, false]) {
  test(`${preview ? "preview" : "live"} existing conversion restores and repeats without student mutation`, async () => {
    const { f, actions, leadsRef, studentsRef } = actionsFixture({ preview });
    const students = structuredClone(studentsRef.current);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await actions.convertLeadToStudent("lead-a");
      assert.equal(result.studentId, "existing-student");
      assert.equal(result.lead.stage, "enrolled");
      assert.equal(result.lead.follow_up_date, null);
      assert.equal(leadsRef.current[0].stage, "enrolled");
      assert.deepEqual(studentsRef.current, students);
      assert.equal(f.studentWrites, 0);
    }
    assert.equal(f.writes.length, preview ? 0 : 3);
    assert.equal(f.refreshes, preview ? 0 : 3);
    assert.equal(f.finishes, preview ? 0 : 3);
    assert.ok(f.writes.every((write) => write.path === "/leads/lead-a/convert"));
  });
}

test("preview enrolled follow-up restores the same student", async () => {
  const { actions, leadsRef, f } = actionsFixture({ preview: true });
  const result = await actions.followUpLead("lead-a", {
    operation_id: "test-operation",
    next_stage: "enrolled",
  });
  assert.equal(result.reconciliation, "ready");
  assert.equal(result.lead.converted_student_id, "existing-student");
  assert.equal(leadsRef.current[0].stage, "enrolled");
  assert.equal(f.studentWrites, 0);
});

test("failed restoration retains the regressed stage and student identity", async () => {
  const { f, actions, leadsRef } = actionsFixture({ preview: false });
  f.error = new Error("Rejected restoration");
  await assert.rejects(actions.convertLeadToStudent("lead-a"), /Rejected restoration/);
  assert.equal(leadsRef.current[0].stage, "offer_sent");
  assert.equal(leadsRef.current[0].converted_student_id, "existing-student");
  assert.equal(f.finishes, 1);
});

test("restoration response from a previous identity does not publish into the current store", async () => {
  const { f, actions, leadsRef } = actionsFixture({ preview: false, currentIdentity: false });
  await actions.convertLeadToStudent("lead-a");
  assert.equal(leadsRef.current[0].stage, "offer_sent");
  assert.equal(f.refreshes, 0);
  assert.equal(f.finishes, 1);
});
