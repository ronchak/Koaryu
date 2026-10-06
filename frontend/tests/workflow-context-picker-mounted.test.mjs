import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "@playwright/test";
import { mountTools, flush } from "./helpers/workflow-tools-fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const picker = (page) => page.getByLabel("Current record picker", { exact: true });
const selected = (page) => page.evaluate(() => window.fixture.selection?.context ?? null);
const sourceCalls = (page, kind) =>
  page.evaluate((kind) => window.fixture.sources.filter((row) => row.kind === kind), kind);
async function chooseReal(page) {
  await button(page, "Choose real record").click();
}
async function chooseParent(page, kind) {
  if (kind === "student") {
    await button(page, "Search students").click();
    await picker(page)
      .getByRole("button", { name: /^Student, Alex/ })
      .click();
  } else if (kind === "lead") {
    await button(page, "Load lead records").click();
    await picker(page)
      .getByRole("button", { name: /^Casey Lead/ })
      .click();
  } else {
    await button(page, "Load events").click();
    await picker(page)
      .getByRole("button", { name: /^Autumn grading/ })
      .click();
  }
}
const cases = [
  {
    type: "student",
    load: "Search students",
    match: /^Student, Alex/,
    source: "students",
    label: "active",
  },
  {
    type: "promotion",
    parent: "student",
    load: "Load promotion records",
    match: /^Alex Student.*White to Yellow/,
    source: "promotions",
    label: "White to Yellow",
  },
  {
    type: "lead",
    load: "Load lead records",
    match: /^Casey Lead/,
    source: "leads",
    label: "inquiry",
  },
  {
    type: "trial_appointment",
    parent: "lead",
    load: "Load trial appointment records",
    match: /^Casey Lead.*North studio/,
    source: "trials",
    label: "North studio",
  },
  {
    type: "invoice",
    load: "Load invoice records",
    match: /^Invoice INV-501/,
    source: "invoices",
    label: "$123.45",
  },
  {
    type: "payment",
    load: "Load payment records",
    match: /^Payment Ref/,
    source: "payments",
    label: "$67.89",
  },
  {
    type: "belt_test_recipient",
    parent: "event",
    load: "Load belt test recipient records",
    match: /^Student name unavailable/,
    source: "recipients",
    label: "Recorded 2026-10-02",
  },
];
for (const entry of cases)
  test(`${entry.type} selects the exact scoped child ID and real returned label`, () =>
    mountTools(
      async (page) => {
        assert.deepEqual(await selected(page), { kind: "synthetic" });
        assert.equal(
          await page.evaluate(() => window.fixture.sources.length + window.fixture.reads.length),
          0,
        );
        await chooseReal(page);
        assert.equal(
          await page.evaluate(() => window.fixture.sources.length + window.fixture.reads.length),
          0,
        );
        if (entry.parent) await chooseParent(page, entry.parent);
        await button(page, entry.load).click();
        const row = picker(page).getByRole("button", { name: entry.match });
        await expect(row).toContainText(entry.label);
        await row.click();
        const expectedId = await page.evaluate(
          (source) => window.fixture.resources[source][0].id,
          entry.source,
        );
        assert.deepEqual(await selected(page), {
          kind: "entity",
          entity_type: entry.type,
          entity_id: expectedId,
        });
        assert.equal(await page.evaluate(() => window.fixture.selection.isCurrent()), true);
        assert.equal(await page.getByRole("textbox", { name: /UUID|ID/ }).count(), 0);
        await expect(picker(page)).not.toContainText("PRIVATE FAILURE");
      },
      { picker: true, entityType: entry.type },
    ));

test("student search normalizes to existing 80-character contract with explicit pages and no roster scan", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.getByRole("textbox", { name: "Find student" }).fill("  Alex,%_(  ");
      assert.equal((await sourceCalls(page, "students")).length, 0);
      await button(page, "Search students").click();
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeEnabled();
      const first = (await sourceCalls(page, "students"))[0].query;
      assert.equal(first.search, "Alex");
      assert.equal(first.pageSize, 50);
      assert.equal(first.signal, true);
      assert.equal(first.fullRoster, undefined);
      await button(page, "Next records").click();
      await expect(picker(page)).toContainText("No matching records");
      assert.equal((await sourceCalls(page, "students"))[1].query.cursor, "student opaque+/=");
      await button(page, "Back records").click();
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeEnabled();
      assert.equal((await sourceCalls(page, "students")).length, 3);
    },
    { picker: true },
  ));

test("changed student search invalidates held read and previous selected context permanently", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await button(page, "Search students").click();
      await picker(page)
        .getByRole("button", { name: /^Student, Alex/ })
        .click();
      await page.evaluate(() => {
        window.oldSelection = window.fixture.selection;
        window.fixture.hold.students = true;
      });
      await button(page, "Search students").click();
      await page.getByRole("textbox", { name: "Find student" }).fill("Blair");
      await page.evaluate(() => window.fixture.release("students"));
      await flush(page);
      assert.equal(await page.evaluate(() => window.oldSelection.isCurrent()), false);
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeDisabled();
      assert.equal(await selected(page), null);
    },
    { picker: true },
  ));

test("failed student refresh keeps old rows unavailable until explicit current retry", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await button(page, "Search students").click();
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeEnabled();
      await page.evaluate(() => {
        window.fixture.errors.students = 503;
      });
      await button(page, "Search students").click();
      await expect(picker(page).getByRole("alert")).toBeVisible();
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeDisabled();
      await page.evaluate(() => {
        delete window.fixture.errors.students;
      });
      await button(page, "Retry records").click();
      await expect(picker(page).getByRole("button", { name: /^Student, Alex/ })).toBeEnabled();
    },
    { picker: true },
  ));

for (const type of ["student", "promotion"])
  test(`${type} stale token completion exposes retry instead of ready-empty`, () =>
    mountTools(
      async (page) => {
        await chooseReal(page);
        if (type === "promotion") await chooseParent(page, "student");
        const source = type === "student" ? "students" : "promotions";
        await page.evaluate((source) => {
          window.fixture.hold[source] = true;
        }, source);
        await button(
          page,
          type === "student" ? "Search students" : "Load promotion records",
        ).click();
        await button(page, "Renew token fixture").click();
        await page.evaluate((source) => window.fixture.release(source), source);
        await expect(picker(page).getByRole("alert")).toBeVisible();
        if (type === "promotion") {
          await expect(button(page, "Retry records")).toBeDisabled();
          await expect(button(page, "Change parent record")).toBeEnabled();
          await expect(picker(page)).toContainText("parent selection is no longer current");
        } else await expect(button(page, "Retry records")).toBeEnabled();
        assert.equal(await selected(page), null);
      },
      { picker: true, entityType: type },
    ));

test("promotion explicitly forces history and ignores completion after parent replacement", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await chooseParent(page, "student");
      await page.evaluate(() => {
        window.fixture.hold.promotions = true;
      });
      await button(page, "Load promotion records").click();
      const call = (await sourceCalls(page, "promotions"))[0];
      assert.equal(call.query.force, true);
      assert.equal(call.query.studentId, "00000011-0000-4000-8000-000000000001");
      await button(page, "Change parent record").click();
      await page.evaluate(() => window.fixture.release("promotions"));
      await flush(page);
      await expect(picker(page).getByRole("button", { name: /White to Yellow/ })).toHaveCount(0);
      assert.equal(await selected(page), null);
    },
    { picker: true, entityType: "promotion" },
  ));

test("lead uses provider-published cache and failed refresh cannot become ready-empty", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await button(page, "Load lead records").click();
      await expect(picker(page).getByRole("button", { name: /^Casey Lead/ })).toBeEnabled();
      await page.evaluate(() => {
        window.fixture.errors.leads = 503;
      });
      await button(page, "Load lead records").click();
      await expect(picker(page).getByRole("alert")).toBeVisible();
      await expect(picker(page).getByRole("button", { name: /^Casey Lead/ })).toBeDisabled();
      await expect(picker(page)).not.toContainText("No matching records");
      assert.equal(await selected(page), null);
    },
    { picker: true, entityType: "lead" },
  ));

test("held lead refresh succeeds after same-owner token renewal using actual published cache", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.leads = true;
      });
      await button(page, "Load lead records").click();
      await button(page, "Renew token fixture").click();
      await page.evaluate(() => {
        const f = window.fixture;
        f.hold.leads = false;
        f.release("leads");
      });
      await expect(picker(page).getByRole("button", { name: /^Casey Lead/ })).toBeEnabled();
      await expect(picker(page)).not.toContainText("Loading records");
      assert.equal((await sourceCalls(page, "leads")).length, 2);
      await picker(page)
        .getByRole("button", { name: /^Casey Lead/ })
        .click();
      assert.equal(await page.evaluate(() => window.fixture.selection.isCurrent()), true);
    },
    { picker: true, entityType: "lead" },
  ));

test("same-identity lead resource reset cannot turn a superseded promise into ready-empty", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.leads = true;
      });
      await button(page, "Load lead records").click();
      await page.evaluate(() => window.fixture.resetLeads());
      await page.evaluate(() => window.fixture.release("leads"));
      await expect(picker(page).getByRole("alert")).toBeVisible();
      await expect(picker(page)).not.toContainText("No matching records");
      await expect(picker(page).getByRole("button", { name: /^Casey Lead/ })).toHaveCount(0);
      await expect(button(page, "Retry records")).toBeEnabled();
    },
    { picker: true, entityType: "lead" },
  ));

test("superseded lead promise without cache publication remains unavailable", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.leads = true;
      });
      await button(page, "Load lead records").click();
      await page.evaluate(() => {
        const f = window.fixture;
        f.supersedeLeads();
        f.release("leads");
      });
      await expect(picker(page).getByRole("alert")).toBeVisible();
      assert.equal(await selected(page), null);
    },
    { picker: true, entityType: "lead" },
  ));

for (const type of ["trial_appointment", "belt_test_recipient"])
  test(`${type} pages current scoped parent and rejects old resource reads`, () =>
    mountTools(
      async (page) => {
        const trial = type === "trial_appointment",
          source = trial ? "trials" : "recipients",
          load = trial ? "Load trial appointment records" : "Load belt test recipient records";
        await chooseReal(page);
        await chooseParent(page, trial ? "lead" : "event");
        await button(page, load).click();
        await expect(button(page, "Next records")).toBeEnabled();
        assert.equal((await sourceCalls(page, source))[0].query.limit, 50);
        await button(page, "Next records").click();
        await expect(picker(page)).toContainText("No matching records");
        assert.equal((await sourceCalls(page, source))[1].query.cursor, "source opaque+/=");
        await button(page, "Back records").click();
        await expect(button(page, "Next records")).toBeEnabled();
        await page.evaluate((source) => {
          window.fixture.hold[source] = true;
        }, source);
        await button(page, load).click();
        await page.evaluate((source) => {
          window.fixture.sourceEpoch++;
          window.fixture.notify();
          window.fixture.release(source);
        }, source);
        await expect(picker(page).getByRole("alert")).toBeVisible();
        assert.equal(await selected(page), null);
      },
      { picker: true, entityType: type },
    ));

for (const type of ["invoice", "payment"])
  test(`${type} uses only exact bounded typed page routes and opaque cursors`, () =>
    mountTools(
      async (page) => {
        await chooseReal(page);
        await button(page, `Load ${type} records`).click();
        await expect(button(page, "Next records")).toBeEnabled();
        const first = await page.evaluate(() => window.fixture.reads[0]);
        assert.equal(first.path, `/billing/${type}s/page?limit=50`);
        assert.equal(first.signal, true);
        await button(page, "Next records").click();
        await expect(picker(page)).toContainText("No matching records");
        assert.equal(
          await page.evaluate(() => window.fixture.reads[1].path),
          `/billing/${type}s/page?limit=50&cursor=billing%20opaque%2B%2F%3D`,
        );
        const paths = await page.evaluate(() => window.fixture.reads.map((row) => row.path));
        assert.ok(paths.every((path) => path.startsWith(`/billing/${type}s/page?limit=50`)));
        assert.equal(await page.evaluate(() => window.fixture.sources.length), 0);
        await button(page, "Back records").click();
        await expect(button(page, "Next records")).toBeEnabled();
      },
      { picker: true, entityType: type },
    ));

test("billing same-owner token renewal retries bounded read and publishes only current result", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.payments = true;
      });
      await button(page, "Load payment records").click();
      await button(page, "Renew token fixture").click();
      await page.evaluate(() => {
        const f = window.fixture;
        f.hold.payments = false;
        f.release("payments");
      });
      await expect(picker(page).getByRole("button", { name: /^Payment Ref/ })).toBeEnabled();
      const reads = await page.evaluate(() => window.fixture.reads);
      assert.equal(reads.length, 2);
      assert.notEqual(reads[0].token, reads[1].token);
    },
    { picker: true, entityType: "payment" },
  ));

test("billing failure retains unavailable rows without raw provider errors or label-only invoice calls", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await button(page, "Load payment records").click();
      await expect(picker(page).getByRole("button", { name: /^Payment Ref/ })).toBeEnabled();
      await page.evaluate(() => {
        window.fixture.errors.payments = 503;
      });
      await button(page, "Load payment records").click();
      await expect(picker(page).getByRole("button", { name: /^Payment Ref/ })).toBeDisabled();
      await expect(picker(page)).not.toContainText("PRIVATE");
      assert.equal(
        await page.evaluate(() =>
          window.fixture.reads.some(
            (row) =>
              row.path.includes("invoice") ||
              row.path.includes("connect") ||
              row.path.includes("landing"),
          ),
        ),
        false,
      );
    },
    { picker: true, entityType: "payment" },
  ));

test("recipient labels use already available student/rank names and retain recorded context", () =>
  mountTools(
    async (page) => {
      await page.evaluate(() => window.fixture.change({ availableStudentLabels: true }));
      await chooseReal(page);
      await chooseParent(page, "event");
      await button(page, "Load belt test recipient records").click();
      const row = picker(page).getByRole("button", { name: /^Student, Alex.*Yellow/ });
      await expect(row).toContainText("Recorded 2026-10-02");
      await expect(row).toContainText("Autumn grading");
      await expect(picker(page)).toContainText("does not establish current eligibility");
      assert.equal((await sourceCalls(page, "students")).length, 0);
    },
    { picker: true, entityType: "belt_test_recipient" },
  ));

test("local loaded-row search preserves context until another record is chosen", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await button(page, "Load lead records").click();
      await picker(page)
        .getByRole("button", { name: /^Casey Lead/ })
        .click();
      await page.evaluate(() => {
        window.oldSelection = window.fixture.selection;
      });
      const context = await selected(page);
      await page.getByRole("textbox", { name: "Search loaded records" }).fill("Drew");
      await expect(picker(page).getByRole("button", { name: /^Casey Lead/ })).toHaveCount(0);
      await expect(picker(page).getByRole("button", { name: /^Drew Lead/ })).toBeEnabled();
      assert.deepEqual(await selected(page), context);
      assert.equal(await page.evaluate(() => window.oldSelection.isCurrent()), true);
      await picker(page)
        .getByRole("button", { name: /^Drew Lead/ })
        .click();
      assert.notDeepEqual(await selected(page), context);
      assert.equal(await page.evaluate(() => window.oldSelection.isCurrent()), false);
      assert.equal((await sourceCalls(page, "leads")).length, 1);
    },
    { picker: true, entityType: "lead" },
  ));

test("source type replacement and owner loss discard held source reads", () =>
  mountTools(
    async (page) => {
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.students = true;
      });
      await button(page, "Search students").click();
      await page.evaluate(() => {
        window.fixture.setType("lead");
        window.fixture.release("students");
      });
      await flush(page);
      await expect(page.getByRole("button", { name: /^Student, Alex/ })).toHaveCount(0);
      await chooseReal(page);
      await page.evaluate(() => {
        window.fixture.hold.leads = true;
      });
      await button(page, "Load lead records").click();
      await button(page, "Switch authority fixture").click();
      await page.evaluate(() => window.fixture.release("leads"));
      await flush(page);
      await expect(page.getByRole("button", { name: /^Casey Lead/ })).toHaveCount(0);
    },
    { picker: true },
  ));

test("large returned lead collection renders 50 matches and searches the full loaded collection", () =>
  mountTools(
    async (page) => {
      await page.evaluate(() => {
        window.fixture.resources.leads = Array.from({ length: 75 }, (_, index) => ({
          id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`,
          first_name: `Person ${String(index).padStart(2, "0")}`,
          last_name: "Lead",
          stage: "inquiry",
        }));
      });
      await chooseReal(page);
      await button(page, "Load lead records").click();
      await expect(picker(page)).toContainText("Showing 50 of 75 loaded matches");
      assert.equal(await picker(page).locator("ul > li").count(), 50);
      await page.getByRole("textbox", { name: "Search loaded records" }).fill("Person 74");
      await expect(picker(page).getByRole("button", { name: /^Person 74/ })).toBeEnabled();
      assert.equal(await picker(page).locator("ul > li").count(), 1);
      await picker(page)
        .getByRole("button", { name: /^Person 74/ })
        .click();
      const context = await selected(page);
      await page.getByRole("textbox", { name: "Search loaded records" }).fill("");
      assert.equal(await picker(page).locator("ul > li").count(), 50);
      await expect(picker(page).getByRole("button", { name: /^Person 74/ })).toHaveCount(0);
      await expect(page.getByText(/^Context: Person 74 Lead/)).toBeVisible();
      assert.deepEqual(await selected(page), context);
      assert.equal(await page.evaluate(() => window.fixture.selection.isCurrent()), true);
      assert.equal((await sourceCalls(page, "leads")).length, 1);
    },
    { picker: true, entityType: "lead" },
  ));
