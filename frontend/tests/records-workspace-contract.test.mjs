import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = async (path) => readFile(new URL(path, import.meta.url), "utf8");

describe("records workspace composition contracts", () => {
  it("keeps the student roster semantic, responsive, and printable", async () => {
    const roster = await source("../src/components/students/student-roster-sections.tsx");
    const page = await source("../src/components/students/student-roster-page-content.tsx");
    const styles = await source("../src/components/students/student-records.module.css");

    assert.match(roster, /<table className=\{styles\.rosterTable\}>/);
    assert.match(roster, /data-label="Student"/);
    assert.match(roster, /data-state=\{student\.status\}/);
    assert.equal((roster.match(/className=\{styles\.checkboxTarget\}/g) ?? []).length, 2);
    assert.match(roster, /onClick=\{stopStudentSelectionPropagation\}[\s\S]*className=\{styles\.checkboxControl\}/);
    assert.match(styles, /\.checkboxTarget \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
    assert.match(styles, /\.checkboxControl \{ width: 16px; height: 16px;/);
    const rosterTableRule = styles.match(/\.rosterTable \{[\s\S]*?\}/)?.[0] ?? "";
    assert.doesNotMatch(rosterTableRule, /overflow:\s*(?:hidden|auto)/);
    assert.match(rosterTableRule, /clip-path: inset\(0 round 14px\)/);
    assert.match(roster, /<aside className=\{styles\.studentReadingRail\}/);
    assert.match(roster, /Open full record/);
    assert.match(roster, /row: StudentRosterRow \| null/);
    assert.match(roster, /Hover over or focus a student/);
    assert.match(page, /focusedStudentId/);
    assert.doesNotMatch(page, /filtered\[0\]/);
    assert.match(page, /className=\{styles\.rosterRailSlot\}/);
    assert.match(styles, /\.rosterSearchInput \{[\s\S]*--student-field-padding: 0\.625rem 0\.875rem 0\.625rem 2\.75rem/);
    assert.match(styles, /@media \(max-width: 1399px\)[\s\S]*\.rosterRailSlot \{ display: none; \}/);
    assert.match(styles, /\.mobileSelectAll \{ display: none; \}/);
    assert.match(styles, /@media \(max-width: 820px\)/);
    assert.match(styles, /@media print/);
  });

  it("keeps promotion history explicitly immutable and free of history mutation controls", async () => {
    const detail = await source("../src/components/students/student-detail-sections.tsx");

    assert.match(detail, /Immutable promotion history/);
    assert.match(detail, /Profile edits do not rewrite or remove this history/);
    assert.doesNotMatch(detail, /onEditPromotion|onDeletePromotion|deletePromotion|editPromotion/);
  });

  it("keeps import source context and all four controller stages without metaphor copy", async () => {
    const page = await source("../src/components/students/student-import-page-content.tsx");
    assert.match(page, /aria-label="Import worksheet progress"/);
    assert.match(page, />Source<\/dt>/);
    assert.match(page, />Rows<\/dt>/);
    assert.doesNotMatch(page, /One auditable worksheet/);
    const mapping = await source("../src/components/students/student-import-mapping-step.tsx");
    assert.match(mapping, /aria-label="Choose a different CSV file"/);
    for (const stage of ["upload", "map", "preview", "done"]) {
      assert.match(page, new RegExp(`stage === "${stage}"`));
    }
  });

  it("uses progression strata and an age-banded lead workbench instead of cards or Kanban", async () => {
    const belt = await source("../src/components/belt-tracker/rank-plan-panel.tsx");
    const eligibility = await source("../src/components/belt-tracker/eligibility-panel.tsx");
    const leads = await source("../src/components/leads/lead-pipeline-board.tsx");
    const leadPage = await source("../src/app/(dashboard)/leads/page.tsx");

    assert.match(belt, /styles\.rankRail/);
    assert.match(belt, /data-progression-stratum/);
    assert.match(eligibility, /styles\.decisionRegister/);
    for (const readiness of ["ready", "approval", "progress"]) {
      assert.match(eligibility, new RegExp(`data-readiness="${readiness}"`));
    }
    assert.match(leads, /<dl className=\{styles\.totals\}>/);
    assert.match(leads, /<ol className=\{styles\.stageRail\}/);
    assert.match(leads, /<div className=\{styles\.ageQueue\}/);
    for (const band of ["8+ days overdue", "3–7 days overdue", "1–2 days overdue", "Due today", "Upcoming", "Unscheduled / completed"]) {
      assert.ok(leads.includes(band));
    }
    assert.match(leads, /getLeadNextAction\(lead\)/);
    assert.match(leadPage, /leadsLoadError/);
    assert.match(leadPage, /refreshLeads/);
    assert.match(leadPage, /leads=\{controller\.model\.obligationLedgerLeads\}/);
    assert.doesNotMatch(leads, /bandLeads\.sort/);
    assert.doesNotMatch(leads, /draggable|onDragStart|Drop to move/);
    assert.doesNotMatch(leads, /note:|band\.note|padStart\(2/);
    assert.doesNotMatch(belt, /styles\.rankOrdinal/);
  });

  it("surfaces lead assignment, loss reason, and ephemeral activity without exposing deletion", async () => {
    const add = await source("../src/components/leads/add-lead-modal.tsx");
    const detail = await source("../src/components/leads/lead-detail-modal.tsx");
    const controller = await source("../src/lib/leads-page-controller.ts");
    const leadsUi = `${add}\n${detail}\n${controller}`;

    assert.match(add, /assigned_staff_id/);
    assert.match(detail, /LOST_REASON_LABELS/);
    assert.match(detail, /Recorded follow-up trail/);
    assert.match(detail, /<aside/);
    assert.match(detail, /ref=\{inspectorRef\}/);
    assert.match(detail, /tabIndex=\{-1\}/);
    assert.match(detail, /inspectorRef\.current\?\.focus\(\)/);
    assert.match(detail, /event\.key !== "Escape"/);
    assert.match(detail, /handleClose\(\)/);
    assert.match(detail, /\[data-lead-id=\"\$\{CSS\.escape\(lead\.id\)\}\"\]/);
    assert.doesNotMatch(detail, /ModalFrame|role="dialog"/);
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

  it("keeps records loading and failure announcements truthful and singular", async () => {
    const leads = await source("../src/components/leads/lead-pipeline-board.tsx");
    const loading = await source("../src/components/records/records-loading.tsx");
    const leadErrorState = leads.slice(
      leads.indexOf("export function LeadLedgerLoadError"),
      leads.indexOf("export function LeadPipelineBoard"),
    );

    assert.match(leads, /function LeadLedgerErrorIntro/);
    assert.match(leads, /The follow-up queue could not be loaded/);
    assert.match(leadErrorState, /<LeadLedgerErrorIntro \/>/);
    assert.doesNotMatch(leadErrorState, /LeadLedgerIntroLoading|Loading the accountable queue/);
    assert.match(leadErrorState, /Retry lead roster/);
    assert.equal((loading.match(/role="status"/g) ?? []).length, 1);
    assert.equal((loading.match(/aria-live="polite"/g) ?? []).length, 1);
    assert.match(loading, /<div className=\{styles\.root\}>[\s\S]*<Header title=\{title\} description=\{description\} \/>[\s\S]*<p className="sr-only" role="status" aria-live="polite">\{description\}<\/p>/);
  });

  it("keeps Belt notices and content separated from fixed-height sticky controls", async () => {
    const shell = await source("../src/components/belt-tracker/belt-tracker-shell.tsx");
    const styles = await source("../src/components/belt-tracker/belt-tracker.module.css");
    const controlsStart = shell.indexOf("styles.beltControls");
    const noticeStart = shell.indexOf("styles.beltProgramLockNotice");

    assert.ok(controlsStart >= 0 && noticeStart > controlsStart);
    assert.doesNotMatch(shell.slice(controlsStart, noticeStart), /Save or discard changes before switching programs/);
    assert.equal((shell.match(/Save or discard changes before switching programs/g) ?? []).length, 1);
    const noticeRule = styles.match(/\.beltProgramLockNotice \{[\s\S]*?\}/)?.[0] ?? "";
    assert.match(noticeRule, /padding: 0\.625rem/);
    assert.doesNotMatch(noticeRule, /position:\s*sticky|position:\s*fixed/);
    assert.match(styles, /\.eligibilityWorkspace \{ display: flex; flex-direction: column; gap: 1rem; padding: 1rem/);
    assert.match(styles, /\.eligibilityTableFrame \{[^}]*overflow-x: auto/);
    assert.match(styles, /\.eligibilityTable thead th \{ position: static/);
    const eligibilityTableRule = styles.match(/\.eligibilityTable \{[\s\S]*?\}/)?.[0] ?? "";
    assert.doesNotMatch(eligibilityTableRule, /overflow:\s*(?:hidden|auto)/);
    assert.match(eligibilityTableRule, /clip-path: inset\(0 round 14px\)/);
  });

  it("keeps Belt tabs, progress, and light-rank treatments semantically honest", async () => {
    const shell = await source("../src/components/belt-tracker/belt-tracker-shell.tsx");
    const segmentedControl = await source("../src/components/ui/sliding-segmented-control.tsx");
    const segmentedStyles = await source("../src/components/ui/sliding-segmented-control.module.css");
    const eligibility = await source("../src/components/belt-tracker/eligibility-panel.tsx");
    const rankPlan = await source("../src/components/belt-tracker/rank-plan-panel.tsx");
    const visuals = await source("../src/components/belt-tracker/rank-visuals.tsx");

    assert.match(shell, /<SlidingSegmentedControl[\s\S]*mode="tabs"/);
    assert.match(segmentedControl, /role=\{mode === "tabs" \? "tablist" : "group"\}/);
    assert.match(segmentedControl, /role=\{mode === "tabs" \? "tab" : undefined\}/);
    assert.match(segmentedControl, /aria-selected=\{mode === "tabs" \? selected : undefined\}/);
    assert.match(segmentedControl, /event\.key === "ArrowLeft"/);
    assert.match(segmentedControl, /event\.key === "ArrowRight"/);
    assert.match(segmentedStyles, /transform: translateX\(calc\(var\(--segment-index\) \* 100%\)\)/);
    assert.match(segmentedStyles, /transition: transform 240ms var\(--product-motion-ease\)/);
    assert.match(segmentedStyles, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(eligibility, /role="tabpanel"[\s\S]*aria-labelledby="belt-tab-eligibility"/);
    assert.match(rankPlan, /role="tabpanel"[\s\S]*aria-labelledby="belt-tab-ladder"/);
    assert.match(visuals, /if \(required <= 0\)[\s\S]*Not required/);
    assert.match(visuals, /role="progressbar"[\s\S]*aria-valuetext=\{`\$\{current\} of \$\{required\}`\}/);
    assert.match(visuals, /function prefersDarkText/);
  });

  it("keeps the two-column folio, print shell reset, product tokens, and local focus treatment", async () => {
    const detail = await source("../src/components/students/student-detail-page-content.tsx");
    const studentStyles = await source("../src/components/students/student-records.module.css");
    const beltStyles = await source("../src/components/belt-tracker/belt-tracker.module.css");
    const leadStyles = await source("../src/components/leads/leads-ledger.module.css");

    assert.match(detail, /lg:col-span-2/);
    assert.doesNotMatch(detail, /lg:col-span-3/);
    assert.match(studentStyles, /mobileSpine/);
    assert.match(studentStyles, /:global\(#main-content\)[\s\S]*width: 100% !important;[\s\S]*min-height: 0 !important;[\s\S]*margin-left: 0 !important;[\s\S]*transition: none !important;/);
    assert.doesNotMatch(leadStyles, /--background/);
    assert.match(leadStyles, /var\(--bg\)/);
    for (const styles of [studentStyles, beltStyles, leadStyles]) {
      assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid var\(--product-focus\)/);
      assert.match(styles, /outline-offset: 2px/);
    }
  });

  it("uses shell materials, shell-aware sticky geometry, and route-shaped records loading", async () => {
    const studentStyles = await source("../src/components/students/student-records.module.css");
    const beltStyles = await source("../src/components/belt-tracker/belt-tracker.module.css");
    const leadStyles = await source("../src/components/leads/leads-ledger.module.css");
    const studentLoading = await source("../src/app/(dashboard)/students/loading.tsx");
    const importLoading = await source("../src/app/(dashboard)/students/import/loading.tsx");
    const detailLoading = await source("../src/app/(dashboard)/students/[id]/loading.tsx");
    const beltLoading = await source("../src/app/(dashboard)/belt-tracker/loading.tsx");
    const loading = await source("../src/components/records/records-loading.tsx");

    for (const styles of [studentStyles, beltStyles, leadStyles]) {
      assert.match(styles, /--bg: var\(--product-ground\)/);
      assert.match(styles, /--surface: var\(--product-paper\)/);
      assert.match(styles, /--surface-raised: var\(--product-card-stock\)/);
      assert.match(styles, /@media \(max-width: 1023px\)/);
    }
    assert.match(studentStyles, /\.rosterToolbar[\s\S]*top: 70px/);
    assert.match(studentStyles, /\.rosterTable thead th[\s\S]*top: 132px/);
    assert.match(beltStyles, /\.beltControls[\s\S]*top: 56px/);
    assert.match(beltStyles, /\[data-navigation-placement="top"\][\s\S]*\.beltControls \{ top: 120px/);
    assert.match(beltStyles, /\.eligibilityTable thead th \{ position: static/);
    assert.match(studentStyles, /:global\(#main-content\)[\s\S]*margin-left: 0 !important/);
    assert.match(studentStyles, /\.importStage span \{[^}]*white-space: normal/);
    assert.match(leadStyles, /\.inspector \{[\s\S]*position: sticky/);
    assert.match(leadStyles, /\.inspector:focus \{ outline: 2px solid var\(--product-focus\); outline-offset: 2px; \}/);
    assert.match(leadStyles, /\.stageRail \{/);
    assert.match(leadStyles, /\.ageBand \{/);
    assert.match(leadStyles, /\.totals dt \{[^}]*font-size: 0\.75rem/);
    const leadPrint = leadStyles.slice(leadStyles.indexOf("@media print"));
    assert.doesNotMatch(leadPrint, /\.pageRoot > header,\s/);
    assert.match(leadPrint, /\.pageRoot > header button,/);
    assert.match(leadPrint, /\.pageRoot > header \{ display: flex !important;/);
    assert.doesNotMatch(leadStyles, /font-size: 0\.58rem/);

    for (const routeLoading of [studentLoading, importLoading, detailLoading, beltLoading]) {
      assert.match(routeLoading, /RecordsLoading/);
      assert.doesNotMatch(routeLoading, /DashboardLoadingSkeleton/);
    }
    for (const variant of ["roster", "folio", "import", "belt"]) {
      assert.match(loading, new RegExp(`variant === "${variant}"`));
    }
  });

  it("keeps records workbenches touch-safe, focus-visible, reduced-motion safe, and printable", async () => {
    const stylesheets = await Promise.all([
      source("../src/components/students/student-records.module.css"),
      source("../src/components/belt-tracker/belt-tracker.module.css"),
      source("../src/components/leads/leads-ledger.module.css"),
    ]);

    for (const styles of stylesheets) {
      assert.match(styles, /button(?:,| \{)[\s\S]*min-width: 45px;[^}]*min-height: 45px/);
      assert.match(styles, /label:has\(input:is\(\[type="checkbox"\], \[type="radio"\]\)\)[\s\S]*display: flex;[^}]*min-width: 45px;[^}]*min-height: 45px/);
      assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid var\(--product-focus\)/);
      assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
      assert.match(styles, /@media print/);
      assert.doesNotMatch(styles, /--product-shadow-resting/);
      assert.doesNotMatch(styles, /(?:border-top|border-bottom): 2px|box-shadow:\s*inset|text-transform:\s*uppercase|linear-gradient/);
      assert.doesNotMatch(styles, /border-radius:\s*(?:0|[1-5]px|7px)/);
    }
    assert.match(stylesheets[1], /tr\[data-readiness\][\s\S]*padding-block: 5px !important/);
    assert.match(stylesheets[1], /\.eligibilityTable td\[data-label="Actions"\] > div \{ flex-wrap: nowrap; \}/);
    assert.match(stylesheets[1], /\.rankHeader,[\s\S]*\.tipRow \{ min-height: 56px; padding-block: 5px !important; \}/);
    assert.match(stylesheets[2], /\.ageBand > ol > li \{[^}]*padding: 5px 0\.75rem/);
  });
});
