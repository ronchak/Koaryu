import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const source = async (path) => readFile(new URL(path, import.meta.url), "utf8");

describe("records workspace policies", () => {
  it("does not expose promotion-history mutation controls", async () => {
    const detail = await source("../src/components/students/student-detail-sections.tsx");

    assert.doesNotMatch(detail, /onEditPromotion|onDeletePromotion|deletePromotion|editPromotion/);
  });

  it("keeps lead assignment and inspector access without exposing deletion", async () => {
    const add = await source("../src/components/leads/add-lead-modal.tsx");
    const detail = await source("../src/components/leads/lead-detail-modal.tsx");
    const controller = await source("../src/lib/leads-page-controller.ts");

    assert.match(add, /activeStaff\.map/);
    assert.match(add, /<select[\s\S]*name="assigned_staff_id"[\s\S]*activeStaff\.map/);
    assert.match(add, /assigned_staff_id:\s*\(formData\.get\("assigned_staff_id"\)/);
    assert.match(detail, /currentAssignedStaff\.status !== "active"/);
    assert.match(detail, /\$\{member\.status\}/);
    assert.match(detail, /ref=\{inspectorRef\}/);
    assert.match(detail, /tabIndex=\{-1\}/);
    assert.match(detail, /inspectorRef\.current\?\.focus\(\)/);
    assert.match(detail, /event\.key !== "Escape"[\s\S]*handleClose\(\)/);
    assert.match(detail, /\[data-lead-id=\"\$\{CSS\.escape\(lead\.id\)\}\"\]/);
    assert.doesNotMatch(
      `${add}\n${detail}\n${controller}`,
      /deleteLead|api\.delete|>\s*Delete\s*</,
    );
  });

  it("keeps loading and failure announcements singular", async () => {
    const leads = await source("../src/components/leads/lead-pipeline-board.tsx");
    const loading = await source("../src/components/records/records-loading.tsx");
    const mapping = await source("../src/components/students/student-import-mapping-step.tsx");
    const leadErrorState = leads.slice(
      leads.indexOf("export function LeadLedgerLoadError"),
      leads.indexOf("export function LeadPipelineBoard"),
    );
    const resetStart = mapping.lastIndexOf("<button", mapping.indexOf("onClick={onReset}"));
    const resetControl = mapping.slice(resetStart, mapping.indexOf("</button>", resetStart));

    assert.doesNotMatch(leadErrorState, /LeadLedgerIntroLoading/);
    assert.match(
      leadErrorState,
      /role="alert"[\s\S]*\{error\}[\s\S]*<Button[\s\S]*onClick=\{onRetry\}/,
    );
    assert.equal((loading.match(/role="status"/g) ?? []).length, 1);
    assert.equal((loading.match(/aria-live="polite"/g) ?? []).length, 1);
    assert.match(resetControl, /aria-label="[^"]+"/);
  });

  it("keeps belt tabs and progress accessible", async () => {
    const segmentedControl = await source("../src/components/ui/sliding-segmented-control.tsx");
    const eligibility = await source("../src/components/belt-tracker/eligibility-panel.tsx");
    const rankPlan = await source("../src/components/belt-tracker/rank-plan-panel.tsx");
    const visuals = await source("../src/components/belt-tracker/rank-visuals.tsx");

    assert.match(segmentedControl, /role=\{mode === "tabs" \? "tablist" : "group"\}/);
    assert.match(segmentedControl, /role=\{mode === "tabs" \? "tab" : undefined\}/);
    assert.match(segmentedControl, /aria-selected=\{mode === "tabs" \? selected : undefined\}/);
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      assert.match(segmentedControl, new RegExp(`event\\.key === "${key}"`));
    }
    assert.match(eligibility, /role="tabpanel"[\s\S]*aria-labelledby="belt-tab-eligibility"/);
    assert.match(rankPlan, /role="tabpanel"[\s\S]*aria-labelledby="belt-tab-ladder"/);
    assert.match(visuals, /if \(required <= 0\)[\s\S]*Not required/);
    assert.match(
      visuals,
      /role="progressbar"[\s\S]*aria-valuetext=\{`\$\{current\} of \$\{required\}`\}/,
    );
  });

  it("keeps records workbenches touch, focus, motion, and print accessible", async () => {
    const stylesheets = await Promise.all([
      source("../src/components/students/student-records.module.css"),
      source("../src/components/belt-tracker/belt-tracker.module.css"),
      source("../src/components/leads/leads-ledger.module.css"),
    ]);

    for (const styles of stylesheets) {
      assert.match(styles, /button(?:,| \{)[\s\S]*min-width: 45px;[^}]*min-height: 45px/);
      assert.match(
        styles,
        /label:has\(input:is\(\[type="checkbox"\], \[type="radio"\]\)\)[\s\S]*display: flex;[^}]*min-width: 45px;[^}]*min-height: 45px/,
      );
      assert.match(styles, /:focus-visible[\s\S]*outline: 2px solid var\(--product-focus\)/);
      assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
      assert.match(styles, /@media print/);
    }
  });
});
