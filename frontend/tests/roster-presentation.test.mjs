import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { getRankColorTreatment, prefersDarkRankText } from "../src/lib/rank-color-treatment.ts";
import { bundle } from "./helpers/store-browser-harness.mjs";

const presentationBundle = bundle("production", { rosterPresentation: true });
const rosterStyles = await readFile(
  new URL("../src/components/students/student-records.module.css", import.meta.url),
  "utf8",
);

function row(id, firstName) {
  const student = {
    id,
    studio_id: "studio-1",
    legal_first_name: firstName,
    legal_last_name: "Student",
    preferred_name: null,
    email: `${id}@example.test`,
    phone: null,
    date_of_birth: null,
    is_minor: false,
    status: "active",
    program_id: null,
    membership_start_date: "2026-01-02",
    guardians: [],
    tags: [],
    notes: null,
    photo_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  return {
    student,
    programs: [],
    displayName: `${firstName} Student`,
    contact: student.email,
    search: { name: firstName.toLowerCase(), email: student.email, programs: "" },
    visibleTags: [],
    hiddenTagCount: 0,
  };
}

function rosterProps() {
  return {
    filtered: [row("student-a", "Ada"), row("student-b", "Bea")],
    sortDir: "asc",
    sortKey: "name",
  };
}

async function openPresentationPage(browser) {
  const page = await browser.newPage();
  await page.setContent('<main id="root"></main>');
  await page.evaluate(() => {
    window.fixture = {};
  });
  await page.addScriptTag({ content: presentationBundle });
  return page;
}

describe("roster presentation behavior", () => {
  let browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  it("uses one luminance rule for light, dark, short, and malformed rank colors", () => {
    for (const color of ["#FFFFFF", "#EAB308", "#767676", "#fff"]) {
      assert.equal(prefersDarkRankText(color), true, color);
      assert.equal(getRankColorTreatment(color).color, "#000000", color);
    }
    for (const color of ["#111111", "malformed"]) {
      assert.equal(prefersDarkRankText(color), false, color);
      assert.equal(getRankColorTreatment(color).color, "#ffffff", color);
    }
  });

  it("mounts mobile sort, responsive quick view, keyboard, open, selection, and both tip badges", async () => {
    const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
    await page.setContent(
      `<style>*{box-sizing:border-box}.px-4{padding-left:1rem;padding-right:1rem}${rosterStyles}</style><main id="root"></main>`,
    );
    await page.evaluate(() => {
      window.fixture = { opened: [], selected: [], sorts: [] };
    });
    await page.addScriptTag({ content: presentationBundle });
    await page.evaluate((props) => window.fixture.renderRoster(props), rosterProps());

    const sort = page.getByLabel("Sort students by");
    await sort.waitFor();
    assert.equal(await sort.isVisible(), true);
    assert.equal(await page.locator("thead").isVisible(), false);
    assert.equal(await page.locator("aside").isVisible(), false);
    await sort.selectOption("status");
    await page.evaluate((props) => window.fixture.renderRoster(props), {
      ...rosterProps(),
      sortKey: "status",
    });
    await page.getByRole("button", { name: "Sort descending" }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.sorts), ["status", "status"]);

    const beaRow = page.locator('[data-student-id="student-b"]');
    await beaRow.hover();
    assert.match(await page.getByLabel("Student quick view").textContent(), /Hover over or focus/);
    await beaRow.getByRole("button", { name: "Open Bea Student profile" }).focus();
    assert.match(await page.locator("aside").textContent(), /Bea Student/);
    await beaRow.getByRole("checkbox").click();
    await beaRow.getByRole("button", { name: "Open Bea Student profile" }).click();
    assert.deepEqual(
      await page.evaluate(() => ({
        opened: window.fixture.opened,
        selected: window.fixture.selected,
      })),
      {
        opened: ["student-b"],
        selected: ["student-b"],
      },
    );

    await page.setViewportSize({ width: 601, height: 900 });
    await page.locator(".rosterToolbar").evaluate((toolbar) => {
      toolbar.style.width = "521px";
    });
    const overlaps = await page.locator(".rosterToolbar").evaluate((toolbar) => {
      const controls = [...toolbar.querySelectorAll("input, select, button")].filter((control) => {
        const style = getComputedStyle(control);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      return controls.flatMap((control, index) =>
        controls.slice(index + 1).flatMap((other) => {
          const a = control.getBoundingClientRect();
          const b = other.getBoundingClientRect();
          const intersects =
            a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return intersects
            ? [
                [
                  control.getAttribute("aria-label") ?? control.tagName,
                  other.getAttribute("aria-label") ?? other.tagName,
                ],
              ]
            : [];
        }),
      );
    });
    assert.deepEqual(overlaps, []);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator(".rosterToolbar").evaluate((toolbar) => {
      toolbar.style.width = "auto";
    });
    assert.equal(await sort.isVisible(), false);
    assert.equal(await page.locator("thead").isVisible(), true);
    await page.locator('[data-student-id="student-a"]').hover();
    assert.equal(await page.locator("aside").isVisible(), true);
    assert.match(await page.locator("aside").textContent(), /Ada Student/);

    await page.evaluate(() => window.fixture.renderBadges());
    const badges = page.locator("#root > div > span");
    assert.equal(await badges.count(), 2);
    for (const badge of await badges.all()) {
      assert.equal(await badge.evaluate((node) => getComputedStyle(node).color), "rgb(0, 0, 0)");
      assert.equal(await badge.locator('span[style*="rgb(34, 197, 94)"]').count(), 1);
    }
  });

  it("distinguishes loading and unavailable student facts from confirmed empty data", async () => {
    const page = await openPresentationPage(browser);
    const eligibilityGroup = {
      key: "blue",
      label: "Blue",
      rank: null,
      color: null,
      eligibleCount: 1,
      approvalCount: 0,
      entries: [
        {
          student_id: "student-a",
          student_name: "Ada Student",
          current_rank_id: "blue",
          next_rank_id: "purple",
          classes_since_promo: 20,
          classes_required: 10,
          days_at_rank: 90,
          days_required: 60,
          classes_met: true,
          time_met: true,
          needs_approval: false,
        },
      ],
    };
    await page.evaluate((eligibilityGroup) => {
      const noop = () => {};
      window.fixture.retries = 0;
      window.fixture.eligibilityProps = {
        canConfigureBelts: false,
        canPromoteStudents: true,
        collapsedGroups: new Set(),
        eligibilityGroups: [eligibilityGroup],
        eligibilityLoadError: null,
        isEligibilityLoading: true,
        isEligibilityLoadErrorDismissed: false,
        isProgramsLoadErrorDismissed: false,
        ladderError: null,
        onConfigureRanks: noop,
        onDismissEligibilityLoadError: noop,
        onDismissLadderError: noop,
        onDismissProgramsLoadError: noop,
        onRetryEligibility: () => {
          window.fixture.retries += 1;
        },
        onStartPromotion: noop,
        onStartDemotion: noop,
        onToggleGroup: noop,
        onViewStudents: noop,
        programsLoadError: null,
        rankById: new Map(),
        previousRankByCurrentRankId: new Map([["blue", { id: "white" }]]),
        selectedProgramName: "Kids",
      };
      window.fixture.renderEligibility(window.fixture.eligibilityProps);
    }, eligibilityGroup);
    await page.getByText("Loading eligibility for Kids...").waitFor();
    assert.equal(await page.getByText("Ada Student", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Promote|Demote/ }).count(), 0);

    await page.evaluate(() =>
      window.fixture.renderEligibility({
        ...window.fixture.eligibilityProps,
        eligibilityLoadError: "Eligibility failed.",
        isEligibilityLoading: false,
        isEligibilityLoadErrorDismissed: true,
      }),
    );
    await page.getByText(/Showing the last loaded eligibility/).waitFor();
    await page.getByText("Ada Student", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Promote", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Demote", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.retries), 1);

    await page.evaluate(() =>
      window.fixture.renderEligibility({
        ...window.fixture.eligibilityProps,
        eligibilityGroups: [],
        eligibilityLoadError: "Eligibility failed.",
        isEligibilityLoading: false,
        isEligibilityLoadErrorDismissed: true,
      }),
    );
    await page.getByText("Student eligibility is unavailable.", { exact: true }).waitFor();
    assert.equal(await page.getByText(/No students|no active students/i).count(), 0);
    await page.evaluate(() =>
      window.fixture.renderEligibility({
        ...window.fixture.eligibilityProps,
        eligibilityGroups: [],
        eligibilityLoadError: null,
        isEligibilityLoading: false,
      }),
    );
    await page.getByText("No students to evaluate", { exact: true }).waitFor();

    const session = {
      id: "session-1",
      studio_id: "studio-1",
      name: "Basics",
      date: "2026-09-06",
      start_time: "18:00:00",
      end_time: "19:00:00",
      status: "scheduled",
      capacity: null,
      program_id: null,
    };
    for (const [props, message] of [
      [{ isLoadingStudentRoster: true }, "Loading the student roster."],
      [{ studentRosterError: "Roster failed." }, "The student roster is unavailable."],
      [
        {},
        "The student roster is incomplete. Attendance will be available after all students load.",
      ],
      [
        { isStudentRosterComplete: true },
        "No active students. Add students first to take attendance.",
      ],
    ]) {
      await page.evaluate(
        ({ session, props }) => {
          const noop = () => {};
          window.fixture.renderSession({
            canManageSchedule: false,
            open: true,
            session,
            students: [],
            attendance: [],
            onClose: noop,
            onToggleAttendance: noop,
            onDeleteSession: noop,
            ...props,
          });
        },
        { session, props },
      );
      await page.getByText(message, { exact: true }).waitFor();
    }

    const student = row("student-d", "Dee").student;
    await page.evaluate((student) => {
      const noop = () => {};
      window.fixture.sidebarProps = {
        canManageRoster: false,
        student,
        fullName: "Dee Student",
        programs: [],
        activeProgramIds: [],
        photoPreviewUrl: null,
        photoError: null,
        isPhotoSaving: false,
        onPhotoSelected: noop,
        onDeletePhoto: noop,
        isCurrentHold: false,
        promotionCount: 0,
        isLoadingBeltData: true,
        beltLoadError: null,
        businessDate: "2026-09-06",
      };
      window.fixture.renderSidebar(window.fixture.sidebarProps);
    }, student);
    await page.getByText("Loading rank…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Loading…", { exact: true }).count(), 3);
    assert.equal(await page.getByText(/No rank assigned|Top of ladder/).count(), 0);
    await page.evaluate(() =>
      window.fixture.renderSidebar({
        ...window.fixture.sidebarProps,
        currentRank: { name: "White", color_hex: "#fff", ladderName: "Kids" },
        isLoadingBeltData: false,
        beltLoadError: "Belt history failed.",
      }),
    );
    await page.getByText("White", { exact: true }).waitFor();
    assert.equal(await page.getByText("Unavailable", { exact: true }).count(), 3);
    assert.equal(await page.getByText(/No rank assigned|Top of ladder/).count(), 0);
    await page.evaluate(() =>
      window.fixture.renderSidebar({
        ...window.fixture.sidebarProps,
        isLoadingBeltData: false,
        beltLoadError: null,
      }),
    );
    await page.getByText("No rank assigned", { exact: true }).waitFor();
    await page.getByText("0", { exact: true }).waitFor();
  });

  it("calculates calendar birthdays from the supplied business date", async () => {
    const page = await openPresentationPage(browser);
    const student = row("student-d", "Dee").student;
    for (const [dateOfBirth, businessDate, age] of [
      ["2008-09-07", "2026-09-06", "17 yrs"],
      ["2008-09-07", "2026-09-07", "18 yrs"],
      ["2008-02-29", "2026-02-28", "17 yrs"],
      ["2008-02-29", "2026-03-01", "18 yrs"],
    ]) {
      await page.evaluate(
        ({ student, dateOfBirth, businessDate }) => {
          const noop = () => {};
          window.fixture.sidebarProps = {
            canManageRoster: false,
            student: { ...student, date_of_birth: dateOfBirth },
            fullName: "Dee Student",
            programs: [],
            activeProgramIds: [],
            photoPreviewUrl: null,
            photoError: null,
            isPhotoSaving: false,
            onPhotoSelected: noop,
            onDeletePhoto: noop,
            isCurrentHold: false,
            promotionCount: 0,
            isLoadingBeltData: false,
            beltLoadError: null,
            businessDate,
          };
          window.fixture.renderSidebar(window.fixture.sidebarProps);
        },
        { student, dateOfBirth, businessDate },
      );
      await page.getByText(age, { exact: true }).waitFor();
    }
    await page.evaluate(
      ({ student }) => {
        const props = window.fixture.sidebarProps;
        window.fixture.renderSidebar({ ...props, student: { ...student, date_of_birth: null } });
      },
      { student },
    );
    await page
      .getByText("Age", { exact: true })
      .locator("..")
      .getByText("—", { exact: true })
      .waitFor();
  });

  it("keeps mapping IDs and labels unique across colliding header slugs and two instances", async () => {
    const page = await openPresentationPage(browser);
    await page.evaluate(() => {
      window.fixture.mappingChanges = [];
      const props = (instance) => ({
        fileName: `${instance}.csv`,
        headers: ["First Name", "First-Name"],
        isLoading: false,
        mapping: { "First Name": "legal_first_name", "First-Name": "legal_last_name" },
        rowCount: 1,
        rows: [{ "First Name": "Ari", "First-Name": "Lane" }],
        onMappingChange: (header, field) => {
          window.fixture.mappingChanges.push([instance, header, field]);
        },
        onReset: () => {},
        onValidate: () => {},
      });
      window.fixture.renderMappings([props("one"), props("two")]);
    });
    const selects = page.locator("select");
    await selects.first().waitFor();
    const ids = await selects.evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
    assert.equal(await page.getByLabel("Koaryu field for First Name").count(), 2);
    assert.equal(await page.getByLabel("Koaryu field for First-Name").count(), 2);
    await selects.first().selectOption("preferred_name");
    assert.deepEqual(await page.evaluate(() => window.fixture.mappingChanges), [
      ["one", "First Name", "preferred_name"],
    ]);
  });
});
