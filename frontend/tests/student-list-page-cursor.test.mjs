import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeStudentListSearch,
} from "../src/lib/student-list-page.ts";
import { buildStudentPagePath } from "../src/lib/student-roster-query.ts";

function query(path) {
  return new URL(path, "https://example.test").searchParams;
}

describe("student roster cursor request encoding", () => {
  it("encodes normalized search, server filters, studio-local today, sorting, and page size", () => {
    const params = query(buildStudentPagePath({
      fullRoster: true,
      inactivityDays: 90,
      newStudents: "ytd",
      page: 1,
      pageSize: 50,
      programId: "program-1",
      search: "  Ava,(Kids)%_\nLane  ",
      sortDir: "desc",
      sortKey: "created_at",
      status: "active",
      today: "2026-08-19",
    }));

    assert.equal(normalizeStudentListSearch("  Ava,(Kids)%_\nLane  "), "Ava Kids Lane");
    assert.equal(params.get("search"), "Ava Kids Lane");
    assert.equal(params.get("status"), "active");
    assert.equal(params.get("program_id"), "program-1");
    assert.equal(params.get("full_roster"), "1");
    assert.equal(params.get("inactivity_days"), "90");
    assert.equal(params.get("new_students"), "ytd");
    assert.equal(params.get("today"), "2026-08-19");
    assert.equal(params.get("sort_by"), "created_at");
    assert.equal(params.get("sort_dir"), "desc");
    assert.equal(params.get("page_size"), "50");
    assert.equal(params.get("page"), "1");
  });

  it("uses an opaque cursor instead of numeric page navigation", () => {
    const cursor = "opaque.cursor/with+=characters";
    const params = query(buildStudentPagePath({
      cursor,
      page: 7,
      pageSize: 50,
      sortDir: "asc",
      sortKey: "name",
      today: "2026-08-19",
    }));

    assert.equal(params.get("cursor"), cursor);
    assert.equal(params.has("page"), false);
    assert.equal(params.get("page_size"), "50");
  });

  it("covers every supported sort direction and derived filter window", () => {
    for (const sortKey of ["name", "status", "membership_start_date", "created_at"]) {
      for (const sortDir of ["asc", "desc"]) {
        const params = query(buildStudentPagePath({ sortDir, sortKey }));
        assert.equal(params.get("sort_by"), sortKey);
        assert.equal(params.get("sort_dir"), sortDir);
      }
    }

    for (const inactivityDays of [14, 30, 90]) {
      const params = query(buildStudentPagePath({ inactivityDays, today: "2026-08-19" }));
      assert.equal(params.get("inactivity_days"), String(inactivityDays));
      assert.equal(params.get("today"), "2026-08-19");
    }
    for (const newStudents of ["14", "30", "90", "ytd"]) {
      const params = query(buildStudentPagePath({ newStudents, today: "2026-08-19" }));
      assert.equal(params.get("new_students"), newStudents);
      assert.equal(params.get("today"), "2026-08-19");
    }
  });
});
