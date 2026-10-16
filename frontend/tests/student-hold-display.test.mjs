import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { isStudentCurrentHold } from "../src/lib/student-detail-page-model.ts";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const { add, modules } = createCommonJsPacker({
  "./student-records.module.css": "module.exports={};",
  "@/components/students/student-rank-badge": "exports.StudentRankBadge=()=>null;",
  "@/components/intent-prefetch-link": "exports.IntentPrefetchLink=()=>null;",
  "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
});
const sectionId = add("@/components/students/student-detail-sections");
const { buildStudentNextSteps } = runInNewContext(`(()=>{
  const process={env:{NODE_ENV:"production"}};
  const modules=[${modules.join(",")}],cache={};
  function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
  return require(${sectionId});
})()`);

function student(overrides = {}) {
  return {
    status: "active",
    is_minor: false,
    email: "student@example.test",
    emergency_contact_name: "Emergency Contact",
    hold_start_date: "2026-10-01",
    hold_end_date: "2026-10-15",
    ...overrides,
  };
}

function holdStep(record, today) {
  return buildStudentNextSteps({
    student: record,
    isCurrentHold: isStudentCurrentHold(record, today),
  }).find((step) => step.id === "hold");
}

test("dated holds say through the inclusive end day without promising a return", () => {
  assert.equal(holdStep(student(), "2026-10-15").detail, "On hold through Oct 15, 2026.");
});

test("dated holds disappear the day after the end date for an active student", () => {
  assert.equal(holdStep(student(), "2026-10-16"), undefined);
});

test("paused students must review their status and dates before or after their hold end date", () => {
  for (const today of ["2026-10-14", "2026-10-16"]) {
    assert.equal(
      holdStep(student({ status: "paused" }), today).detail,
      "Update their status and hold dates when they return.",
    );
  }
});

test("undated holds state that no hold end date is set", () => {
  assert.equal(
    holdStep(student({ hold_end_date: null }), "2026-10-15").detail,
    "No hold end date is set.",
  );
});
