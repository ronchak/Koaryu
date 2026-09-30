import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const { add, modules } = createCommonJsPacker({
  "./student-records.module.css": "module.exports={};",
  "@/components/students/student-rank-badge": "exports.StudentRankBadge=()=>null;",
});
const sectionId = add("@/components/students/student-detail-sections");
const { StudentDetailSections } = runInNewContext(`(()=>{
  const process={env:{NODE_ENV:"production"}};
  const modules=[${modules.join(",")}],cache={};
  function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
  return require(${sectionId});
})()`);
const guardian = {
  id: "guardian-1",
  first_name: "Mina",
  last_name: "Stone",
  is_primary_contact: true,
};
function render(student, primaryGuardian) {
  return renderToStaticMarkup(
    createElement(StudentDetailSections, {
      student,
      primaryGuardian,
      promotionHistory: [],
      rankById: new Map(),
      isCurrentHold: false,
      isLoadingBeltData: false,
      beltLoadError: null,
    }),
  );
}

test("profile displays saved guardian for minors without DOB and for adult students", () => {
  for (const is_minor of [true, false]) {
    const html = render({ is_minor, guardians: [guardian], tags: [] }, guardian);
    assert.match(html, /Primary guardian/);
    assert.match(html, /Mina Stone/);
    assert.doesNotMatch(html, /does not have a guardian/);
  }
});

test("profile warns for a known minor with no guardian and does not infer minor from unknown DOB", () => {
  assert.match(render({ is_minor: true, guardians: [], tags: [] }), /does not have a guardian/);
  assert.doesNotMatch(render({ is_minor: false, guardians: [], tags: [] }), /Primary guardian/);
});
