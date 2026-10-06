import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import {
  mountTrialPanel,
  selectLead,
  fillSchedule,
  flush,
  LEAD,
  OTHER,
  PROGRAM,
  KEY,
} from "./helpers/trial-appointment-panel-mounted.mjs";
import { marker } from "./helpers/trial-appointment-mounted.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
async function run(options, exercise) {
  const fixture = await mountTrialPanel(browser, options);
  try {
    await exercise(fixture.p);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
}
const panel = (p) => p.getByRole("region", { name: "Trial appointments", exact: true });
const result = (p) => p.getByRole("region", { name: "Trial change results", exact: true });
async function create(p, fields) {
  await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
  await fillSchedule(p, fields);
  await p.getByRole("button", { name: "Save trial", exact: true }).click();
  await p.waitForFunction(() => f.writes.length > 0);
}
const commit = (p, index = 0, options = {}) =>
  p.evaluate(({ index, options }) => f.commitTrial(index, options), { index, options });

test("admin creates with inherited omission, normalized zone, explicit current read and refreshed history", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p, { timezone: "america/new_york" });
    assert.equal(await p.getByRole("button", { name: "Close lead details" }).isDisabled(), true);
    await expect(p.locator("aside")).toHaveAttribute("aria-busy", "true");
    const body = await p.evaluate(() => JSON.parse(f.writes[0].body));
    assert.equal(body.timezone, "America/New_York");
    assert.equal(body.starts_at, "2030-01-02T17:00:00Z");
    assert.equal(Object.hasOwn(body, "program_id"), false);
    await commit(p);
    await expect(result(p)).toContainText("Trial change saved.");
    await expect(p.getByRole("form", { name: "Schedule trial", exact: true })).toHaveCount(0);
    await expect(panel(p)).toContainText("Scheduled");
    assert.equal(
      await p.evaluate(() =>
        f.trialReads
          .filter((read) => read.path.includes("trial-appointments?"))
          .every((read) => read.path.endsWith("?limit=50")),
      ),
      true,
    );
  }));

test("explicit no-program and current-program create modes remain distinct", async () => {
  for (const program of ["none", PROGRAM])
    await run({}, async (p) => {
      await selectLead(p);
      await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
      await fillSchedule(p);
      await p.getByLabel("Trial program").selectOption(program);
      await p.getByRole("button", { name: "Save trial", exact: true }).click();
      assert.equal(
        await p.evaluate(() => JSON.parse(f.writes[0].body).program_id),
        program === "none" ? null : PROGRAM,
      );
      await commit(p);
      await expect(result(p)).toContainText("Trial change saved.");
    });
});

test("exact-detail reschedule preserves untouched fractional schedule and omits it for location edits", () =>
  run({ rows: [{}] }, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Reschedule trial" }).click();
    await expect(p.getByRole("form", { name: "Edit trial" })).toBeVisible();
    await p.getByLabel("Location", { exact: true }).fill("Updated room");
    await p.getByRole("button", { name: "Save trial", exact: true }).click();
    const body = await p.evaluate(() => JSON.parse(f.writes[0].body));
    assert.equal(body.expected_revision, 1);
    assert.equal(body.location, "Updated room");
    assert.equal(Object.hasOwn(body, "starts_at"), false);
    assert.equal(Object.hasOwn(body, "timezone"), false);
    assert.equal(
      await p.evaluate(() =>
        f.trialReads.some((read) => read.path.endsWith(`/${f.trialRow().id}`)),
      ),
      true,
    );
    await commit(p);
    await expect(panel(p)).toContainText("12:00:00.123456");
  }));

test("outcomes require visible confirmation and status-only payload; terminal rows keep history and rebook", async () => {
  for (const [label, status] of [
    ["Complete trial", "completed"],
    ["Mark trial missed", "no_show"],
    ["Cancel trial", "canceled"],
  ])
    await run(
      { rows: [{ starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T13:00:00Z" }] },
      async (p) => {
        await selectLead(p);
        await panel(p).getByRole("button", { name: label, exact: true }).click();
        assert.equal(await p.evaluate(() => f.writes.length), 0);
        await p.getByRole("button", { name: "Confirm trial outcome" }).click();
        const body = await p.evaluate(() => JSON.parse(f.writes[0].body));
        assert.deepEqual(Object.keys(body).sort(), ["expected_revision", "operation_id", "status"]);
        assert.equal(body.status, status);
        await commit(p);
        await expect(panel(p).getByRole("button", { name: "Reschedule trial" })).toHaveCount(0);
        await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
        await expect(p.getByRole("form", { name: "Schedule trial", exact: true })).toBeVisible();
      },
    );
});

test("gap, overlap offsets, invalid duration and Unicode location use real time controls", () =>
  run({}, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, {
      startDate: "2030-03-10",
      startTime: "02:30",
      endTime: "04:00",
      timezone: "America/New_York",
    });
    await expect(panel(p)).toContainText("does not exist");
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    await fillSchedule(p, {
      startDate: "2030-11-03",
      startTime: "01:10",
      endTime: "01:50",
      timezone: "America/New_York",
    });
    await expect(p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" })).toHaveCount(2);
    await p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" }).first().check();
    await p.getByRole("radio", { name: "Later occurrence · UTC-05:00" }).last().check();
    await expect(panel(p)).toContainText("Resolved time:");
    await p.getByLabel("Location", { exact: true }).fill("🥋".repeat(240));
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
    await p.getByLabel("Location", { exact: true }).fill("🥋".repeat(241));
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    await p.getByLabel("Start time", { exact: true }).fill("01:20");
    await expect(
      p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" }).first(),
    ).not.toBeChecked();
    await fillSchedule(p, { startDate: "2030-01-01", endDate: "2030-01-03" });
    await expect(panel(p)).toContainText("at most 24 hours");
  }));

test("unsupported saved timezone and removed program preserve context, allow cancellation and explicit repair", () =>
  run(
    { rows: [{ timezone: "Server/NewAlias", program_id: "50000000-0000-4000-8000-000000000099" }] },
    async (p) => {
      await selectLead(p);
      await expect(panel(p)).toContainText("Local conversion is unavailable");
      await panel(p).getByRole("button", { name: "Change trial program" }).click();
      await expect(p.getByLabel("Trial program")).toHaveValue(
        "50000000-0000-4000-8000-000000000099",
      );
      await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
      await p.getByLabel("Trial program").selectOption("none");
      await p.getByRole("button", { name: "Save trial", exact: true }).click();
      const body = await p.evaluate(() => JSON.parse(f.writes[0].body));
      assert.equal(body.program_id, null);
      assert.equal(Object.hasOwn(body, "starts_at"), false);
      await p.evaluate(() => f.writes[0].reject(new f.ApiError("Private conflict", 409)));
      await p.getByRole("button", { name: "Cancel form" }).click();
      await panel(p).getByRole("button", { name: "Cancel trial", exact: true }).click();
      await p.getByRole("button", { name: "Confirm trial outcome" }).click();
      assert.equal(await p.evaluate(() => JSON.parse(f.writes[1].body).status), "canceled");
      await commit(p, 1);
      await expect(panel(p)).toContainText("Canceled");
    },
  ));

test("program usage refresh failure cannot turn cached choices into ready references on editor re-entry", () =>
  run({}, async (p) => {
    await selectLead(p);
    await p.evaluate(async () => {
      f.programError = true;
      await f.store.refreshPrograms({ includeArchived: true, force: true }).catch(() => {});
    });
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p);
    await expect(panel(p)).toContainText("Program choices are unavailable");
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    await p.getByRole("button", { name: "Cancel form" }).click();
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p);
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    await p.evaluate(() => {
      f.programError = false;
    });
    await p.getByRole("button", { name: "Retry program choices" }).click();
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
  }));

test("conflict preserves dirty inputs until explicit current reload", () =>
  run({ rows: [{}] }, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Reschedule trial" }).click();
    await p.getByLabel("Location", { exact: true }).fill("Unsaved room");
    await p.getByRole("button", { name: "Save trial", exact: true }).click();
    await p.evaluate(() => {
      f.appointments[0].location = "Server room";
      f.appointments[0].revision = 2;
      f.writes[0].reject(new f.ApiError("private provider detail", 409));
    });
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Unsaved room");
    await expect(
      p.getByRole("button", { name: "Discard edits and reload current appointment" }),
    ).toBeVisible();
    assert.equal((await p.textContent("body")).includes("private provider detail"), false);
    await p.getByRole("button", { name: "Discard edits and reload current appointment" }).click();
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Server room");
    assert.equal(await p.evaluate(() => f.writes.length), 1);
  }));

test("waiting owned result permits close/reopen while checking remains busy, then preserves replacement draft", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p);
    await commit(p, 0, { lose: true });
    await expect(
      result(p).getByRole("button", { name: "Check result", exact: true }),
    ).toBeVisible();
    await expect(p.getByRole("button", { name: "Close lead details" })).toBeEnabled();
    await expect(p.getByLabel("Stage", { exact: true })).toBeDisabled();
    await p.getByRole("button", { name: "Close lead details" }).click();
    await selectLead(p);
    await p.evaluate(() => {
      f.holdDetails = true;
    });
    await result(p).getByRole("button", { name: "Check result", exact: true }).click();
    await expect(p.getByRole("button", { name: "Close lead details" })).toBeDisabled();
    await p.evaluate(() => {
      f.holdDetails = false;
      f.finishReads();
    });
    await expect(result(p)).toContainText("Trial change saved.");
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, { location: "Replacement room" });
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Replacement room");
  }));

test("late save cannot close an edited or replacement trial form", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p);
    await p.getByLabel("Location", { exact: true }).fill("Edited while saving");
    await commit(p);
    await expect(result(p)).toContainText("Trial change saved.");
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Edited while saving");
  }));

test("disappeared parent retains reachable result checking and exact current absence text", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p);
    await commit(p, 0, { lose: true });
    await p.evaluate(async () => {
      f.rows = [];
      f.appointments = [];
      await f.store.refreshLeads();
    });
    await expect(p.locator("aside")).toHaveCount(0);
    await expect(result(p)).toContainText("Trial change awaiting confirmation");
    await result(p).getByRole("button", { name: "Check result", exact: true }).click();
    await expect(result(p)).toContainText(
      "The trial change was saved, but the appointment is no longer available.",
    );
    assert.equal(await p.evaluate(() => f.writes.length), 1);
  }));

test("successful null detail remains locked and never displays current absence", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p);
    await p.evaluate(() => {
      f.nullDetail = true;
    });
    await commit(p);
    await expect(
      result(p).getByRole("button", { name: "Check result", exact: true }),
    ).toBeVisible();
    assert.equal((await result(p).textContent()).includes("no longer available"), false);
    await expect(
      panel(p).getByRole("button", { name: "Schedule trial", exact: true }),
    ).toBeDisabled();
  }));

test("storage recheck remains separate from command recovery and reload adopts metadata only", async () => {
  await run({ journal: "malformed" }, async (p) => {
    await selectLead(p);
    await expect(
      result(p).getByRole("button", { name: "Check browser recovery record" }),
    ).toBeVisible();
    await p.evaluate((key) => sessionStorage.removeItem(key), KEY);
    await result(p).getByRole("button", { name: "Check browser recovery record" }).click();
    await expect(
      panel(p).getByRole("button", { name: "Schedule trial", exact: true }),
    ).toBeEnabled();
    assert.equal(
      await p.evaluate(() =>
        f.trialReads.some((read) => read.path.startsWith("/automations/operations/")),
      ),
      false,
    );
  });
  await run({ journal: JSON.stringify({ version: 1, entries: [marker] }) }, async (p) => {
    await expect(
      result(p).getByRole("button", { name: "Check result", exact: true }),
    ).toBeVisible();
    assert.equal(await p.evaluate(() => f.trialReads.length), 0);
    await result(p).getByRole("button", { name: "Check result", exact: true }).click();
    await expect(result(p)).toContainText("may have been saved");
    assert.equal(await p.evaluate(() => f.writes.length), 0);
  });
});

test("paging uses opaque cursor with explicit retry and keeps rows on failure", () =>
  run({ rows: [{}] }, async (p) => {
    await p.evaluate(() => {
      f.listOverride = { items: f.appointments, next_cursor: "opaque/+ cursor", has_more: true };
    });
    await selectLead(p);
    await p.evaluate(() => {
      f.listError = true;
    });
    await panel(p).getByRole("button", { name: "Next trials" }).click();
    await expect(panel(p).getByRole("button", { name: "Retry page" })).toBeVisible();
    await expect(panel(p)).toContainText("Sample room");
    assert.equal(
      await p.evaluate(() =>
        f.trialReads.at(-1).path.endsWith("?limit=50&cursor=opaque%2F%2B%20cursor"),
      ),
      true,
    );
    await p.evaluate(() => {
      f.listError = false;
      f.listOverride = null;
    });
    await panel(p).getByRole("button", { name: "Back to first page" }).click();
    await expect(panel(p).getByRole("button", { name: "Back to first page" })).toHaveCount(0);
  }));

test("selection and route replacement fence held list/detail without overwriting another draft", () =>
  run({ rows: [{}] }, async (p) => {
    await selectLead(p);
    await p.evaluate(() => {
      f.holdDetails = true;
    });
    await panel(p).getByRole("button", { name: "Reschedule trial" }).click();
    await selectLead(p, OTHER);
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, { location: "Other lead draft" });
    await p.evaluate(() => {
      f.holdDetails = false;
      f.finishReads();
    });
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Other lead draft");
    await p.evaluate(() => f.showPage(false));
    await flush(p);
    await p.evaluate(() => f.showPage(true));
    await flush(p);
    await expect(p.locator("aside")).toHaveCount(0);
  }));

test("ordinary lead reservation never becomes trial recovery ownership", () =>
  run({}, async (p) => {
    await selectLead(p);
    await p.evaluate((id) => {
      f.ordinary = f.store.leadOperations.reserve(id, {
        kind: "mark_contacted",
        expected_stage: "inquiry",
      });
    }, LEAD);
    await flush(p);
    await expect(p.getByRole("button", { name: "Close lead details" })).toBeDisabled();
    await p.evaluate(
      ({ marker, key }) => {
        sessionStorage.setItem(key, JSON.stringify({ version: 1, entries: [marker] }));
        return f.store.trialAppointments.checkTrialAppointmentStorage();
      },
      { marker, key: KEY },
    );
    assert.equal(
      await p.evaluate(
        (id) => f.store.trialAppointments.trialOperations.get(id).ownsLeadReservation,
        LEAD,
      ),
      false,
    );
    await expect(result(p)).toContainText("Finish the other lead change");
    await expect(result(p).getByRole("button", { name: "Check result", exact: true })).toHaveCount(
      0,
    );
    await expect(p.getByRole("button", { name: "Close lead details" })).toBeDisabled();
    await expect(
      panel(p).getByRole("button", { name: "Schedule trial", exact: true }),
    ).toBeDisabled();
    await p.evaluate(() => f.store.leadOperations.release(f.ordinary));
    await flush(p);
    await expect(p.getByRole("button", { name: "Close lead details" })).toBeEnabled();
  }));

test("resource reset fences held reads and program loading without retaining old drafts", () =>
  run({ rows: [{}] }, async (p) => {
    await selectLead(p);
    await p.evaluate(async () => {
      f.programError = true;
      await f.store.refreshPrograms({ includeArchived: true, force: true }).catch(() => {});
    });
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, { location: "Old draft" });
    await p.evaluate(() => {
      f.programError = false;
      f.holdPrograms = true;
    });
    await p.getByRole("button", { name: "Retry program choices" }).click();
    await expect(panel(p)).toContainText("Loading program choices...");
    await p.evaluate(async () => {
      f.oldGuard = f.store.trialAppointments.trialStorage.isCurrent;
      const originalPost = f.api.post;
      f.api.post = async () => ({
        studio_name: "Reset sample",
        students: [],
        leads: f.rows,
        programs: f.programs,
        belt_ladders: [],
        primary_belt_ladder: null,
        eligibility: [],
        templates: [],
        sessions: [],
        attendance: [],
      });
      await f.store.resetDemoData();
      f.api.post = originalPost;
    });
    await flush(p);
    assert.equal(await p.evaluate(() => f.oldGuard()), false);
    if (!(await panel(p).count())) await selectLead(p);
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, { location: "New scope draft" });
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
    await p.evaluate(() => {
      f.holdPrograms = false;
      f.finishPrograms();
    });
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("New scope draft");
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
  }));

for (const role of ["front_desk", "instructor"])
  test(`${role} performs zero trial or journal I/O`, () =>
    run({ role }, async (p) => {
      if (role === "front_desk") await selectLead(p);
      await expect(panel(p)).toHaveCount(0);
      assert.equal(await p.evaluate(() => f.trialReads.length), 0);
      assert.equal(await p.evaluate(() => window.trialStorageReads), 0);
    }));

test("preview is visibly sample-only and uses local outcomes without trial or journal I/O", () =>
  run({ preview: true }, async (p) => {
    const id = await p.evaluate(() => f.store.leads[0].id);
    await selectLead(p, id);
    await expect(panel(p)).toContainText("Sample trial appointments");
    await panel(p).getByRole("button", { name: "Cancel trial", exact: true }).click();
    await p.getByRole("button", { name: "Confirm trial outcome" }).click();
    await expect(panel(p)).toContainText("Canceled");
    assert.equal(await p.evaluate(() => f.trialReads.length), 0);
    assert.equal(await p.evaluate(() => window.trialStorageReads), 0);
  }));

test("converter load failure retries with entered fields intact and timezone suggestions available", () =>
  run({}, async (p) => {
    await selectLead(p);
    assert.equal(await p.evaluate(() => f.temporalLoads ?? 0), 0);
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await p.evaluate(() => {
      f.failTimeConversion = true;
    });
    await fillSchedule(p, { location: "Keep this room" });
    await expect(panel(p)).toContainText("Appointment time conversion could not load.");
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    assert.equal(await p.locator('datalist option[value="America/New_York"]').count(), 1);
    await p.evaluate(() => {
      f.failTimeConversion = false;
    });
    await p.getByRole("button", { name: "Retry time conversion" }).click();
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
    await expect(p.getByLabel("Location", { exact: true })).toHaveValue("Keep this room");
  }));

test("closed, enrolled and converted leads retain trial history and cancellation only", async () => {
  for (const changes of [
    { stage: "closed_lost" },
    { stage: "enrolled" },
    { converted_student_id: "70000000-0000-4000-8000-000000000001" },
  ])
    await run({ rows: [{}] }, async (p) => {
      await selectLead(p);
      await p.evaluate(async (changes) => {
        Object.assign(f.rows[0], changes);
        await f.store.refreshLeads();
      }, changes);
      await expect(panel(p)).toContainText("Sample room");
      for (const name of [
        "Schedule trial",
        "Reschedule trial",
        "Complete trial",
        "Mark trial missed",
      ])
        await expect(panel(p).getByRole("button", { name, exact: true })).toBeDisabled();
      await panel(p).getByRole("button", { name: "Cancel trial", exact: true }).click();
      await expect(p.getByRole("button", { name: "Confirm trial outcome" })).toBeEnabled();
    });
});

test("removed and archived programs disable outcomes while preserving explicit program correction", async () => {
  for (const archived of [false, true])
    await run({ rows: [{}] }, async (p) => {
      await p.evaluate(async (archived) => {
        f.programs = archived
          ? f.programs.map((program) => ({ ...program, archived_at: "2026-10-05T00:00:00Z" }))
          : [];
        await f.store.refreshPrograms({ includeArchived: true, force: true });
      }, archived);
      await selectLead(p);
      await expect(panel(p)).toContainText("Unavailable saved program");
      await expect(
        panel(p).getByRole("button", { name: "Complete trial", exact: true }),
      ).toBeDisabled();
      await expect(
        panel(p).getByRole("button", { name: "Mark trial missed", exact: true }),
      ).toBeDisabled();
      await panel(p).getByRole("button", { name: "Change trial program" }).click();
      await expect(p.getByLabel("Trial program")).toHaveValue(PROGRAM);
      await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
      await p.getByLabel("Trial program").selectOption("none");
      await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
    });
});

test("trial result leaves replacement lead names, program and notes untouched", () =>
  run({}, async (p) => {
    await selectLead(p);
    await create(p);
    await commit(p, 0, { lose: true });
    await p.getByRole("button", { name: "Close lead details" }).click();
    await p.getByRole("button", { name: "Add lead", exact: true }).click();
    await p.locator('[name="first_name"]').fill("Replacement");
    await p.locator('[name="last_name"]').fill("Draft");
    await p.getByLabel("Program", { exact: true }).selectOption(PROGRAM);
    await p.locator('[name="notes"]').fill("Keep these notes");
    await p.evaluate((id) => f.store.trialAppointments.checkTrialAppointmentResult(id), LEAD);
    await expect(p.locator('[name="first_name"]')).toHaveValue("Replacement");
    await expect(p.locator('[name="last_name"]')).toHaveValue("Draft");
    await expect(p.getByLabel("Program", { exact: true })).toHaveValue(PROGRAM);
    await expect(p.locator('[name="notes"]')).toHaveValue("Keep these notes");
  }));

test("authority replacement discards trial rows and forms and fences old completion", () =>
  run({ rows: [{}] }, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Reschedule trial" }).click();
    await p.getByLabel("Location", { exact: true }).fill("Private prior draft");
    await p.getByRole("button", { name: "Save trial", exact: true }).click();
    await p.evaluate(() => {
      f.auth = { ...f.auth, role: "front_desk" };
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await p.waitForFunction(() => f.store.currentRole === "front_desk");
    await commit(p);
    await flush(p);
    await expect(panel(p)).toHaveCount(0);
    await expect(result(p)).toHaveCount(0);
    assert.equal((await p.textContent("body")).includes("Private prior draft"), false);
  }));

test("verified cancel and update remain visible if page refresh fails, then a later page supersedes them", async () => {
  for (const cancel of [true, false])
    await run({ rows: [{}] }, async (p) => {
      await selectLead(p);
      await panel(p)
        .getByRole("button", { name: cancel ? "Cancel trial" : "Reschedule trial", exact: true })
        .click();
      if (!cancel) await p.getByLabel("Location", { exact: true }).fill("Verified current room");
      await p
        .getByRole("button", { name: cancel ? "Confirm trial outcome" : "Save trial", exact: true })
        .click();
      await p.evaluate(() => {
        f.listError = true;
      });
      await commit(p);
      await expect(panel(p)).toContainText("Trial history could not be refreshed");
      await expect(panel(p)).toContainText(cancel ? "Canceled" : "Verified current room");
      if (cancel)
        await expect(panel(p).getByRole("button", { name: "Reschedule trial" })).toHaveCount(0);
      await p.evaluate(() => {
        f.listError = false;
        f.appointments = [];
      });
      await panel(p).getByRole("button", { name: "Retry page" }).click();
      await expect(panel(p)).toContainText("No trial appointments on this page.");
      await expect(panel(p).getByRole("article")).toHaveCount(0);
    });
});

test("verified creation and current absence need no fabricated list page when history never loaded", async () => {
  for (const missing of [false, true])
    await run({}, async (p) => {
      await p.evaluate(() => {
        f.listError = true;
      });
      await selectLead(p);
      await create(p);
      await commit(p, 0, { missing });
      await expect(result(p)).toContainText(
        missing ? "no longer available" : "Trial change saved.",
      );
      if (!missing) await expect(panel(p)).toContainText("Sample room");
      else await expect(panel(p).getByRole("article")).toHaveCount(0);
      await expect(panel(p).getByRole("button", { name: "Next trials" })).toHaveCount(0);
      await expect(panel(p).getByText("No trial appointments on this page.")).toHaveCount(0);
    });
});

const overlapFields = {
  startDate: "2030-11-03",
  startTime: "01:10",
  endTime: "01:50",
  timezone: "America/New_York",
};
const laterOverlap = {
  starts_at: "2030-11-03T06:10:00Z",
  ends_at: "2030-11-03T06:50:00Z",
  timezone: "America/New_York",
};
async function chooseOverlap(p) {
  await expect(p.getByRole("radio")).toHaveCount(4);
  await p.getByRole("radio", { name: "Earlier occurrence · UTC-04:00" }).first().check();
  await p.getByRole("radio", { name: "Later occurrence · UTC-05:00" }).last().check();
  await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeEnabled();
}
function assertLocationOnly(body, revision) {
  assert.equal(body.expected_revision, revision);
  assert.equal(body.location, "Changed room");
  for (const field of ["starts_at", "ends_at", "timezone"])
    assert.equal(Object.hasOwn(body, field), false);
}

test("new-to-saved same-wall replacement clears stale occurrences and preserves the exact saved schedule", () =>
  run({ rows: [laterOverlap] }, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await fillSchedule(p, overlapFields);
    await chooseOverlap(p);
    const controlId = await p.getByLabel("Start date", { exact: true }).getAttribute("id");
    await panel(p).getByRole("button", { name: "Reschedule trial", exact: true }).click();
    const form = p.getByRole("form", { name: "Edit trial", exact: true });
    await expect(form).toContainText("Resolved time: Nov 3, 2030, 01:10:00 GMT-05:00");
    await expect(p.getByRole("radio")).toHaveCount(0);
    assert.equal(await p.getByLabel("Start date", { exact: true }).getAttribute("id"), controlId);
    await p.getByLabel("Location", { exact: true }).fill("Changed room");
    await p.getByRole("button", { name: "Save trial", exact: true }).click();
    assertLocationOnly(await p.evaluate(() => JSON.parse(f.writes[0].body)), 1);
    await commit(p);
    assert.deepEqual(
      await p.evaluate(() => ({
        starts_at: f.appointments[0].starts_at,
        ends_at: f.appointments[0].ends_at,
        timezone: f.appointments[0].timezone,
      })),
      laterOverlap,
    );
  }));

test("saved-to-new same-wall replacement requires fresh choices and keeps current alternatives after selection", () =>
  run({ rows: [laterOverlap] }, async (p) => {
    await selectLead(p);
    await panel(p).getByRole("button", { name: "Reschedule trial", exact: true }).click();
    await expect(p.getByRole("form", { name: "Edit trial", exact: true })).toBeVisible();
    await p.getByLabel("Start time", { exact: true }).fill("01:11");
    await p.getByLabel("Start time", { exact: true }).fill("01:10");
    await chooseOverlap(p);
    const controlId = await p.getByLabel("Start date", { exact: true }).getAttribute("id");
    await panel(p).getByRole("button", { name: "Schedule trial", exact: true }).click();
    await expect(p.getByRole("radio")).toHaveCount(0);
    await fillSchedule(p, overlapFields);
    await expect(p.getByRole("radio")).toHaveCount(4);
    assert.equal(
      await p.getByRole("radio").evaluateAll((radios) => radios.some((radio) => radio.checked)),
      false,
    );
    await expect(p.getByRole("button", { name: "Save trial", exact: true })).toBeDisabled();
    await chooseOverlap(p);
    await expect(p.getByRole("radio")).toHaveCount(4);
    await p.getByRole("radio", { name: "Later occurrence · UTC-05:00" }).first().check();
    await expect(p.getByRole("radio")).toHaveCount(4);
    await expect(p.getByRole("form", { name: "Schedule trial", exact: true })).toContainText(
      "Resolved time: Nov 3, 2030, 01:10:00 GMT-05:00",
    );
    assert.equal(await p.getByLabel("Start date", { exact: true }).getAttribute("id"), controlId);
    await p.getByRole("button", { name: "Save trial", exact: true }).click();
    const write = await p.evaluate(() => ({
      method: f.writes[0].method,
      body: JSON.parse(f.writes[0].body),
    }));
    assert.equal(write.method, "post");
    for (const field of ["starts_at", "ends_at", "timezone"])
      assert.equal(write.body[field], laterOverlap[field]);
    await commit(p);
  }));

test("saved baseline replacement clears prior edited occurrences without rounding the replacement wires", () =>
  run(
    {
      rows: [
        { ...laterOverlap, starts_at: "2030-11-03T05:10:00Z", ends_at: "2030-11-03T05:50:00Z" },
      ],
    },
    async (p) => {
      await selectLead(p);
      await panel(p).getByRole("button", { name: "Reschedule trial", exact: true }).click();
      await expect(p.getByRole("form", { name: "Edit trial", exact: true })).toBeVisible();
      await p.getByLabel("Start time", { exact: true }).fill("01:11");
      await p.getByLabel("Start time", { exact: true }).fill("01:10");
      await chooseOverlap(p);
      const replacement = {
        ...laterOverlap,
        starts_at: "2030-11-03T06:10:00.123456Z",
        ends_at: "2030-11-03T06:50:00.123457Z",
      };
      await p.evaluate((replacement) => {
        Object.assign(f.appointments[0], replacement, { revision: 2 });
      }, replacement);
      await panel(p).getByRole("button", { name: "Reschedule trial", exact: true }).click();
      await expect(p.getByRole("form", { name: "Edit trial", exact: true })).toContainText(
        "01:10:00.123456 GMT-05:00",
      );
      await expect(p.getByRole("radio")).toHaveCount(0);
      await p.getByLabel("Location", { exact: true }).fill("Changed room");
      await p.getByRole("button", { name: "Save trial", exact: true }).click();
      assertLocationOnly(await p.evaluate(() => JSON.parse(f.writes[0].body)), 2);
      await commit(p);
      assert.deepEqual(
        await p.evaluate(() => ({
          starts_at: f.appointments[0].starts_at,
          ends_at: f.appointments[0].ends_at,
          timezone: f.appointments[0].timezone,
        })),
        replacement,
      );
    },
  ));
