import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import {
  mountBeltPanel,
  fixture,
  EVENT,
  OTHER,
  DRAFT,
  KEY,
  eventRoute,
  fillBeltSchedule,
  flush,
  commit,
} from "./helpers/belt-test-panel-mounted.mjs";
import { marker } from "./helpers/belt-test-mounted.mjs";

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});
async function mount(t, options) {
  const panel = await mountBeltPanel(browser, options);
  t.after(async () => {
    await panel.close();
    assert.deepEqual(panel.errors, []);
  });
  return panel.p;
}
async function open(t, options = {}) {
  const p = await mount(t, { route: eventRoute, ...options });
  await expect(p.getByRole("heading", { name: "Sample belt test", exact: true })).toBeVisible();
  return p;
}
async function draft(t, options = {}) {
  const p = await mount(t, { route: `/belt-tests?draft=${DRAFT}`, events: [], ...options });
  await p.getByLabel("Name", { exact: true }).fill("New sample test");
  await p.getByLabel("Belt plan", { exact: true }).selectOption(fixture.ids.ladder);
  await fillBeltSchedule(p);
  return p;
}
async function confirmChange(p, action = "Save details") {
  await p.getByRole("button", { name: action, exact: true }).click();
  await p.getByRole("button", { name: "Confirm change", exact: true }).click();
}
const reads = (p) => p.evaluate(() => f.beltReads.map((row) => row.path));
const body = (p, index = 0) => p.evaluate((index) => JSON.parse(f.writes[index].body), index);

test("cold list independently loads metadata and event page without tracker selection or roster bootstrap", async (t) => {
  const p = await mount(t);
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
  assert.deepEqual(
    (await reads(p)).sort(),
    ["/belt-tests?limit=50", "/belts/ladders", "/programs?include_archived=true"].sort(),
  );
  assert.equal(await p.evaluate(() => f.store.currentLadderId), null);
  assert.equal(
    await p.evaluate(() => f.reads.some((row) => /students|bootstrap/.test(row.path))),
    false,
  );
});

for (const role of ["front_desk", "instructor", "student"])
  test(`${role} makes no belt API, metadata or journal reads`, async (t) => {
    const p = await mount(t, { role });
    await expect(p.getByText("Belt tests require current administrator access.")).toBeVisible();
    assert.deepEqual(await reads(p), []);
    assert.equal(await p.evaluate(() => beltStorageReads + beltStorageWrites), 0);
  });

test("unverified identity is inert until verified", async (t) => {
  const p = await mount(t, { unverified: true });
  assert.deepEqual(await reads(p), []);
  assert.equal(await p.evaluate(() => beltStorageReads), 0);
  await p.evaluate(() => f.finishIdentity());
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
});

test("sample preview uses actual provider references and zero API/journal I/O", async (t) => {
  const p = await mount(t, { preview: true });
  await expect(
    p.getByText("Sample belt tests only. No live requests or deliveries."),
  ).toBeVisible();
  await p.getByRole("button", { name: "New belt test", exact: true }).click();
  await expect(p.getByLabel("Belt plan", { exact: true })).toBeVisible();
  assert.deepEqual(await reads(p), []);
  assert.equal(await p.evaluate(() => beltStorageReads + beltStorageWrites), 0);
});

test("server route rejects ambiguous, array, empty and malformed targets before panel reads", async (t) => {
  const p = await mount(t, { role: "instructor" });
  const outcomes = await p.evaluate(
    async ({ EVENT }) => {
      const invalid = [
        { draft: EVENT, event: EVENT },
        { draft: [EVENT] },
        { event: [] },
        { draft: "" },
        { event: "invalid" },
      ];
      return Promise.all(
        invalid.map(async (search) => {
          try {
            await f.renderPage({ searchParams: Promise.resolve(search) });
            return "accepted";
          } catch (error) {
            return error.message;
          }
        }),
      );
    },
    { EVENT },
  );
  assert.deepEqual(outcomes, Array(5).fill("Not found"));
  assert.deepEqual(await reads(p), []);
});

test("new draft requires a deliberate plan and a complete resolved schedule", async (t) => {
  const p = await mount(t, { route: `/belt-tests?draft=${DRAFT}` });
  await expect(p.getByLabel("Belt plan", { exact: true })).toHaveValue("");
  await expect(p.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await p.getByLabel("Name", { exact: true }).fill("Sample");
  await p.getByLabel("Belt plan", { exact: true }).selectOption(fixture.ids.ladder);
  await expect(p.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  assert.equal(await p.evaluate(() => f.writes.length), 0);
});

for (const [action, status] of [
  ["Save draft", "draft"],
  ["Schedule event", "scheduled"],
])
  test(`create ${status} adopts confirmed event and never repeats the logical draft`, async (t) => {
    const p = await draft(t);
    await confirmChange(p, action);
    assert.equal((await body(p)).status, status);
    await commit(p);
    await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeVisible();
    assert.equal(await p.evaluate(() => f.route), eventRoute);
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    assert.equal(
      (await reads(p)).some((path) => path.endsWith("/candidates")),
      status === "scheduled",
    );
  });

test("name-only edit normalizes Unicode whitespace and preserves fractional saved schedule", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("\u0085Renamed\u2007");
  await p.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(p.getByText("Name-only changes preserve recorded approvals.")).toBeVisible();
  await p.getByRole("button", { name: "Confirm change" }).click();
  const sent = await body(p);
  assert.deepEqual(Object.keys(sent).sort(), ["operation_id", "expected_revision", "name"].sort());
  assert.equal(sent.name, "Renamed");
  await commit(p);
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Renamed");
  assert.equal(await p.evaluate(() => f.events[0].starts_at), fixture.events.scheduled.starts_at);
});

test("unchanged save sends zero commands", async (t) => {
  const p = await open(t);
  await p.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(p.getByText("No details changed.")).toBeVisible();
  assert.equal(await p.evaluate(() => f.writes.length), 0);
});

test("candidate rows retain unmet requirements and approval-needed candidates remain selectable", async (t) => {
  const p = await open(t);
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeEnabled();
  await expect(
    p.getByRole("checkbox", { name: "Sample threshold review", exact: true }),
  ).toBeDisabled();
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await expect(p.getByRole("button", { name: "Complete event", exact: true })).toBeDisabled();
  await p.getByRole("button", { name: "Approve selected (1/100)" }).click();
  await expect(
    p.getByText("Approval does not promote students or guarantee delivery."),
  ).toBeVisible();
  await p.getByRole("button", { name: "Confirm approval" }).click();
  assert.deepEqual((await body(p)).recipients, [
    { student_id: fixture.ids.student, student_program_membership_id: fixture.ids.membership },
  ]);
  await commit(p);
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).not.toBeChecked();
  assert.equal((await reads(p)).filter((path) => path.includes("/recipients?")).length, 2);
});

test("approved history offers explicit Reapprove and names saved rank context", async (t) => {
  const p = await open(t);
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  await p.getByRole("button", { name: "Reapprove", exact: true }).click();
  await p.getByRole("button", { name: "Confirm approval" }).click();
  assert.equal((await body(p)).recipients.length, 1);
  await commit(p);
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("revoke exact-reads event and recipient before confirmation and shows later reapproval", async (t) => {
  const p = await open(t);
  await p.getByRole("button", { name: "Revoke approval" }).click();
  await expect(p.getByRole("dialog", { name: "Confirm recipient revocation" })).toBeVisible();
  assert.deepEqual((await reads(p)).slice(-2), [
    `/belt-tests/${EVENT}`,
    `/belt-tests/${EVENT}/recipients/${fixture.ids.recipient}`,
  ]);
  await p.getByRole("button", { name: "Confirm revoke" }).click();
  await commit(p, { reapprove: true });
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  assert.equal(await p.evaluate(() => f.recipients[0].revision), 4);
});

for (const failure of ["/belts/ladders", "/programs?include_archived=true"])
  test(`metadata outage ${failure} leaves event history and explicit retry available`, async (t) => {
    const p = await open(t, { failures: { [failure]: 503 } });
    await expect(p.getByRole("button", { name: "Retry reference choices" })).toBeVisible();
    await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
    await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
    await p.evaluate(() => {
      f.failures = {};
    });
    await p.getByRole("button", { name: "Retry reference choices" }).click();
    await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeEnabled();
  });

test("ready-empty references differ from errors and published program cache errors disable mutation", async (t) => {
  const p = await open(t, { ladders: [], programs: [] });
  await expect(p.getByText("No belt plans are available.")).toBeVisible();
  await expect(p.getByRole("button", { name: "Retry reference choices" })).toHaveCount(0);
  await p.evaluate(async () => {
    f.failures["/programs?include_archived=true"] = 503;
    await f.store.refreshPrograms({ includeArchived: true, force: true }).catch(() => {});
  });
  await expect(p.getByRole("button", { name: "Retry reference choices" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Cancel event", exact: true })).toBeEnabled();
});

test("resource reset drops local dirty state and ignores old reference completions", async (t) => {
  const p = await open(t, { holds: ["/programs", "/belts/ladders"] });
  await p.getByLabel("Name", { exact: true }).fill("Old local input");
  await p.evaluate(async () => {
    await f.resetBeltResource();
    f.holds = [];
    f.finishReads();
  });
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Sample belt test");
  assert.equal(await p.evaluate(() => f.writes.length), 0);
});

for (const status of ["draft", "completed", "canceled"])
  test(`${status} history never requests scheduled-event candidates`, async (t) => {
    const p = await open(t, { events: [fixture.events[status]] });
    await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
    assert.equal(
      (await reads(p)).some((path) => path.endsWith("/candidates")),
      false,
    );
    if (status !== "draft")
      await expect(
        p.getByText("This event is history. Its details cannot be changed."),
      ).toBeVisible();
  });

test("status confirmation uses saved details and dirty selection blocks lifecycle actions", async (t) => {
  const p = await open(t, { events: [fixture.events.draft] });
  await p.getByRole("button", { name: "Schedule event", exact: true }).click();
  await expect(p.getByRole("dialog")).toContainText("Sample room");
  await p.getByRole("button", { name: "Confirm change" }).click();
  assert.equal((await body(p)).status, "scheduled");
  await commit(p);
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeEnabled();
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await expect(p.getByRole("button", { name: "Cancel event", exact: true })).toBeDisabled();
});

test("dirty form plus selection survives same-path query change until explicit discard", async (t) => {
  const p = await open(t, {
    events: [
      fixture.events.scheduled,
      { ...fixture.events.scheduled, id: OTHER, name: "Other event" },
    ],
  });
  await p.getByLabel("Name", { exact: true }).fill("Retained local name");
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.evaluate((OTHER) => f.navigate(`/belt-tests?event=${OTHER}`), OTHER);
  await expect(p.getByRole("dialog", { name: "Discard unsaved belt-test changes?" })).toBeVisible();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Retained local name");
  await p.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await p.evaluate(() => f.route), eventRoute);
  await p.getByRole("button", { name: "Event list", exact: true }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByRole("heading", { name: "Belt-test events", exact: true })).toBeVisible();
});

test("late create recovery preserves edits, adopts event URL and requires reload before CAS", async (t) => {
  const p = await draft(t);
  await confirmChange(p, "Schedule event");
  await p.getByLabel("Name", { exact: true }).fill("Edited while waiting");
  await commit(p, { lose: true });
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Edited while waiting");
  await expect(
    p.getByText(
      "Current details need review. Reload and discard local changes before saving again.",
    ),
  ).toBeVisible();
  assert.equal(await p.evaluate(() => f.route), eventRoute);
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("New sample test");
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("replacement form is untouched by old create completion even with draft/event UUID collision", async (t) => {
  const p = await draft(t, { createdId: DRAFT });
  await confirmChange(p, "Schedule event");
  await p.getByRole("button", { name: "New belt test", exact: true }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await p.getByLabel("Name", { exact: true }).fill("Replacement");
  await commit(p, { lose: true });
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Replacement");
  assert.notEqual(await p.evaluate(() => f.route), `/belt-tests?event=${DRAFT}`);
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("an unidentified recovered create blocks another event while Check result uses its original draft", async (t) => {
  const p = await open(t, {
    journal: JSON.stringify({ version: 1, entries: [marker("belt_test.create")] }),
  });
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await flush(p);
  assert.equal(
    (await reads(p)).filter((path) => path.startsWith("/automations/operations/")).length,
    1,
  );
  assert.equal(await p.evaluate(() => f.writes.length), 0);
});

test("blocked journal permits local edits and reads while storage and result checks remain separate", async (t) => {
  const p = await open(t, { journal: "malformed" });
  await p.getByLabel("Name", { exact: true }).fill("Local only");
  await expect(p.getByRole("button", { name: "Check storage" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  await p.evaluate(
    (KEY) => sessionStorage.setItem(KEY, JSON.stringify({ version: 1, entries: [] })),
    KEY,
  );
  await p.getByRole("button", { name: "Check storage" }).click();
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeEnabled();
});

test("different supported plan repairs reparented context and preserves null All programs", async (t) => {
  const p = await open(t);
  await p.evaluate(
    ({ OTHER }) => {
      f.ladders[0].program_id = OTHER;
      f.ladders.push({ ...f.ladders[0], id: OTHER, name: "All-program plan", program_id: null });
    },
    { OTHER },
  );
  await p.evaluate(async () => {
    f.failures["/programs?include_archived=true"] = 503;
    await f.store.refreshPrograms({ includeArchived: true, force: true }).catch(() => {});
    f.failures = {};
  });
  await p.getByRole("button", { name: "Retry reference choices" }).click();
  await expect(p.getByText(/Unavailable saved context/)).toBeVisible();
  await p.getByLabel("Belt plan", { exact: true }).selectOption(OTHER);
  await expect(p.getByText("Program: All programs", { exact: true })).toBeVisible();
  await confirmChange(p);
  assert.equal((await body(p)).ladder_id, OTHER);
  await commit(p);
  assert.equal(await p.evaluate(() => f.events[0].program_id), null);
});

test("unsupported saved timezone retains exact wires and still permits cancellation", async (t) => {
  const p = await open(t, {
    events: [{ ...fixture.events.scheduled, timezone: "Future/Unsupported" }],
  });
  await p.getByLabel("Name", { exact: true }).fill("Renamed history");
  await confirmChange(p);
  assert.equal("starts_at" in (await body(p)), false);
  await commit(p);
  await confirmChange(p, "Cancel event");
  assert.equal((await body(p, 1)).status, "canceled");
  await commit(p);
  await expect(p.getByText("This event is history. Its details cannot be changed.")).toBeVisible();
});

test("real DST gap and overlap choices survive edits and clear after saved baseline replacement", async (t) => {
  const p = await draft(t);
  await fillBeltSchedule(p, {
    startDate: "2030-03-10",
    startTime: "02:10",
    endTime: "03:10",
    timezone: "America/New_York",
  });
  await expect(p.getByRole("button", { name: "Schedule event", exact: true })).toBeDisabled();
  await fillBeltSchedule(p, {
    startDate: "2030-11-03",
    startTime: "01:10",
    endTime: "01:50",
    timezone: "America/New_York",
  });
  await expect(p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" })).toHaveCount(2);
  await p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" }).first().check();
  await p.getByRole("radio", { name: "Later occurrence · UTC-05:00" }).last().check();
  await confirmChange(p, "Schedule event");
  assert.equal((await body(p)).starts_at, "2030-11-03T05:10:00Z");
  await commit(p);
  await expect(p.getByRole("radio")).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeEnabled();
});

test("failed event Next retains its displayed page and retries exactly the failed cursor", async (t) => {
  const p = await mount(t);
  await p.evaluate(() => {
    f.eventPages = {
      "/belt-tests?limit=50": { items: f.events, next_cursor: "opaque +/", has_more: true },
    };
  });
  await p.getByRole("button", { name: "Open Sample belt test" }).click();
  await p.getByRole("button", { name: "Event list", exact: true }).click();
  // List observations do not refresh as a side effect of local navigation.
  await p.evaluate(() => f.showProvider(false));
  await flush(p);
  await p.evaluate(() => f.showProvider(true));
  await expect(p.getByRole("button", { name: "Next event page" })).toBeEnabled();
  await p.evaluate(() => {
    f.failures["/belt-tests?limit=50&cursor=opaque%20%2B%2F"] = 503;
  });
  await p.getByRole("button", { name: "Next event page" }).click();
  await expect(p.getByRole("button", { name: "Retry events" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Back to first event page" })).toBeDisabled();
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
  await p.getByRole("button", { name: "Retry events" }).click();
  await flush(p);
  assert.equal(
    (await reads(p)).filter((path) => path.endsWith("cursor=opaque%20%2B%2F")).length,
    2,
  );
});

test("ordinary recipient page failure after approval retains history and never replays mutation", async (t) => {
  const p = await open(t);
  await p.getByRole("button", { name: "Reapprove", exact: true }).click();
  await p.getByRole("button", { name: "Confirm approval" }).click();
  await p.evaluate((EVENT) => {
    f.failures[`/belt-tests/${EVENT}/recipients?limit=50`] = 503;
  }, EVENT);
  await commit(p);
  await expect(p.getByRole("button", { name: "Retry recipient history" })).toBeVisible();
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  await p.getByRole("button", { name: "Retry recipient history" }).click();
  assert.equal(await p.evaluate(() => f.writes.length), 1);
  assert.equal((await reads(p)).filter((path) => /recipients\/[a-f0-9-]+$/.test(path)).length, 0);
});

for (const missing of ["missingParent", "missingChild"])
  test(`confirmed revoke ${missing} preserves the correct parent and recovery observation`, async (t) => {
    const p = await open(t);
    await p.getByRole("button", { name: "Revoke approval" }).click();
    await p.getByRole("button", { name: "Confirm revoke" }).click();
    await commit(p, { [missing]: true, lose: true });
    await p.getByRole("button", { name: "Check result", exact: true }).click();
    if (missing === "missingParent") {
      await expect(p.getByText("This event is unavailable.", { exact: true })).toBeVisible();
      await expect(p.getByRole("region", { name: "Belt-test change results" })).toContainText(
        "no longer available",
      );
    } else {
      await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Sample belt test");
      await expect(p.getByText(/Recorded approval ·/)).toHaveCount(0);
    }
    assert.equal(await p.evaluate(() => f.writes.length), 1);
  });

test("200 null recipient after acknowledged revoke keeps uncertainty and visible prior history", async (t) => {
  const p = await open(t);
  await p.getByRole("button", { name: "Revoke approval" }).click();
  await p.getByRole("button", { name: "Confirm revoke" }).click();
  await p.evaluate(() => {
    f.nullRecipient = true;
  });
  await commit(p);
  await expect(p.getByRole("button", { name: "Check result", exact: true })).toBeVisible();
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("selection refresh requires explicit clearing and rejected approval preserves selected pairs", async (t) => {
  const p = await open(t);
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.getByRole("button", { name: "Refresh candidates", exact: true }).click();
  await p.getByRole("button", { name: "Keep reviewing" }).click();
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeChecked();
  await p.getByRole("button", { name: "Approve selected (1/100)" }).click();
  await p.getByRole("button", { name: "Confirm approval" }).click();
  await p.evaluate(() => f.refuse(0));
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeChecked();
  await p.getByRole("button", { name: "Refresh candidates", exact: true }).click();
  await p.getByRole("button", { name: "Clear and refresh" }).click();
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).not.toBeChecked();
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("StrictMode mounts remain current for command dispatch and completion", async (t) => {
  const p = await open(t, { strict: true });
  await p.getByLabel("Name", { exact: true }).fill("Strict renamed");
  await confirmChange(p);
  await commit(p);
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Strict renamed");
  await expect(p.getByRole("button", { name: "Cancel event", exact: true })).toBeEnabled();
});

test("update receipt recovery retains later local edits until explicit current reload", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("Submitted name");
  await confirmChange(p);
  await p.getByLabel("Location", { exact: true }).fill("Later local room");
  await commit(p, { lose: true });
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Later local room");
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  assert.equal(await p.evaluate(() => f.writes.length), 1);
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Submitted name");
  await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Sample room");
});

test("approval receipt success retains a later selection change and performs one ordinary page read", async (t) => {
  const eligible = { ...fixture.candidates[0], student_id: OTHER, student_name: "Other eligible" };
  const p = await open(t, { candidates: [fixture.candidates[0], eligible] });
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.getByRole("checkbox", { name: "Other eligible", exact: true }).check();
  await p.getByRole("button", { name: "Approve selected (2/100)" }).click();
  await p.getByRole("button", { name: "Confirm approval" }).click();
  await p.getByRole("checkbox", { name: "Other eligible", exact: true }).uncheck();
  await commit(p, { lose: true });
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeChecked();
  await expect(p.getByRole("checkbox", { name: "Other eligible", exact: true })).not.toBeChecked();
  assert.equal(await p.evaluate(() => f.writes.length), 1);
  assert.equal((await reads(p)).filter((path) => path.includes("/recipients?")).length, 2);
});

test("explicit nullable membership pairs remain distinct and normalize UUID case", async (t) => {
  const first = { ...fixture.candidates[0], student_id: "abcdefab-cdef-4abc-8def-000000000001" };
  const second = {
    ...first,
    student_id: first.student_id.toUpperCase(),
    student_program_membership_id: null,
    program_id: null,
    student_name: "Same student, no membership",
  };
  const p = await open(t, { candidates: [first, second] });
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.getByRole("checkbox", { name: "Same student, no membership", exact: true }).check();
  await p.getByRole("button", { name: "Approve selected (2/100)" }).click();
  await expect(p.getByRole("dialog")).toContainText("No membership");
  await p.getByRole("button", { name: "Confirm approval" }).click();
  assert.deepEqual((await body(p)).recipients, [
    {
      student_id: first.student_id,
      student_program_membership_id: first.student_program_membership_id,
    },
    { student_id: first.student_id, student_program_membership_id: null },
  ]);
  await commit(p);
});

test("candidate paging retains 100 explicit selections and disables the 101st", async (t) => {
  const candidates = Array.from({ length: 101 }, (_, index) => ({
    ...fixture.candidates[0],
    student_id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
    student_program_membership_id: null,
    student_name: `Candidate ${index}`,
  }));
  const p = await open(t, { candidates });
  for (let page = 0; page < 2; page++) {
    for (const checkbox of await p.getByRole("checkbox").all()) await checkbox.check();
    await p.getByRole("button", { name: "More candidates", exact: true }).click();
  }
  await expect(p.getByRole("checkbox", { name: "Candidate 100", exact: true })).toBeDisabled();
  await expect(p.getByRole("button", { name: "Approve selected (100/100)" })).toBeEnabled();
  assert.equal((await reads(p)).filter((path) => path.endsWith("/candidates")).length, 1);
});

test("changed reference context retains selection for review but requires explicit refresh", async (t) => {
  const p = await open(t);
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.evaluate(async () => {
    f.programs[0].name = "Updated program";
    await f.store.refreshPrograms({ includeArchived: true, force: true });
  });
  await expect(p.getByRole("button", { name: "Approve selected (1/100)" })).toBeDisabled();
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).toBeChecked();
  assert.equal((await reads(p)).filter((path) => path.endsWith("/candidates")).length, 1);
  await p.getByRole("button", { name: "Refresh candidates", exact: true }).click();
  await p.getByRole("button", { name: "Clear and refresh" }).click();
  await expect(p.getByRole("checkbox", { name: "Sample Student", exact: true })).not.toBeChecked();
});

test("failed recipient Next retains current rows and retries the opaque requested cursor", async (t) => {
  const p = await open(t);
  await p.evaluate((EVENT) => {
    f.recipientPages = {
      [`/belt-tests/${EVENT}/recipients?limit=50`]: {
        items: f.recipients,
        next_cursor: "next/+ ",
        has_more: true,
      },
    };
  }, EVENT);
  await p.getByRole("button", { name: "Refresh recipient history", exact: true }).click();
  await p.evaluate((EVENT) => {
    f.failures[`/belt-tests/${EVENT}/recipients?limit=50&cursor=next%2F%2B%20`] = 503;
  }, EVENT);
  await p.getByRole("button", { name: "Next recipient page" }).click();
  await expect(p.getByRole("button", { name: "Retry recipient history" })).toBeVisible();
  await expect(p.getByText(/Recorded approval ·/)).toBeVisible();
  await expect(p.getByRole("button", { name: "Back to first recipient page" })).toBeDisabled();
  await p.getByRole("button", { name: "Retry recipient history" }).click();
  await flush(p);
  assert.equal((await reads(p)).filter((path) => path.endsWith("cursor=next%2F%2B%20")).length, 2);
});

test("history names and saved ranks stay explicitly unavailable without current label data", async (t) => {
  const p = await open(t, {
    candidates: [],
    recipients: [
      {
        ...fixture.recipients.approved,
        approved_target_rank_id: OTHER,
        approved_schedule_revision: 1,
      },
    ],
  });
  await expect(p.getByText("Student name unavailable", { exact: true })).toBeVisible();
  await expect(p.getByText("Unranked to Saved rank unavailable", { exact: true })).toBeVisible();
  await expect(p.getByText("Recorded for a different schedule.", { exact: true })).toBeVisible();
  await expect(p.getByRole("link", { name: "Open student record" })).toHaveAttribute(
    "href",
    `/students/${fixture.ids.student}`,
  );
  assert.equal(
    await p.evaluate(() => f.reads.some((row) => row.path.startsWith("/students"))),
    false,
  );
});

test("old held detail cannot replace another event selected from a query", async (t) => {
  const p = await mount(t, {
    route: eventRoute,
    events: [
      fixture.events.scheduled,
      { ...fixture.events.scheduled, id: OTHER, name: "Other event" },
    ],
    holds: [EVENT],
  });
  await p.evaluate((OTHER) => {
    f.holds = [];
    f.navigate(`/belt-tests?event=${OTHER}`);
  }, OTHER);
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Other event");
  await p.evaluate(() => f.finishReads());
  await flush(p);
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Other event");
});

test("role invalidation drops old form state even when the same admin identity returns", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("Old privileged input");
  await p.evaluate(() => {
    f.auth.role = "instructor";
    f.emit("USER_UPDATED", f.session);
  });
  await expect(p.getByText("Belt tests require current administrator access.")).toBeVisible();
  await p.evaluate(() => {
    f.auth.role = "admin";
    f.emit("USER_UPDATED", f.session);
  });
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Sample belt test");
});

test("past scheduled event has history without candidate reads and can be completed explicitly", async (t) => {
  const p = await open(t, {
    events: [
      {
        ...fixture.events.scheduled,
        starts_at: "2020-01-01T12:00:00Z",
        ends_at: "2020-01-01T13:00:00Z",
      },
    ],
  });
  assert.equal(
    (await reads(p)).some((path) => path.endsWith("/candidates")),
    false,
  );
  await confirmChange(p, "Complete event");
  await commit(p);
  await expect(p.getByText("This event is history. Its details cannot be changed.")).toBeVisible();
});

test("text bounds count Unicode codepoints and location whitespace stays untrimmed", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("😀".repeat(140));
  await p.getByLabel("Location", { exact: true }).fill(" " + "😀".repeat(238) + " ");
  assert.equal(await p.getByLabel("Name", { exact: true }).getAttribute("maxlength"), null);
  await confirmChange(p);
  assert.equal([...(await body(p)).name].length, 140);
  assert.equal((await body(p)).location, " " + "😀".repeat(238) + " ");
  await commit(p);
});

test("held explicit reload never overwrites a later edit while the form is already dirty", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("First dirty edit");
  await p.evaluate((EVENT) => {
    f.holds = [`/belt-tests/${EVENT}`];
  }, EVENT);
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await p.waitForFunction(() => f.held.length > 0);
  await p.getByLabel("Name", { exact: true }).fill("Later dirty edit");
  await p.evaluate(() => {
    f.holds = [];
    f.finishReads();
  });
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Later dirty edit");
  await expect(
    p.getByText("New local changes were kept. Reload again to discard them."),
  ).toBeVisible();
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Sample belt test");
});

test("same-student checkbox descriptions distinguish explicit membership contexts", async (t) => {
  const p = await open(t, {
    candidates: [
      fixture.candidates[0],
      { ...fixture.candidates[0], student_program_membership_id: null, program_id: null },
    ],
  });
  const rows = p.getByRole("checkbox", { name: "Sample Student", exact: true });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAccessibleDescription("Sample program · Program membership");
  await expect(rows.nth(1)).toHaveAccessibleDescription("No program · No membership");
  await rows.nth(0).check();
  await rows.nth(1).check();
  await expect(p.getByRole("button", { name: "Approve selected (2/100)" })).toBeEnabled();
});

test("event and draft with the same UUID remain separate during old create recovery", async (t) => {
  const p = await draft(t, {
    events: [{ ...fixture.events.scheduled, id: DRAFT, name: "Existing distinct event" }],
  });
  await confirmChange(p, "Schedule event");
  await commit(p, { lose: true });
  await p.evaluate((DRAFT) => f.navigate(`/belt-tests?event=${DRAFT}`), DRAFT);
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Existing distinct event");
  await p.getByLabel("Location", { exact: true }).fill("Separate event edit");
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue("Existing distinct event");
  await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Separate event edit");
  assert.equal(await p.evaluate(() => f.route), `/belt-tests?event=${DRAFT}`);
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

test("held reload keeps a later selection change even when selection was already dirty", async (t) => {
  const p = await open(t, {
    candidates: [
      fixture.candidates[0],
      { ...fixture.candidates[0], student_id: OTHER, student_name: "Other eligible" },
    ],
  });
  await p.getByRole("checkbox", { name: "Sample Student", exact: true }).check();
  await p.evaluate((EVENT) => {
    f.holds = [`/belt-tests/${EVENT}`];
  }, EVENT);
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await p.waitForFunction(() => f.held.length > 0);
  await p.getByRole("checkbox", { name: "Other eligible", exact: true }).check();
  await p.evaluate(() => {
    f.holds = [];
    f.finishReads();
  });
  await expect(p.getByRole("checkbox", { name: "Other eligible", exact: true })).toBeChecked();
  await expect(
    p.getByText("New local changes were kept. Reload again to discard them."),
  ).toBeVisible();
});

test("late cancellation keeps fields edited while the status command was pending", async (t) => {
  const p = await open(t);
  await confirmChange(p, "Cancel event");
  await p.getByLabel("Name", { exact: true }).fill("Edited after cancellation was sent");
  await commit(p);
  await expect(p.getByLabel("Name", { exact: true })).toHaveValue(
    "Edited after cancellation was sent",
  );
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  await p.getByRole("button", { name: "Reload current event" }).click();
  await p.getByRole("button", { name: "Discard changes" }).click();
  await expect(p.getByText("This event is history. Its details cannot be changed.")).toBeVisible();
});

test("missing parent after recovery preserves later unsaved event fields without enabling mutations", async (t) => {
  const p = await open(t);
  await p.getByLabel("Name", { exact: true }).fill("Submitted edit");
  await confirmChange(p);
  await p.getByLabel("Location", { exact: true }).fill("Local copy after submission");
  await commit(p, { lose: true, missingParent: true });
  await p.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(p.getByText("This event is unavailable.", { exact: true })).toBeVisible();
  await expect(p.getByLabel("Location", { exact: true })).toHaveValue(
    "Local copy after submission",
  );
  await expect(p.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();
  await expect(p.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  assert.equal(await p.evaluate(() => f.writes.length), 1);
});

async function beginHeldRevoke(p) {
  const trigger = p.getByRole("button", { name: "Revoke approval", exact: true });
  await trigger.waitFor();
  const opener = await trigger.elementHandle(),
    before = await reads(p);
  await opener.evaluate((node) => {
    node.dataset.nativeClicks = "0";
    node.addEventListener("click", () => {
      node.dataset.nativeClicks = String(Number(node.dataset.nativeClicks) + 1);
    });
  });
  await p.evaluate((EVENT) => {
    f.holds = [`/belt-tests/${EVENT}`];
  }, EVENT);
  await trigger.focus();
  await p.keyboard.press("Enter");
  await p.waitForFunction(
    (EVENT) => f.held.some((row) => row.path === `/belt-tests/${EVENT}`),
    EVENT,
  );
  await expect(
    p.getByRole("button", { name: "Checking approval...", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  assert.equal(
    await opener.evaluate(
      (node) => node.isConnected && !node.disabled && document.activeElement === node,
    ),
    true,
  );
  await duplicateRevokeActivation(p, opener);
  assert.equal(await opener.getAttribute("data-native-clicks"), "3");
  assert.equal(
    (await reads(p)).filter((path) => path === `/belt-tests/${EVENT}`).length,
    before.filter((path) => path === `/belt-tests/${EVENT}`).length + 1,
  );
  return opener;
}
async function duplicateRevokeActivation(p, opener) {
  await p.keyboard.press("Enter");
  const box = await opener.boundingBox();
  assert.ok(box);
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await flush(p);
}

for (const dismiss of ["Escape", "Keep reviewing", "backdrop"])
  test(`async revoke ${dismiss} restores the identical connected opener and ignores pending duplicate activation`, async (t) => {
    const p = await open(t),
      opener = await beginHeldRevoke(p);
    await p.evaluate(() => f.finishReads());
    await p.waitForFunction(
      (id) => f.held.some((row) => row.path.endsWith(`/recipients/${id}`)),
      fixture.ids.recipient,
    );
    await duplicateRevokeActivation(p, opener);
    assert.equal(await opener.getAttribute("data-native-clicks"), "5");
    assert.equal(
      (await reads(p)).filter(
        (path) => path === `/belt-tests/${EVENT}/recipients/${fixture.ids.recipient}`,
      ).length,
      1,
    );
    await p.evaluate(() => {
      f.holds = [];
      f.finishReads();
    });
    await expect(p.getByRole("dialog", { name: "Confirm recipient revocation" })).toBeVisible();
    await expect(p.getByRole("button", { name: "Keep reviewing", exact: true })).toBeFocused();
    if (dismiss === "Escape") await p.keyboard.press("Escape");
    else if (dismiss === "backdrop")
      await p.locator(".koaryu-modal-backdrop").evaluate((node) => node.click());
    else await p.getByRole("button", { name: "Keep reviewing", exact: true }).click();
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await flush(p);
    assert.equal(
      await opener.evaluate(
        (node) => node.isConnected && !node.disabled && document.activeElement === node,
      ),
      true,
    );
    await expect(p.getByRole("button", { name: "Revoke approval", exact: true })).toBeFocused();
    assert.equal(await p.evaluate(() => f.writes.length), 0);
  });

for (const invalidation of ["role", "resource"])
  test(`pending revoke ${invalidation} invalidation never reopens a stale dialog or moves focus to its old opener`, async (t) => {
    const p = await open(t),
      opener = await beginHeldRevoke(p);
    await p.evaluate(async (invalidation) => {
      f.holds = [];
      if (invalidation === "role") {
        f.auth.role = "instructor";
        f.emit("USER_UPDATED", f.session);
      } else await f.resetBeltResource();
    }, invalidation);
    if (invalidation === "role")
      await expect(p.getByText("Belt tests require current administrator access.")).toBeVisible();
    else {
      await expect(p.getByRole("button", { name: "Revoke approval", exact: true })).toBeVisible();
      await p.getByRole("button", { name: "New belt test", exact: true }).focus();
    }
    assert.equal(await opener.evaluate((node) => node.isConnected), false);
    const focused = await p.evaluateHandle(() => document.activeElement);
    await p.evaluate(() => f.finishReads());
    await flush(p);
    await expect(p.getByRole("dialog")).toHaveCount(0);
    assert.equal(await focused.evaluate((node) => document.activeElement === node), true);
    assert.equal(
      (await reads(p)).filter(
        (path) => path === `/belt-tests/${EVENT}/recipients/${fixture.ids.recipient}`,
      ).length,
      0,
    );
    assert.equal(await p.evaluate(() => f.writes.length), 0);
  });

test("event rows remain on revisit while their current page revalidates", async (t) => {
  const p = await mount(t);
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
  await p.evaluate(() => f.showPage(false));
  await p.getByRole("button", { name: "Open Sample belt test" }).waitFor({ state: "detached" });
  await p.evaluate(() => {
    f.holds.push("/belt-tests?limit=50");
    f.showPage(true);
  });
  await p.waitForFunction(() => f.held.some((read) => read.path === "/belt-tests?limit=50"));
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
  assert.equal(await p.getByRole("status", { name: "Loading events" }).count(), 0);
});

test("a retained event seeds the editor on revisit without weakening current reads", async (t) => {
  const p = await open(t);
  await p.evaluate(() => f.showPage(false));
  await p
    .getByRole("heading", { name: "Sample belt test", exact: true })
    .waitFor({ state: "detached" });
  await p.evaluate((id) => {
    f.holds.push(`/belt-tests/${id}`);
    f.showPage(true);
  }, EVENT);
  await p.waitForFunction((id) => f.held.some((read) => read.path === `/belt-tests/${id}`), EVENT);
  await expect(p.getByRole("heading", { name: "Sample belt test", exact: true })).toBeVisible();
  assert.equal(await p.getByRole("status", { name: "Loading current event" }).count(), 0);
});

test("revisiting a later event page keeps its rows and revalidates its retained cursor", async (t) => {
  const p = await mount(t);
  await expect(p.getByRole("button", { name: "Open Sample belt test" })).toBeVisible();
  await p.evaluate((other) => {
    f.eventPages = {
      "/belt-tests?limit=50": { items: f.events, next_cursor: "opaque +/", has_more: true },
      "/belt-tests?limit=50&cursor=opaque%20%2B%2F": {
        items: [{ ...f.events[0], id: other, name: "Second page event" }],
        next_cursor: null,
        has_more: false,
      },
    };
  }, OTHER);
  await p.getByRole("button", { name: "Refresh events", exact: true }).click();
  await expect(p.getByRole("button", { name: "Next event page" })).toBeEnabled();
  await p.getByRole("button", { name: "Next event page" }).click();
  await expect(p.getByRole("button", { name: "Open Second page event" })).toBeVisible();
  await p.evaluate(() => f.showPage(false));
  await p.getByRole("button", { name: "Open Second page event" }).waitFor({ state: "detached" });
  await p.evaluate(() => {
    f.holds.push("/belt-tests?limit=50&cursor=opaque%20%2B%2F");
    f.showPage(true);
  });
  await p.waitForFunction(() =>
    f.held.some((read) => read.path === "/belt-tests?limit=50&cursor=opaque%20%2B%2F"),
  );
  await expect(p.getByRole("button", { name: "Open Second page event" })).toBeVisible();
  assert.equal(await p.getByRole("button", { name: "Open Sample belt test" }).count(), 0);
  assert.equal(await p.getByRole("status", { name: "Loading events" }).count(), 0);
});
