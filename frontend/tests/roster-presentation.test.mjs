import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  getRankColorTreatment,
  prefersDarkRankText,
} from "../src/lib/rank-color-treatment.ts";

const source = async (path) => readFile(new URL(path, import.meta.url), "utf8");

describe("roster presentation behavior", () => {
  it("uses one luminance rule for light, dark, short, and malformed rank colors", () => {
    for (const color of ["#FFFFFF", "#EAB308", "#fff"]) {
      assert.equal(prefersDarkRankText(color), true, color);
      assert.equal(getRankColorTreatment(color).color, "#211b12", color);
    }

    for (const color of ["#111111", "malformed"]) {
      assert.equal(prefersDarkRankText(color), false, color);
      assert.equal(getRankColorTreatment(color).color, "#ffffff", color);
    }

    assert.equal(getRankColorTreatment("#EAB308").backgroundColor, "#EAB308");
  });

  it("routes mobile key and direction changes through the existing sort callback", async () => {
    const controls = await source("../src/components/students/student-roster-controls.tsx");
    const page = await source("../src/components/students/student-roster-page-content.tsx");
    const styles = await source("../src/components/students/student-records.module.css");

    assert.match(controls, /aria-label="Sort students by"[\s\S]*onChange=\{\(event\) => onSort\(event\.target\.value as SortKey\)\}/);
    for (const key of ["name", "status", "membership_start_date", "created_at"]) {
      assert.match(controls, new RegExp(`<option value="${key}">`));
    }
    assert.match(controls, /aria-label=\{`Sort \$\{sortDir === "asc" \? "descending" : "ascending"\}`\}[\s\S]*onClick=\{\(\) => onSort\(sortKey\)\}/);
    assert.match(page, /<StudentRosterToolbar[\s\S]*onSort=\{onSort\}[\s\S]*sortDir=\{sortDir\}[\s\S]*sortKey=\{sortKey\}/);
    assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.mobileSortControl \{ display: grid; \}/);
  });

  it("suppresses hidden-rail hover updates while retaining focus and open handlers", async () => {
    const page = await source("../src/components/students/student-roster-page-content.tsx");
    const roster = await source("../src/components/students/student-roster-sections.tsx");

    assert.match(page, /const QUICK_VIEW_MEDIA_QUERY = "\(min-width: 1400px\)"/);
    assert.match(page, /onHoverStudent=\{isQuickViewVisible \? setFocusedStudentId : undefined\}/);
    assert.match(roster, /onFocusCapture=\{\(\) => onFocusStudent\(student\.id\)\}/);
    assert.match(roster, /onPointerEnter=\{onHoverStudent \? \(\) => onHoverStudent\(student\.id\) : undefined\}/);
    assert.match(roster, /onClick=\{\(\) => onOpenStudent\(student\.id\)\}/);
    assert.match(roster, /onChange=\{\(\) => toggleSelect\(student\.id\)\}/);
    const studentBadge = await source("../src/components/students/student-rank-badge.tsx");
    assert.match(studentBadge, /isTip && tipColorHex/);
    assert.match(studentBadge, /backgroundColor: tipColorHex/);
  });
});
