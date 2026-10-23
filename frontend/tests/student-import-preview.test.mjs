import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const { add, modules } = createCommonJsPacker({
  react: "module.exports=React;",
  "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
});
const componentId = add("@/components/students/student-import-preview-step");
const { StudentImportPreviewStep } = runInNewContext(
  `(()=>{
  const process={env:{NODE_ENV:"production"}};
  const modules=[${modules.join(",")}],cache={};
  function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
  return require(${componentId});
})()`,
  { React },
);
function render(review, duplicateDecisions = {}) {
  return renderToStaticMarkup(
    createElement(StudentImportPreviewStep, {
      activeImportKey: "key",
      duplicateDecisions,
      isLoading: false,
      importOptions: {},
      validationResult: {
        valid_rows: 1,
        total_rows: 1,
        error_rows: 0,
        setup_issues: [],
        warnings: [],
        actions_available: {},
        rows: [
          {
            row_number: 3,
            is_valid: true,
            issues: [],
            data: { legal_first_name: "Mina", legal_last_name: "Nguyen" },
            duplicate_review: review,
          },
        ],
      },
    }),
  );
}
const review = {
  candidates: [],
  family_context: ["Shares a guardian with Ava Nguyen (an existing student); likely family"],
  suggested_action: "create",
};

test("guardian-only rows show the existing contact and family context without radio choices", () => {
  const html = render({
    ...review,
    guardian_outcome: { kind: "link_existing", display_name: "Jordan Smith" },
  });
  assert.match(html, /Family contacts/);
  assert.match(html, /Row 3: Mina Nguyen/);
  assert.match(html, /Shares a guardian with Ava Nguyen/);
  assert.match(html, /Will be linked to the existing contact Jordan Smith/);
  assert.doesNotMatch(html, /type="radio"|Choose one|Treated as a different student/);
});
test("in-file contact line names the earlier row", () => {
  const html = render({
    ...review,
    guardian_outcome: { kind: "in_file_shared", display_name: "Jordan Smith", of_row: 2 },
  });
  assert.match(html, /Will share the contact from row 2/);
  assert.doesNotMatch(html, /type="radio"/);
});
test("a shared contact line says a separate contact is created when the earlier row is skipped", () => {
  const html = render(
    {
      ...review,
      candidates: [],
      family_context: [],
      guardian_outcome: { kind: "in_file_shared", display_name: "Jordan Smith", of_row: 2 },
    },
    { 2: { action: "skip", matched_student_id: "student-1", of_row: null } },
  );
  assert.match(html, /A separate contact will be created because row 2 is skipped/);
  assert.doesNotMatch(html, /Will share the contact from row 2/);
});
test("student duplicate choices also display their guardian outcome", () => {
  const html = render({
    ...review,
    candidates: [
      {
        student_id: "student-1",
        display_name: "Mina Nguyen",
        confidence: "strong",
        reasons: ["same name"],
        archived: false,
      },
    ],
    suggested_action: "decide",
    guardian_outcome: { kind: "link_existing", display_name: "Jordan Smith" },
  });
  assert.match(html, /Will be linked to the existing contact Jordan Smith/);
  assert.match(html, /type="radio"/);
  assert.match(html, /Choose one/);
});

for (const archived of [false, true]) {
  test(`source ID match displays the ID and offers only Skip, archived=${archived}`, () => {
    const html = render(
      {
        ...review,
        skip_only: true,
        suggested_action: "skip",
        family_context: [],
        candidates: [
          {
            student_id: "s1",
            display_name: "Testformer Fixturequill",
            source_id: "00042",
            archived,
            confidence: "strong",
            reasons: ["same member ID"],
          },
        ],
      },
      { 3: { action: "skip", matched_student_id: "s1" } },
    );
    assert.match(html, /Already in Koaryu as Testformer Fixturequill \(member ID 00042\)/);
    assert.match(html, /Skip, already in Koaryu/);
    assert.equal((html.match(/type="radio"/g) || []).length, 1);
    assert.doesNotMatch(html, /Create as a new student|Choose one/);
    assert.match(html, /checked=""/);
  });
}

test("in-file source ID match identifies its earlier row", () => {
  const html = render({
    ...review,
    skip_only: true,
    suggested_action: "skip",
    family_context: [],
    candidates: [
      {
        of_row: 2,
        display_name: "Testformer Fixturequill",
        source_id: "00042",
        confidence: "strong",
        reasons: ["same member ID"],
      },
    ],
  });
  assert.match(html, /Same member ID as row 2 \(member ID 00042\)/);
  assert.doesNotMatch(html, /Create as a new student/);
});
