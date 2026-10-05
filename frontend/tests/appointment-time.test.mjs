import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAppointmentTimeDraft,
  editAppointmentTimeField,
  selectAppointmentOccurrence,
  resolveAppointmentTime,
  isAppointmentInstant,
  isAppointmentTimezone,
  isAppointmentSchedule,
  normalizeAppointmentSchedule,
} from "../src/lib/appointment-time.ts";

function draft(zone, startDate, startTime, endDate = startDate, endTime = "03:30") {
  let value = createAppointmentTimeDraft(zone);
  for (const [key, field] of Object.entries({ startDate, startTime, endDate, endTime }))
    value = editAppointmentTimeField(value, key, field);
  return value;
}
for (const [zone, date, time] of [
  ["America/Los_Angeles", "2026-03-08", "02:30"],
  ["Australia/Lord_Howe", "2026-10-04", "02:15"],
  ["Pacific/Apia", "2011-12-30", "12:00"],
]) {
  test(`${zone} rejects nonexistent ${date} ${time}`, async () => {
    const result = await resolveAppointmentTime(draft(zone, date, time, date, "23:00"));
    assert.equal(result.status, "invalid");
    assert.match(result.issues[0].message, /does not exist/);
  });
}
for (const [zone, date, time, expected] of [
  ["America/Los_Angeles", "2026-11-01", "01:30", ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]],
  ["Australia/Lord_Howe", "2026-04-05", "01:45", ["2026-04-04T14:45:00Z", "2026-04-04T15:15:00Z"]],
]) {
  test(`${zone} overlap requires exact explicit occurrence`, async () => {
    const value = draft(zone, date, time);
    const result = await resolveAppointmentTime(value);
    assert.equal(result.status, "needs_choice");
    assert.deepEqual(
      result.start.map((x) => x.instant),
      expected,
    );
    const chosen = selectAppointmentOccurrence(value, "start", expected[1]);
    assert.equal((await resolveAppointmentTime(chosen)).schedule.starts_at, expected[1]);
    assert.equal(editAppointmentTimeField(chosen, "startTime", "01:46").startChoice, null);
    assert.equal(editAppointmentTimeField(chosen, "timezone", "UTC").startChoice, null);
    assert.equal(
      (
        await resolveAppointmentTime(
          selectAppointmentOccurrence(value, "start", "2026-01-01T00:00:00Z"),
        )
      ).status,
      "invalid",
    );
    assert.ok(Object.isFrozen(result.start));
    assert.ok(Object.isFrozen(result.start[0]));
  });
}
test("Kathmandu quarter-hour offset is explicit and independent of process timezone", async () => {
  const previous = process.env.TZ;
  try {
    const results = [];
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      results.push(
        await resolveAppointmentTime(
          draft("Asia/Kathmandu", "2026-10-05", "09:00", "2026-10-05", "10:00"),
        ),
      );
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.equal(results[0].schedule.starts_at, "2026-10-05T03:15:00Z");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
for (const [date, time, zone] of [
  ["2026-02-30", "09:00", "UTC"],
  ["0000-01-01", "09:00", "UTC"],
  ["10000-01-01", "09:00", "UTC"],
  ["2026-1-01", "09:00", "UTC"],
  ["2026-01-01", "9:00", "UTC"],
  ["2026-01-01", "24:00", "UTC"],
  ["2026-01-01", "09:00", "+01:00"],
  ["2026-01-01", "09:00", "Mars/Olympus"],
]) {
  test(`invalid local field ${date}/${time}/${zone}`, async () =>
    assert.equal((await resolveAppointmentTime(draft(zone, date, time))).status, "invalid"));
}
test("UTC overflow is rejected at either year boundary", async () => {
  assert.equal(
    (
      await resolveAppointmentTime(
        draft("Asia/Kathmandu", "0001-01-01", "00:00", "0001-01-01", "01:00"),
      )
    ).status,
    "invalid",
  );
  assert.equal(
    (
      await resolveAppointmentTime(
        draft("America/Los_Angeles", "9999-12-31", "22:00", "9999-12-31", "23:00"),
      )
    ).status,
    "invalid",
  );
});
test("elapsed duration uses instants across DST and enforces 24 hours", async () => {
  assert.equal(
    (
      await resolveAppointmentTime(
        draft("America/Los_Angeles", "2026-11-01", "00:00", "2026-11-02", "00:00"),
      )
    ).status,
    "invalid",
  );
  assert.equal(
    (await resolveAppointmentTime(draft("UTC", "2026-10-05", "00:00", "2026-10-06", "00:00")))
      .status,
    "resolved",
  );
  assert.equal(
    (await resolveAppointmentTime(draft("UTC", "2026-10-05", "10:00", "2026-10-05", "09:00")))
      .status,
    "invalid",
  );
});
test("untouched fractions and locally unavailable named zones preserve original wires", async () => {
  const saved = {
    starts_at: "2026-10-05T09:00:00.123456Z",
    ends_at: "2026-10-05T09:00:00.123457Z",
    timezone: "Server/NewAlias",
  };
  const value = createAppointmentTimeDraft("UTC", saved);
  assert.equal(value.localSupport, "unavailable");
  assert.equal(value.fields.startDate, "");
  assert.deepEqual((await resolveAppointmentTime(value)).schedule, saved);
  assert.equal(
    (await resolveAppointmentTime(editAppointmentTimeField(value, "startTime", "09:00"))).status,
    "invalid",
  );
  let repaired = editAppointmentTimeField(value, "timezone", "UTC");
  for (const [key, field] of Object.entries({
    startDate: "2026-10-05",
    startTime: "09:00",
    endDate: "2026-10-05",
    endTime: "10:00",
  }))
    repaired = editAppointmentTimeField(repaired, key, field);
  assert.equal((await resolveAppointmentTime(repaired)).status, "resolved");
});
test("supported saved schedule opens at minute resolution without truncating its original", async () => {
  const saved = {
    starts_at: "2026-10-05T03:15:49.123456Z",
    ends_at: "2026-10-05T04:15:59.987654Z",
    timezone: "Asia/Kathmandu",
  };
  const value = createAppointmentTimeDraft("UTC", saved);
  assert.equal(value.fields.startTime, "09:00");
  assert.equal(value.fields.endTime, "10:00");
  assert.deepEqual((await resolveAppointmentTime(value)).schedule, saved);
});
test("saved local dates outside editor range retain history and require repair", async () => {
  const saved = {
    starts_at: "0001-01-01T00:00:00Z",
    ends_at: "0001-01-01T01:00:00Z",
    timezone: "America/Los_Angeles",
  };
  const value = createAppointmentTimeDraft("UTC", saved);
  assert.equal(value.localSupport, "unavailable");
  assert.equal(value.fields.startDate, "");
  assert.deepEqual((await resolveAppointmentTime(value)).schedule, saved);
});
test("strict wire instants reject rollover, missing offset, missing seconds and UTC overflow", () => {
  for (const value of [
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00Z",
    "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:30:00-01:00",
  ])
    assert.equal(isAppointmentInstant(value), false, value);
});
test("wire duration retains microseconds and UTC normalization", () => {
  const schedule = {
    starts_at: "2026-10-05T00:00:00.000001Z",
    ends_at: "2026-10-05T00:00:00.000002Z",
    timezone: "Server/NewAlias",
  };
  assert.equal(isAppointmentSchedule(schedule), true);
  assert.equal(
    isAppointmentSchedule({ ...schedule, ends_at: "2026-10-06T00:00:00.000001Z" }),
    true,
  );
  assert.equal(
    isAppointmentSchedule({ ...schedule, ends_at: "2026-10-06T00:00:00.000002Z" }),
    false,
  );
  assert.equal(
    normalizeAppointmentSchedule({ ...schedule, starts_at: "2026-10-05T01:00:00.000001+01:00" })
      .starts_at,
    schedule.starts_at,
  );
});
for (const zone of [
  "../UTC",
  "UTC/..",
  "posix/UTC",
  "right/UTC",
  "localtime",
  "posixrules",
  "A//B",
  "A B",
  "A".repeat(129),
])
  test(`reject server zone grammar ${zone}`, () =>
    assert.equal(isAppointmentTimezone(zone), false));
test("canonical fractional zeros normalize without changing untouched original wires", async () => {
  const saved = {
    starts_at: "2030-01-01T09:00:00.000000Z",
    ends_at: "2030-01-01T10:00:00.120000Z",
    timezone: "UTC",
  };
  assert.deepEqual(normalizeAppointmentSchedule(saved), {
    starts_at: "2030-01-01T09:00:00Z",
    ends_at: "2030-01-01T10:00:00.12Z",
    timezone: "UTC",
  });
  assert.deepEqual(
    (await resolveAppointmentTime(createAppointmentTimeDraft("UTC", saved))).schedule,
    saved,
  );
});

for (const [input, expectedZone, start, end] of [
  ["america/new_york", "America/New_York", "14:00", "15:00"],
  ["aMeRiCa/NeW_yOrK", "America/New_York", "14:00", "15:00"],
  ["utC", "UTC", "09:00", "10:00"],
  ["eTc/gMt+5", "Etc/GMT+5", "14:00", "15:00"],
  ["US/Pacific", "US/Pacific", "17:00", "18:00"],
  ["Asia/Kolkata", "Asia/Kolkata", "03:30", "04:30"],
  ["uS/pACiFiC", "US/Pacific", "17:00", "18:00"],
  ["aSIA/kolKATA", "Asia/Kolkata", "03:30", "04:30"],
]) {
  test(`resolved timezone identity for ${input} preserves both endpoint instants`, async () => {
    const result = await resolveAppointmentTime(
      draft(input, "2030-01-01", "09:00", "2030-01-01", "10:00"),
    );
    assert.deepEqual(result, {
      status: "resolved",
      schedule: {
        starts_at: `2030-01-01T${start}:00Z`,
        ends_at: `2030-01-01T${end}:00Z`,
        timezone: expectedZone,
      },
    });
  });
}
for (const timezone of ["america/new_york", "aMeRiCa/NeW_yOrK", "uS/pACiFiC"]) {
  test(`untouched saved timezone identity ${timezone} and fractional wires stay exact`, async () => {
    const saved = {
      starts_at: "2030-01-01T14:00:00.123456Z",
      ends_at: "2030-01-01T15:00:00.654321Z",
      timezone,
    };
    assert.deepEqual(await resolveAppointmentTime(createAppointmentTimeDraft("UTC", saved)), {
      status: "resolved",
      schedule: saved,
    });
  });
}
test("explicit saved schedule edit emits resolved timezone identity without rewriting its original", async () => {
  const saved = {
    starts_at: "2030-01-01T14:00:00.123456Z",
    ends_at: "2030-01-01T15:00:00.654321Z",
    timezone: "america/new_york",
  };
  const original = createAppointmentTimeDraft("UTC", saved);
  const edited = editAppointmentTimeField(original, "endTime", "11:00");
  assert.deepEqual(await resolveAppointmentTime(edited), {
    status: "resolved",
    schedule: {
      starts_at: "2030-01-01T14:00:00Z",
      ends_at: "2030-01-01T16:00:00Z",
      timezone: "America/New_York",
    },
  });
  assert.deepEqual(edited.original, saved);
  assert.deepEqual((await resolveAppointmentTime(original)).schedule, saved);
});
test("different resolved timezone identities at the endpoints cannot resolve", async () => {
  const { Temporal } = await import("@js-temporal/polyfill");
  const prototype = Temporal.PlainDateTime.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "toZonedDateTime");
  const endpoints = new Set();
  try {
    Object.defineProperty(prototype, "toZonedDateTime", {
      ...descriptor,
      value: function (...args) {
        endpoints.add(this.hour);
        const candidate = Reflect.apply(descriptor.value, this, args);
        Object.defineProperty(candidate, "timeZoneId", {
          value: this.hour === 10 ? "Etc/UTC" : "UTC",
        });
        return candidate;
      },
    });
    const result = await resolveAppointmentTime(
      draft("UTC", "2030-01-01", "09:00", "2030-01-01", "10:00"),
    );
    assert.equal(result.status, "invalid");
    assert.equal(result.issues[0].field, "timezone");
    assert.deepEqual([...endpoints], [9, 10]);
  } finally {
    Object.defineProperty(prototype, "toZonedDateTime", descriptor);
  }
});
