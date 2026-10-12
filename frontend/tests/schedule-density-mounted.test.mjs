import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";
import { getConflictingSessionIds } from "../src/lib/schedule-calendar.ts";

const sectionPath = fileURLToPath(
  new URL("../src/components/schedule/schedule-page-section.tsx", import.meta.url),
);
const scheduleCss = readFileSync(
  new URL("../src/components/schedule/schedule.module.css", import.meta.url),
  "utf8",
).replace(/:global\(([^)]+)\)/g, "$1");
const headerCss = readFileSync(
  new URL("../src/components/header.module.css", import.meta.url),
  "utf8",
);

function bundle() {
  // Expose the private pure formatter in this test bundle only. The Sunday-start
  // calendar cannot itself produce the spec's Monday-start example ranges.
  const { add, modules } = createCommonJsPacker({
    [sectionPath]: readFileSync(sectionPath, "utf8") + "\nexport { formatWeekLabel };",
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./sliding-segmented-control.module.css": `module.exports={};`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const section = add(sectionPath);
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),{SchedulePageSection,formatWeekLabel}=require(${section});
    function App(){const f=window.fixture;const [props,setProps]=React.useState(f.initial);
      f.update=patch=>setProps(p=>({...p,...patch}));f.props=props;f.formatWeekLabel=formatWeekLabel;
      const noop=()=>{};
      return React.createElement(SchedulePageSection,{
        canManageSchedule:true,programFilter:'',templates:[],programs:[],hasLoadedRange:true,
        isRefreshingRange:false,scheduleLoadError:null,actionMessage:null,
        onNavigate:noop,onJumpToToday:noop,onProgramFilterChange:noop,onOpenAddClass:noop,
        onRetryRange:noop,onDismissScheduleLoadError:noop,onDismissActionMessage:noop,
        ...props,currentDate:new Date(props.currentDate),
        onViewChange:view=>f.update({view}),onSelectDate:date=>f.update({currentDate:date.toISOString()}),
        onOpenSession:session=>f.opened.push(session.id)
      });}
    require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(App));
  })();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const session = (id, date = "2026-10-11", start = "16:00", end = "16:45") => ({
  id,
  name: id,
  date,
  start_time: start,
  end_time: end,
  status: "scheduled",
  program_id: null,
  attendance_count: 3,
  capacity: 20,
});

async function mount({ width = 1280, height = 900, view = "week", sessions = [], ...props } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: "UTC" });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.clock.setFixedTime(new Date("2026-10-11T17:00:00Z"));
  await page.setContent(
    '<style>html,body{width:100%;margin:0}*{box-sizing:border-box}button{font-family:inherit}.relative{position:relative}.absolute{position:absolute}.inset-x-0{left:0;right:0}.grid{display:grid}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style><main id="root"></main>',
  );
  await page.addStyleTag({ content: headerCss });
  await page.addStyleTag({ content: scheduleCss });
  await page.evaluate(
    (initial) => {
      window.fixture = { initial, opened: [] };
    },
    {
      businessDate: "2026-10-11",
      currentDate: "2026-10-11T12:00:00Z",
      view,
      sessions,
      ...props,
    },
  );
  await page.addScriptTag({ content: source });
  await expect(page.locator("[data-schedule-range-label]")).toBeVisible();
  return { page, errors };
}

async function update(page, props) {
  await page.evaluate((patch) => fixture.update(patch), props);
}

const hourLabels = (page) => page.locator(".hourColumn .hourLabel");

test("phone Week has seven groups, attendance labels, empty days and date navigation without overflow", async () => {
  const { page, errors } = await mount({
    width: 390,
    sessions: [
      session("Kids BJJ Fundamentals"),
      session("Open Mat", "2026-10-12", "10:00", "12:00"),
    ],
  });
  try {
    const agenda = page.locator('[data-schedule-agenda="week"]');
    await expect(agenda).toBeVisible();
    await expect(agenda.locator("[data-schedule-agenda-day]")).toHaveCount(7);
    const today = agenda.locator('[data-schedule-agenda-day="2026-10-11"]');
    await expect(today).toHaveAttribute("data-today", "true");
    await expect(
      today.getByRole("button", {
        name: "Take attendance for Kids BJJ Fundamentals at 4:00 PM",
        exact: true,
      }),
    ).toHaveCount(1);
    await today
      .getByRole("button", {
        name: "Take attendance for Kids BJJ Fundamentals at 4:00 PM",
        exact: true,
      })
      .click();
    assert.deepEqual(await page.evaluate(() => fixture.opened), ["Kids BJJ Fundamentals"]);
    await expect(
      agenda.getByRole("button", { name: "Open Open Mat at 10:00 AM", exact: true }),
    ).toHaveCount(1);
    await expect(agenda.getByText("No classes", { exact: true })).toHaveCount(5);
    await expect(page.locator("[data-schedule-screen-week]:visible")).toHaveCount(0);
    await expect(page.locator("[data-schedule-today-bar]")).toHaveCount(0);
    assert.deepEqual(
      await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]),
      [390, 390],
    );
    await agenda.getByRole("button", { name: "Open Monday, October 12", exact: true }).click();
    await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("[data-schedule-range-label]")).toHaveText(
      "Monday, October 12, 2026",
    );
    await expect(
      page.getByRole("button", { name: "Open Open Mat at 10:00 AM", exact: true }),
    ).toHaveCount(1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("phone Month folds earlier class days, keeps today first and resets the fold outside the current month", async () => {
  const { page, errors } = await mount({
    width: 390,
    view: "month",
    sessions: [
      session("Past A", "2026-10-01"),
      session("Past B", "2026-10-02"),
      session("Today"),
      session("Future", "2026-10-12"),
      session("November", "2026-11-01"),
    ],
  });
  try {
    const fold = page.getByRole("button", { name: "Earlier this month (2 days)", exact: true });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-month-schedule-day="2026-10-01"]')).toBeHidden();
    const visibleDates = () =>
      page
        .locator("[data-month-schedule-day]:visible")
        .evaluateAll((days) => days.map((day) => day.dataset.monthScheduleDay));
    assert.deepEqual(await visibleDates(), ["2026-10-11", "2026-10-12"]);
    await fold.click();
    const hide = page.getByRole("button", { name: "Hide earlier days", exact: true });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-month-schedule-day="2026-10-01"]')).toBeVisible();
    await hide.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    for (const currentDate of ["2026-11-01T12:00:00Z", "2026-09-01T12:00:00Z"]) {
      await update(page, { currentDate });
      await expect(page.locator("[data-schedule-range-label]")).toHaveText(
        currentDate.includes("11-") ? "November 2026" : "September 2026",
      );
      await expect(
        page.getByRole("button", { name: /Earlier this month|Hide earlier days/ }),
      ).toHaveCount(0);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("desktop attendance bar has one accessible chip per today's session and no stats or eyebrow", async () => {
  const sessions = [
    session("Kids BJJ Fundamentals"),
    session("Adult No-Gi", "2026-10-11", "18:00", "19:30"),
    session("Tomorrow", "2026-10-12"),
  ];
  const { page, errors } = await mount({ sessions });
  try {
    const bar = page.locator("[data-schedule-today-bar]");
    await expect(bar).toBeVisible();
    await expect(bar.locator("[data-schedule-today-session]")).toHaveCount(2);
    assert.deepEqual(
      await bar
        .getByRole("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      [
        "Take attendance for Kids BJJ Fundamentals at 4:00 PM",
        "Take attendance for Adult No-Gi at 6:00 PM",
      ],
    );
    await bar
      .getByRole("button", { name: "Take attendance for Adult No-Gi at 6:00 PM", exact: true })
      .click();
    assert.deepEqual(await page.evaluate(() => fixture.opened), ["Adult No-Gi"]);
    await expect(page.getByText("Open seats", { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-koaryu-page-header] .eyebrow")).toHaveCount(0);
    await page.getByRole("button", { name: "Day", exact: true }).click();
    await expect(bar).toHaveCount(0);
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(bar).toBeVisible();
    await update(page, { sessions: [sessions[2]] });
    await expect(bar).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("canceled attendance shortcut is disabled while active classes and canceled calendar details remain accessible", async () => {
  const canceled = {
    ...session("Canceled class", "2026-10-11", "18:00", "18:45"),
    status: "canceled",
  };
  const { page, errors } = await mount({ sessions: [canceled, session("Active class")] });
  try {
    const bar = page.locator("[data-schedule-today-bar]");
    const shortcut = bar.locator('[data-schedule-today-session="Canceled class"]');
    await expect(shortcut).toBeDisabled();
    await expect(shortcut).toContainText("Canceled");
    await expect(shortcut).not.toHaveAttribute("aria-label", /Take attendance/);
    await shortcut.evaluate((button) => button.click());
    assert.deepEqual(await page.evaluate(() => fixture.opened), []);
    await bar
      .getByRole("button", { name: "Take attendance for Active class at 4:00 PM", exact: true })
      .click();
    assert.deepEqual(await page.evaluate(() => fixture.opened), ["Active class"]);
    await page
      .locator('[data-time-canvas-block="session"]')
      .filter({ has: page.locator('[data-canceled="true"]') })
      .click();
    assert.deepEqual(await page.evaluate(() => fixture.opened), ["Active class", "Canceled class"]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("canvas hour labels use outward rounding, six hours minimum, and 9-to-9 when empty", async () => {
  const { page, errors } = await mount({
    sessions: [
      session("Early", "2026-10-12", "10:15", "12:00"),
      session("Late", "2026-10-11", "18:00", "19:30"),
    ],
  });
  try {
    await expect(hourLabels(page)).toHaveText([
      "10 AM",
      "11 AM",
      "12 PM",
      "1 PM",
      "2 PM",
      "3 PM",
      "4 PM",
      "5 PM",
      "6 PM",
      "7 PM",
      "8 PM",
    ]);
    await update(page, { sessions: [] });
    await expect(hourLabels(page)).toHaveText([
      "9 AM",
      "10 AM",
      "11 AM",
      "12 PM",
      "1 PM",
      "2 PM",
      "3 PM",
      "4 PM",
      "5 PM",
      "6 PM",
      "7 PM",
      "8 PM",
      "9 PM",
    ]);
    await update(page, { view: "day", sessions: [session("Short")] });
    await expect(hourLabels(page)).toHaveText([
      "4 PM",
      "5 PM",
      "6 PM",
      "7 PM",
      "8 PM",
      "9 PM",
      "10 PM",
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("now line belongs only to today's column, updates on focus and requires an in-range studio clock", async () => {
  const { page, errors } = await mount({ studioTimezone: "UTC", sessions: [session("Today")] });
  try {
    const line = page.locator("[data-schedule-now-line]");
    await expect(line).toHaveCount(1);
    await expect(
      page.locator(
        '[data-time-canvas-day="2026-10-11"][data-today="true"] [data-schedule-now-line]',
      ),
    ).toHaveCount(1);
    assert.match(await line.getAttribute("style"), /\* 1\)/);
    for (const time of ["15:59", "22:01"]) {
      await page.clock.setFixedTime(new Date(`2026-10-11T${time}:00Z`));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(line).toHaveCount(0);
    }
    await page.clock.setFixedTime(new Date("2026-10-11T17:00:00Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(line).toHaveCount(1);
    await update(page, { studioTimezone: undefined });
    await expect(line).toHaveCount(0);
    await update(page, { studioTimezone: "UTC", view: "day" });
    await expect(
      page.locator('[data-schedule-time-canvas="day"] [data-schedule-now-line]'),
    ).toHaveCount(1);
    await update(page, { currentDate: "2026-10-12T12:00:00Z" });
    await expect(line).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("week labels omit repeated months and include both years across New Year", async () => {
  const { page, errors } = await mount();
  try {
    await expect(page.locator("[data-schedule-range-label]")).toHaveText("October 11 – 17, 2026");
    const ranges = [
      ["2026-10-11", "2026-10-17"],
      ["2026-10-26", "2026-11-01"],
      ["2026-12-28", "2027-01-03"],
    ];
    assert.deepEqual(
      await page.evaluate(
        (ranges) =>
          ranges.map(([start, end]) =>
            fixture.formatWeekLabel(new Date(`${start}T12:00:00Z`), new Date(`${end}T12:00:00Z`)),
          ),
        ranges,
      ),
      [
        "October 11 – 17, 2026",
        "October 26 – November 1, 2026",
        "December 28, 2026 – January 3, 2027",
      ],
    );
    await update(page, { currentDate: "2026-12-28T12:00:00Z" });
    await expect(page.locator("[data-schedule-range-label]")).toHaveText(
      "December 27, 2026 – January 2, 2027",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("desktop Month shows four entries and more, retains hidden row cells and has no overlap count badge", async () => {
  const { page, errors } = await mount({
    view: "month",
    sessions: Array.from({ length: 6 }, (_, index) => session(`Class ${index + 1}`)),
  });
  try {
    const cells = page.locator("[data-month-schedule-day]");
    await expect(cells).toHaveCount(42);
    const today = page.locator('[data-month-schedule-day="2026-10-11"]');
    await expect(today.locator("button.chip:visible")).toHaveCount(4);
    await expect(today.locator('[data-month-entry-overflow="true"]')).toHaveCount(2);
    await expect(today.locator('[data-month-entry-overflow="true"]:visible')).toHaveCount(0);
    await expect(today.getByRole("button", { name: "+2 more", exact: true })).toBeVisible();
    const hiddenRow = page.locator('[data-month-row-scope="out-of-month"]');
    await expect(hiddenRow).toHaveCount(7);
    await expect(page.locator('[data-month-row-scope="out-of-month"]:visible')).toHaveCount(0);
    await expect(today.getByText(/^\d+ overlaps$/i)).toHaveCount(0);
    await expect(today.getByText("Overlaps", { exact: true })).toHaveCount(6);
    await today.getByRole("button", { name: "+2 more", exact: true }).click();
    await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("[data-schedule-range-label]")).toHaveText(
      "Sunday, October 11, 2026",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

const geometryViewports = [
  { width: 1440, height: 900 },
  { width: 1000, height: 614 },
  { width: 390, height: 844 },
];

const shortCanvasCases = [
  { width: 1440, height: 900, view: "week" },
  { width: 1440, height: 900, view: "day" },
  { width: 1000, height: 614, view: "week" },
  { width: 1000, height: 614, view: "day" },
  { width: 390, height: 844, view: "day" },
];

async function canvasGeometry(page) {
  return page.locator('[data-time-canvas-day="2026-10-11"]:visible').evaluate((canvas) => {
    const origin = canvas.getBoundingClientRect();
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x: x - origin.x, y: y - origin.y, width, height };
    };
    return [...canvas.querySelectorAll("[data-time-canvas-visible]")].map((card) => ({
      id: card.dataset.timeCanvasVisible,
      visible: rect(card),
      target: card.parentElement.matches("button") ? rect(card.parentElement) : null,
    }));
  });
}

function assertSeparateRectangles(geometry, kind) {
  for (let i = 0; i < geometry.length; i += 1) {
    for (let j = i + 1; j < geometry.length; j += 1) {
      const a = geometry[i][kind] ?? geometry[i].visible;
      const b = geometry[j][kind] ?? geometry[j].visible;
      const intersects =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.1 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.1;
      assert.equal(intersects, false, `${kind}: ${geometry[i].id} covers ${geometry[j].id}`);
    }
  }
}

async function clickCanvasTargets(page, sessions) {
  const opened = [];
  for (const item of sessions) {
    const target = page.locator('[data-time-canvas-block="session"]').filter({
      has: page.locator(`[data-time-canvas-visible="session:${item.id}"]`),
    });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `${item.id} keeps its touch target`);
    // Click the bottom padding, outside the drawn short card, to check the
    // enlarged interaction target belongs to the requested session.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 1);
    opened.push(await page.evaluate(() => fixture.opened.at(-1)));
  }
  return opened;
}

for (const viewport of shortCanvasCases) {
  test(`short canvas classes stay separate in ${viewport.view} at ${viewport.width}x${viewport.height}`, async () => {
    const sessions = [
      session("Start A", undefined, "00:00", "00:15"),
      session("Start B", undefined, "00:15", "00:30"),
      session("Start C", undefined, "00:30", "01:00"),
      session("Start D", undefined, "01:00", "01:30"),
      session("Long A", undefined, "09:00", "10:00"),
      session("Long B", undefined, "10:00", "11:00"),
      session("Late A", undefined, "23:15", "23:30"),
      session("Late B", undefined, "23:30", "23:45"),
      session("Late C", undefined, "23:45", "24:00"),
    ];
    const { page, errors } = await mount({ ...viewport, sessions });
    try {
      const geometry = await canvasGeometry(page);
      const clicked = await clickCanvasTargets(page, sessions);
      console.log(
        `short geometry ${viewport.view} ${viewport.width}x${viewport.height}: ${JSON.stringify({ geometry, clicked })}`,
      );
      assertSeparateRectangles(geometry, "visible");
      assertSeparateRectangles(geometry, "target");
      assert.deepEqual(
        clicked,
        sessions.map((item) => item.id),
      );
      const canvas = page.locator('[data-time-canvas-day="2026-10-11"]:visible');
      await expect(canvas.locator('[data-overlap="true"],[data-conflict="true"]')).toHaveCount(0);
      await expect(canvas.getByText("Overlaps", { exact: true })).toHaveCount(0);
      const hourHeight = viewport.width === 390 ? 56 : 48;
      for (const item of sessions) {
        const card = geometry.find((entry) => entry.id === `session:${item.id}`);
        const [hour, minute] = item.start_time.split(":").map(Number);
        assert.ok(Math.abs(card.visible.y - (hour + minute / 60) * hourHeight) < 0.02);
        await expect(
          canvas.locator(`[data-time-canvas-visible="session:${item.id}"]`),
        ).toContainText(item.name);
        await expect(
          canvas
            .locator('[data-time-canvas-block="session"]')
            .filter({ has: page.locator(`[data-time-canvas-visible="session:${item.id}"]`) }),
        ).toHaveAttribute("title", new RegExp(item.name));
      }
      const longA = geometry.find((entry) => entry.id === "session:Long A");
      const longB = geometry.find((entry) => entry.id === "session:Long B");
      assert.equal(longA.visible.x, longB.visible.x);
      assert.equal(longA.visible.width, longB.visible.width);
      assert.ok(longA.visible.width > geometry[0].visible.width);
      await page.getByRole("button", { name: "Week", exact: true }).click();
      await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByRole("button", { name: "Next week", exact: true })).toBeEnabled();
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test(`short canvas reserves templates and canceled classes in ${viewport.view} at ${viewport.width}x${viewport.height}`, async () => {
    const sessions = [
      session("Overlap A", undefined, "08:00", "08:15"),
      session("Overlap B", undefined, "08:05", "08:20"),
      { ...session("Canceled", undefined, "08:10", "08:25"), status: "canceled" },
      session("Adjacent", undefined, "08:25", "08:40"),
      session("After template", undefined, "09:30", "09:45"),
      ...Array.from({ length: 6 }, (_, index) =>
        session(`Busy ${index}`, undefined, "12:00", "12:15"),
      ),
    ];
    const templates = ["09:00", "09:15"].map((start, index) => ({
      id: `short-template-${index}`,
      name: `Recurring ${index}`,
      day_of_week: 0,
      start_time: start,
      end_time: index === 0 ? "09:15" : "09:30",
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      is_active: true,
      program_id: null,
      capacity: 20,
    }));
    const { page, errors } = await mount({ ...viewport, sessions, templates });
    try {
      const geometry = await canvasGeometry(page);
      assertSeparateRectangles(geometry, "visible");
      assertSeparateRectangles(geometry, "target");
      const clicked = await clickCanvasTargets(page, sessions);
      console.log(
        `mixed short geometry ${viewport.view} ${viewport.width}x${viewport.height}: ${JSON.stringify({ geometry, clicked })}`,
      );
      assert.deepEqual(
        clicked,
        sessions.map((item) => item.id),
      );
      const canvas = page.locator('[data-time-canvas-day="2026-10-11"]:visible');
      const warningIds = await canvas
        .locator('[data-conflict="true"]')
        .evaluateAll((cards) =>
          cards.map((card) => card.dataset.timeCanvasVisible.slice("session:".length)).sort(),
        );
      // The shared helper owns canceled-class warning policy. This assertion
      // follows its current behavior and the separately integrated correction.
      assert.deepEqual(warningIds, [...getConflictingSessionIds(sessions)].sort());
      await expect(
        canvas.locator('[data-time-canvas-visible="session:Overlap A"]'),
      ).toHaveAttribute("data-conflict", "true");
      await expect(
        canvas.locator('[data-time-canvas-visible="session:Adjacent"]'),
      ).not.toHaveAttribute("data-conflict", "true");
      await expect(
        canvas
          .locator('[data-time-canvas-block="session"]')
          .filter({ has: page.locator('[data-time-canvas-visible="session:Adjacent"]') }),
      ).toHaveAttribute("data-overlap", "false");
      await expect(
        canvas
          .locator('[data-time-canvas-block="session"]')
          .filter({ has: page.locator('[data-time-canvas-visible="session:After template"]') }),
      ).toHaveAttribute("data-overlap", "false");
      await expect(canvas.locator('[data-time-canvas-block="template"]')).toHaveCount(2);
      await expect(canvas.locator('[data-time-canvas-block="template"] button')).toHaveCount(0);
      await expect(canvas.locator('[data-time-canvas-visible="session:Canceled"]')).toHaveAttribute(
        "data-canceled",
        "true",
      );
      if (viewport.view === "week") {
        await expect(page.locator('[data-schedule-time-canvas="week"]')).toHaveAttribute(
          "data-schedule-week-peak-lanes",
          "6",
        );
      }
      assert.deepEqual(
        await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]),
        [viewport.width, viewport.width],
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

async function monthGeometry(page, relative = false) {
  return page.locator("[data-month-schedule-view]").evaluate((month, relative) => {
    const origin = relative ? month.getBoundingClientRect() : { x: 0, y: 0 };
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x: x - origin.x, y: y - origin.y, width, height };
    };
    const visible = (node) => node.getBoundingClientRect().height > 0;
    return {
      frame: rect(month),
      days: [...month.querySelectorAll("[data-month-schedule-day]")].filter(visible).map((day) => ({
        date: day.dataset.monthScheduleDay,
        ...rect(day),
        rows: [...day.querySelectorAll(".chip,.moreButton")].filter(visible).map(rect),
      })),
    };
  }, relative);
}

function recurringFixture() {
  const templates = [...Array.from({ length: 6 }, (_, i) => ({ day: 0, i })), { day: 1, i: 6 }].map(
    ({ day, i }) => ({
      id: `template-${i}`,
      name: `Class ${i + 1}`,
      day_of_week: day,
      start_time: `${String(9 + i).padStart(2, "0")}:00`,
      end_time: `${String(9 + i).padStart(2, "0")}:45`,
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      is_active: true,
      program_id: null,
      capacity: 20,
    }),
  );
  const sessions = Array.from(
    { length: 31 },
    (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`,
  ).flatMap((date) =>
    templates
      .filter((t) => t.day_of_week === new Date(`${date}T12:00:00Z`).getDay())
      .map((t) => ({
        ...session(`${t.id}-${date}`, date, t.start_time, t.end_time),
        name: t.name,
        template_id: t.id,
      })),
  );
  return { templates, sessions };
}

for (const viewport of geometryViewports) {
  test(`background refresh preserves calendar geometry at ${viewport.width}x${viewport.height}`, async () => {
    const { page, errors } = await mount({
      ...viewport,
      view: "month",
      sessions: [session("Karate")],
    });
    try {
      const before = await monthGeometry(page);
      await update(page, { isRefreshingRange: true });
      await expect(page.getByRole("status")).toHaveText(
        "Refreshing calendar. Showing the last loaded schedule.",
      );
      const during = await monthGeometry(page);
      console.log(
        `refresh ${viewport.width}x${viewport.height}: top ${before.frame.y} -> ${during.frame.y}`,
      );
      assert.deepEqual(during, before);
      await update(page, { isRefreshingRange: false });
      await expect(page.getByRole("status")).toHaveCount(0);
      assert.deepEqual(await monthGeometry(page), before);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test(`known recurring Month reserves days and rows at ${viewport.width}x${viewport.height}`, async () => {
    const { templates, sessions } = recurringFixture();
    const { page, errors } = await mount({
      ...viewport,
      view: "month",
      templates,
      hasLoadedRange: false,
    });
    try {
      await expect(page.getByRole("status")).toHaveText("Loading this calendar range...");
      await expect(page.locator(".monthFrame")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator(".monthGrid button")).toHaveCount(0);
      await expect(page.locator("[data-schedule-today-bar] button")).toHaveCount(0);
      await expect(page.locator(".todayChipLoading")).toHaveCount(viewport.width < 609 ? 0 : 6);
      await expect(page.getByText(/No classes/)).toHaveCount(0);
      const coldTop = (await monthGeometry(page)).frame.y;
      const cold = await monthGeometry(page, true);
      await update(page, { sessions, hasLoadedRange: true });
      await expect(page.locator(".monthFrame")).toHaveAttribute("aria-busy", "false");
      const loadedTop = (await monthGeometry(page)).frame.y;
      const loaded = await monthGeometry(page, true);
      console.log(
        `cold frame top ${viewport.width}x${viewport.height}: ${coldTop} -> ${loadedTop}`,
      );
      const summarize = (geometry) => ({
        height: geometry.frame.height,
        dates: geometry.days.map((day) => day.date),
        today: geometry.days.find((day) => day.date === "2026-10-11"),
      });
      console.log(
        `recurring ${viewport.width}x${viewport.height}: ${JSON.stringify({ cold: summarize(cold), loaded: summarize(loaded) })}`,
      );
      assert.deepEqual(cold, loaded);
      assert.equal(coldTop, loadedTop);
      const today = page.locator('[data-month-schedule-day="2026-10-11"]');
      await expect(today.locator("button.chip:visible")).toHaveCount(viewport.width < 760 ? 6 : 4);
      await expect(today.locator(".moreButton:visible")).toHaveCount(viewport.width < 760 ? 0 : 1);
      if (viewport.width < 760) {
        assert.equal(cold.days[0].date, "2026-10-11");
        await expect(page.locator('[data-month-schedule-day="2026-10-04"]')).toBeHidden();
        await page
          .getByRole("button", { name: "Earlier this month (2 days)", exact: true })
          .click();
        await expect(page.locator('[data-month-schedule-day="2026-10-04"]')).toBeVisible();
      }
      const once = {
        ...session("Once", "2026-10-11", "20:00", "21:00"),
        name: "A once-only workshop with a longer server-supplied class name",
      };
      await update(page, { sessions: [...sessions, once] });
      await expect(today.locator("button.chip").filter({ hasText: once.name })).toHaveCount(1);
      if (viewport.width < 760) {
        await expect(today.locator("button.chip:visible")).toHaveCount(7);
        assert.ok(
          (await today.boundingBox()).height >
            cold.days.find((day) => day.date === "2026-10-11").height,
        );
      } else {
        await expect(today.getByRole("button", { name: "+3 more", exact: true })).toBeVisible();
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("unknown empty Month remains loading and controls stay navigable without class actions", async () => {
  const { page, errors } = await mount({
    width: 390,
    height: 844,
    view: "month",
    hasLoadedRange: false,
  });
  try {
    await expect(page.getByRole("status")).toHaveText("Loading this calendar range...");
    await expect(page.getByText(/No classes/)).toHaveCount(0);
    await expect(page.locator(".monthGrid button")).toHaveCount(0);
    await expect(page.locator(".monthPending")).toHaveCount(42);
    await expect(page.getByRole("button", { name: "Next month", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Jump to today", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-schedule-agenda="week"]')).toBeVisible();
    assert.deepEqual(await page.evaluate(() => fixture.opened), []);
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await update(page, { hasLoadedRange: true });
    await expect(page.getByText("No classes in October 2026.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator(".monthPending,.todayChipLoading,.todayChipPending")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
