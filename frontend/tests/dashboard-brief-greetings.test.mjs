import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DASHBOARD_BRIEF_GREETINGS,
  resolveDashboardOwnerFirstName,
  selectDashboardBriefGreeting,
} from "../src/lib/dashboard-brief-greetings.ts";

// 2026-08-17 is a Monday, so the week below covers every weekday tag.
const MONDAY = "2026-08-17";
const FRIDAY = "2026-08-21";

describe("dashboard brief greetings", () => {
  it("keeps the greeting bank well formed", () => {
    assert.equal(DASHBOARD_BRIEF_GREETINGS.length, 100);
    assert.equal(
      new Set(DASHBOARD_BRIEF_GREETINGS.map((greeting) => greeting.id)).size,
      DASHBOARD_BRIEF_GREETINGS.length
    );
    assert.equal(
      new Set(DASHBOARD_BRIEF_GREETINGS.map((greeting) => greeting.text)).size,
      DASHBOARD_BRIEF_GREETINGS.length
    );

    for (const greeting of DASHBOARD_BRIEF_GREETINGS) {
      assert.ok(greeting.text.trim().length > 0, `${greeting.id} is empty`);
      if (greeting.weekday !== undefined) {
        assert.ok(
          Number.isInteger(greeting.weekday) && greeting.weekday >= 0 && greeting.weekday <= 6,
          `${greeting.id} has an invalid weekday`
        );
      }
    }
  });

  it("covers every weekday and leaves enough nameless copy", () => {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      assert.ok(
        DASHBOARD_BRIEF_GREETINGS.some((greeting) => greeting.weekday === weekday),
        `weekday ${weekday} has no greeting`
      );
      assert.ok(
        DASHBOARD_BRIEF_GREETINGS.some(
          (greeting) => greeting.weekday === weekday && !greeting.text.includes("{name}")
        ),
        `weekday ${weekday} has no nameless greeting`
      );
      // The named and nameless pools are disjoint, so each day needs copy in both.
      assert.ok(
        DASHBOARD_BRIEF_GREETINGS.some(
          (greeting) => greeting.weekday === weekday && greeting.text.includes("{name}")
        ),
        `weekday ${weekday} has no named greeting`
      );
    }

    const namelessCount = DASHBOARD_BRIEF_GREETINGS.filter(
      (greeting) => !greeting.text.includes("{name}")
    ).length;
    assert.ok(namelessCount >= 20, `only ${namelessCount} nameless greetings`);
  });

  it("is deterministic for the same owner and day", () => {
    const args = { dateKey: MONDAY, ownerName: "Ronak Chakraborty", seedKey: "user-1" };
    assert.equal(selectDashboardBriefGreeting(args), selectDashboardBriefGreeting(args));
  });

  it("uses the owner's first name and never leaks the token", () => {
    for (const dateKey of ["2026-08-16", MONDAY, "2026-08-18", "2026-08-19", "2026-08-20", FRIDAY, "2026-08-22"]) {
      for (let index = 0; index < 40; index += 1) {
        const greeting = selectDashboardBriefGreeting({
          dateKey,
          ownerName: "Ronak Chakraborty",
          seedKey: `user-${index}`,
        });
        assert.ok(!greeting.includes("{name}"), `token left in "${greeting}"`);
        assert.ok(!greeting.includes("Chakraborty"), `last name used in "${greeting}"`);
        assert.ok(greeting.includes("Ronak"), `name missing from "${greeting}"`);
      }
    }
  });

  it("only offers a weekday greeting on its own day", () => {
    const mondayOnly = DASHBOARD_BRIEF_GREETINGS
      .filter((greeting) => greeting.weekday === 1)
      .map((greeting) => greeting.text.replaceAll("{name}", "Ronak"));

    for (let index = 0; index < 200; index += 1) {
      const greeting = selectDashboardBriefGreeting({
        dateKey: FRIDAY,
        ownerName: "Ronak",
        seedKey: `user-${index}`,
      });
      assert.ok(!mondayOnly.includes(greeting), `Monday copy on Friday: "${greeting}"`);
      assert.ok(!greeting.includes("Monday"), `Monday copy on Friday: "${greeting}"`);
    }
  });

  it("rotates across owners and across days", () => {
    const acrossOwners = new Set(
      Array.from({ length: 60 }, (_, index) =>
        selectDashboardBriefGreeting({
          dateKey: MONDAY,
          ownerName: "Ronak",
          seedKey: `user-${index}`,
        })
      )
    );
    assert.ok(acrossOwners.size > 10, `only ${acrossOwners.size} distinct greetings across owners`);

    const acrossDays = new Set(
      Array.from({ length: 60 }, (_, index) => {
        const day = String(index + 1).padStart(2, "0");
        return selectDashboardBriefGreeting({
          dateKey: `2026-${index < 31 ? "03" : "04"}-${index < 31 ? day : String(index - 30).padStart(2, "0")}`,
          ownerName: "Ronak",
          seedKey: "user-1",
        });
      })
    );
    assert.ok(acrossDays.size > 10, `only ${acrossDays.size} distinct greetings across days`);
  });

  it("falls back to nameless copy when there is no usable name", () => {
    for (const ownerName of [null, undefined, "", "   ", "ronak@example.com", "Supercalifragilisticexpialidocious"]) {
      const greeting = selectDashboardBriefGreeting({
        dateKey: MONDAY,
        ownerName,
        seedKey: "user-1",
      });
      assert.ok(!greeting.includes("{name}"), `token left in "${greeting}"`);
      assert.ok(
        DASHBOARD_BRIEF_GREETINGS.some(
          (candidate) => candidate.text === greeting && !candidate.text.includes("{name}")
        ),
        `"${greeting}" is not nameless copy`
      );
    }
  });

  it("still returns copy for a malformed date key", () => {
    const greeting = selectDashboardBriefGreeting({
      dateKey: "not-a-date",
      ownerName: "Ronak",
      seedKey: "user-1",
    });
    assert.ok(greeting.length > 0);
    assert.ok(!greeting.includes("{name}"));
  });

  it("extracts a display-safe first name", () => {
    assert.equal(resolveDashboardOwnerFirstName("Ronak Chakraborty"), "Ronak");
    assert.equal(resolveDashboardOwnerFirstName("  ronak  "), "ronak");
    assert.equal(resolveDashboardOwnerFirstName("Mary-Kate Olsen"), "Mary-Kate");
    assert.equal(resolveDashboardOwnerFirstName("O'Brien"), "O'Brien");
    assert.equal(resolveDashboardOwnerFirstName("宮本 武蔵"), "宮本");
    assert.equal(resolveDashboardOwnerFirstName(""), null);
    assert.equal(resolveDashboardOwnerFirstName(null), null);
    assert.equal(resolveDashboardOwnerFirstName("ronak@example.com"), null);
    assert.equal(resolveDashboardOwnerFirstName("!!!"), null);
  });
});
