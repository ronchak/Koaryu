import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = async (path) => readFile(new URL(path, import.meta.url), "utf8");

describe("records workspace composition contracts", () => {
  it("keeps the student roster semantic, responsive, and printable", async () => {
    const roster = await source("../src/components/students/student-roster-sections.tsx");
    const styles = await source("../src/components/students/student-records.module.css");

    assert.match(roster, /<table className=\{styles\.rosterTable\}>/);
    assert.match(roster, /data-label="Student"/);
    assert.match(roster, /data-state=\{student\.status\}/);
    assert.match(styles, /@media \(max-width: 820px\)/);
    assert.match(styles, /@media print/);
  });

  it("keeps promotion history explicitly immutable and free of history mutation controls", async () => {
    const detail = await source("../src/components/students/student-detail-sections.tsx");

    assert.match(detail, /Immutable promotion history/);
    assert.match(detail, /Profile edits do not rewrite or remove this history/);
    assert.doesNotMatch(detail, /onEditPromotion|onDeletePromotion|deletePromotion|editPromotion/);
  });

  it("presents import as one worksheet while retaining all four controller stages", async () => {
    const page = await source("../src/components/students/student-import-page-content.tsx");
    assert.match(page, /One auditable worksheet/);
    for (const stage of ["upload", "map", "preview", "done"]) {
      assert.match(page, new RegExp(`stage === "${stage}"`));
    }
  });

  it("uses a ranked belt roster and an obligation ledger instead of cards or Kanban", async () => {
    const belt = await source("../src/components/belt-tracker/rank-plan-panel.tsx");
    const leads = await source("../src/components/leads/lead-pipeline-board.tsx");
    const leadPage = await source("../src/app/(dashboard)/leads/page.tsx");

    assert.match(belt, /styles\.rankRail/);
    assert.match(leads, /Who needs a follow-up next/);
    assert.match(leads, /<table className=\{styles\.ledger\}>/);
    assert.match(leadPage, /leadsLoadError/);
    assert.match(leadPage, /refreshLeads/);
    assert.doesNotMatch(leads, /draggable|onDragStart|Drop to move/);
  });

  it("surfaces lead assignment, loss reason, and ephemeral activity without exposing deletion", async () => {
    const add = await source("../src/components/leads/add-lead-modal.tsx");
    const detail = await source("../src/components/leads/lead-detail-modal.tsx");
    const controller = await source("../src/lib/leads-page-controller.ts");
    const leadsUi = `${add}\n${detail}\n${controller}`;

    assert.match(add, /assigned_staff_id/);
    assert.match(detail, /LOST_REASON_LABELS/);
    assert.match(detail, /Recorded follow-up trail/);
    assert.match(controller, /\/leads\/\$\{selectedLeadId\}\/activities/);
    assert.doesNotMatch(leadsUi, /deleteLead|api\.delete|>\s*Delete\s*</);
  });

  it("keeps lead loading, staff, and loss transitions contract-safe", async () => {
    const page = await source("../src/app/(dashboard)/leads/page.tsx");
    const add = await source("../src/components/leads/add-lead-modal.tsx");
    const detail = await source("../src/components/leads/lead-detail-modal.tsx");

    assert.ok(page.indexOf("leadsLoadError ?") < page.indexOf("!leadsLoaded ?"));
    assert.match(page, /refreshLeads\(\)\.catch\(\(\) => undefined\)/);
    assert.match(page, /new Map\(staffMembers\.map/);
    assert.match(page, /const activeStaff = staffMembers\.filter/);
    assert.match(add, /activeStaff\.map/);
    assert.match(detail, /currentAssignedStaff\.status !== "active"/);
    assert.match(detail, /` · \$\{member\.status\}`/);
    assert.match(detail, /lead\.stage === "closed_lost"[\s\S]*\? \[\.\.\.PIPELINE_STAGES/);
    assert.match(detail, /: PIPELINE_STAGES;/);
  });

  it("keeps the two-column folio, print shell reset, product tokens, and local focus treatment", async () => {
    const detail = await source("../src/components/students/student-detail-page-content.tsx");
    const studentStyles = await source("../src/components/students/student-records.module.css");
    const beltStyles = await source("../src/components/belt-tracker/belt-tracker.module.css");
    const leadStyles = await source("../src/components/leads/leads-ledger.module.css");

    assert.match(detail, /lg:col-span-2/);
    assert.doesNotMatch(detail, /lg:col-span-3/);
    assert.match(studentStyles, /mobileSpine/);
    assert.match(studentStyles, /> main\)[\s\S]*width: 100% !important;[\s\S]*min-height: 0 !important;[\s\S]*margin-left: 0 !important;/);
    assert.doesNotMatch(leadStyles, /--background/);
    assert.match(leadStyles, /var\(--bg\)/);
    for (const styles of [studentStyles, beltStyles, leadStyles]) {
      assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid var\(--accent\)/);
      assert.match(styles, /outline-offset: 2px/);
    }
  });
});
