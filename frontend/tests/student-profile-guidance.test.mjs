import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const externalRequire = createRequire(import.meta.url);
const { add, modules } = createCommonJsPacker({
  react: 'module.exports = externalRequire("react");',
  "react/jsx-runtime": 'module.exports = externalRequire("react/jsx-runtime");',
  "lucide-react": 'module.exports = externalRequire("lucide-react");',
  "@/components/intent-prefetch-link": `exports.IntentPrefetchLink = ({ children, ...props }) => require("react").createElement("a", props, children);`,
});
const entries = [
  "@/components/students/student-detail-sidebar",
  "@/components/students/student-detail-sections",
].map((entry) => add(entry));
const [{ StudentDetailSidebar }, { buildStudentNextSteps }] = new Function(
  "externalRequire",
  `const modules = [${modules.join(",")}], cache = {};
   function require(id) {
     if (cache[id]) return cache[id].exports;
     const module = cache[id] = { exports: {} };
     modules[id](module, module.exports, require);
     return module.exports;
   }
   return [${entries.join(",")}].map(require);`,
)(externalRequire);

function student(overrides = {}) {
  return {
    id: "synthetic-student",
    legal_first_name: "Ava",
    legal_last_name: "Lane",
    status: "active",
    is_minor: false,
    tags: [],
    guardians: [],
    emergency_contact_name: "Emergency Contact",
    ...overrides,
  };
}

function renderTenure(start, today) {
  return renderToStaticMarkup(
    React.createElement(StudentDetailSidebar, {
      student: student({ membership_start_date: start }),
      fullName: "Ava Lane",
      programs: [],
      activeProgramIds: [],
      canManageRoster: false,
      isCommandPending: true,
      promotionCount: 0,
      businessDate: today,
    }),
  );
}

test("recent tenure does not claim this calendar month when the student joined last month", () => {
  for (const [start, today] of [
    ["2026-09-30", "2026-10-01"],
    ["2026-12-31", "2027-01-01"],
    ["2026-10-01", "2026-10-27"],
  ]) {
    const html = renderTenure(start, today);
    assert.match(html, />Less than a month training</);
    assert.doesNotMatch(html, /New this month/);
  }
});

test("tenure preserves complete month and year boundaries", () => {
  for (const [start, today, label] of [
    ["2026-09-27", "2026-10-27", "1 month training"],
    ["2026-08-27", "2026-10-27", "2 months training"],
    ["2025-10-27", "2026-10-27", "1 year training"],
  ]) {
    assert.ok(renderTenure(start, today).includes(`>${label}<`));
  }
});

test("missing and future membership starts do not claim training tenure", () => {
  for (const start of [null, "2026-10-28"]) {
    assert.doesNotMatch(
      renderTenure(start, "2026-10-27"),
      /month training|months training|year training|New this month/,
    );
  }
});

function reachStep(record, primaryGuardian) {
  return buildStudentNextSteps({ student: record, primaryGuardian, isCurrentHold: false }).find(
    (step) => step.id === "reach",
  );
}

test("contact guidance identifies the missing primary details without denying secondary contacts", () => {
  const primary = { id: "primary", first_name: "Primary", is_primary_contact: true };
  for (const contact of [{ email: "secondary@example.test" }, { phone: "206-555-0100" }]) {
    const secondary = { id: "secondary", first_name: "Secondary", ...contact };
    const step = reachStep(student({ guardians: [primary, secondary] }), primary);
    assert.equal(step.title, "Contact details missing");
    assert.equal(step.detail, "Add an email or phone for this student or their primary guardian.");
    assert.equal(step.action.kind, "edit");
    assert.equal(step.action.label, "Add details");
  }
});

test("contact guidance still warns when all contacts are absent", () => {
  assert.ok(reachStep(student()));
});

test("student or primary contact details continue to clear the guidance", () => {
  for (const contact of [{ email: "contact@example.test" }, { phone: "206-555-0100" }]) {
    assert.equal(reachStep(student(contact)), undefined);
    assert.equal(reachStep(student(), contact), undefined);
  }
});

test("inactive and canceled students keep their returning guidance", () => {
  for (const status of ["inactive", "canceled"]) {
    const steps = buildStudentNextSteps({ student: student({ status }), isCurrentHold: false });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, "returning");
  }
});
