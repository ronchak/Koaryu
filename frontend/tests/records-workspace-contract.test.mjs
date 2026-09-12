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
});
