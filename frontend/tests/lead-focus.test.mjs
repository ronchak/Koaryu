import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeLeadDue,
  getLeadFigures,
  getLeadNextAction,
  isSameLeadFocus,
  matchesLeadFocus,
} from "../src/components/leads/lead-focus.ts";

const lead = (id, extra = {}) => ({
  id,
  first_name: id,
  last_name: "Lead",
  stage: "inquiry",
  follow_up_date: null,
  assigned_staff_id: null,
  ...extra,
});

describe("lead follow-up focus", () => {
  it("says how late or how soon a follow-up is, with its tone", () => {
    const today = "2026-10-10";
    assert.deepEqual(describeLeadDue("2026-10-07", today), {
      label: "3 days overdue",
      tone: "alert",
    });
    assert.deepEqual(describeLeadDue("2026-10-09", today), {
      label: "1 day overdue",
      tone: "alert",
    });
    assert.deepEqual(describeLeadDue(today, today), { label: "Due today", tone: "warn" });
    assert.deepEqual(describeLeadDue("2026-10-11", today), {
      label: "Due tomorrow",
      tone: "neutral",
    });
    assert.equal(describeLeadDue("2026-10-20", today).label, "Due Oct 20");
    assert.equal(describeLeadDue(null, today).label, "No follow-up date");
  });

  it("counts only open leads and filters the queue the same way", () => {
    const today = "2026-10-10";
    const leads = [
      lead("late", { follow_up_date: "2026-10-05", stage: "offer_sent" }),
      lead("later", { follow_up_date: "2026-10-08", assigned_staff_id: "s1" }),
      lead("today", { follow_up_date: today, stage: "trial_scheduled" }),
      lead("done", { follow_up_date: "2026-10-01", stage: "enrolled" }),
    ];
    assert.deepEqual(getLeadFigures(leads, today), {
      open: 3,
      overdue: 2,
      oldestOverdueDays: 5,
      dueToday: 1,
      trialsBooked: 1,
      unassigned: 2,
    });
    const ids = (focus) =>
      leads.filter((item) => matchesLeadFocus(item, focus, today)).map((item) => item.id);
    assert.deepEqual(ids({ kind: "overdue" }), ["late", "later"]);
    assert.deepEqual(ids({ kind: "today" }), ["today"]);
    assert.deepEqual(ids({ kind: "unassigned" }), ["late", "today"]);
    assert.deepEqual(ids({ kind: "stage", stage: "enrolled" }), ["done"]);
    assert.deepEqual(ids(null), ["late", "later", "today", "done"]);
    assert.equal(
      isSameLeadFocus({ kind: "stage", stage: "inquiry" }, { kind: "stage", stage: "inquiry" }),
      true,
    );
    assert.equal(isSameLeadFocus({ kind: "stage", stage: "inquiry" }, { kind: "today" }), false);
  });

  it("names the next action from the stage", () => {
    assert.equal(getLeadNextAction(lead("a")), "Schedule the next contact");
    assert.equal(
      getLeadNextAction(lead("b", { stage: "trial_scheduled", follow_up_date: "2026-10-11" })),
      "Confirm trial attendance",
    );
  });
});
