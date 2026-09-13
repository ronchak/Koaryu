import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const operationsComponents = bundle("production", { operationsComponents: true });

function program(id, name, color = "#38BDF8") {
  return {
    id,
    name,
    studio_id: "studio-1",
    sort_order: 0,
    is_system: false,
    color_hex: color,
    description: null,
    archived_at: null,
    usage: {
      student_count: 0,
      active_student_count: 0,
      class_count: 0,
      active_class_count: 0,
      lead_count: 0,
      belt_ladder_count: 0,
    },
  };
}

function session(id, date, startTime, endTime, templateId = null, programId = "program-1") {
  return {
    id,
    date,
    start_time: startTime,
    end_time: endTime,
    template_id: templateId,
    program_id: programId,
    name: id,
    capacity: 10,
    attendance_count: 3,
    status: "scheduled",
  };
}

function template(id, dayOfWeek, startTime, endTime, programId = "program-1") {
  return {
    id,
    day_of_week: dayOfWeek,
    start_time: startTime,
    end_time: endTime,
    program_id: programId,
    name: id,
    is_active: true,
    start_date: "2026-01-01",
    end_date: null,
  };
}

async function componentPage(browser, viewport = { width: 1040, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    '<style>html,body{width:100%;margin:0}*{box-sizing:border-box}.relative{position:relative}.absolute{position:absolute}.grid{display:grid}.inset-x-0{left:0;right:0}.surface{width:100%}[data-time-canvas-day]{width:100%}</style><main class="surface" id="root"></main>',
  );
  await page.evaluate(() => {
    window.fixture = {
      opened: [],
      submitted: [],
      studioStore: { currentRole: "admin", identityGeneration: 1 },
    };
  });
  await page.addScriptTag({ content: operationsComponents });
  return page;
}

function scheduleProps(overrides = {}) {
  return {
    businessDate: "2026-09-08",
    canManageSchedule: true,
    currentDate: new Date("2026-09-07T12:00:00"),
    view: "week",
    programFilter: "",
    sessions: [],
    templates: [],
    programs: [program("program-1", "Adult Karate"), program("program-2", "Kids Karate")],
    scheduleLoadError: null,
    hasLoadedRange: true,
    isRefreshingRange: false,
    actionMessage: null,
    ...overrides,
  };
}

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const accountRoutes = [
  "src/app/(dashboard)/account/page.tsx",
  "src/app/(dashboard)/account/profile/page.tsx",
  "src/app/(dashboard)/account/settings/page.tsx",
  "src/app/(dashboard)/account/personalization/page.tsx",
  "src/app/(dashboard)/account/notifications/page.tsx",
  "src/app/(dashboard)/account/data/page.tsx",
];

const helpRoutes = [
  "src/app/(dashboard)/help/page.tsx",
  "src/app/(dashboard)/help/get-started/page.tsx",
  "src/app/(dashboard)/help/release-notes/page.tsx",
  "src/app/(dashboard)/help/downloads/page.tsx",
  "src/app/(dashboard)/help/contact/page.tsx",
];

describe("operations surface route coverage", () => {
  it("joins all 21 owned destinations and four loading states to the scoped surface", () => {
    const directOwners = [
      [
        "/schedule",
        "src/components/schedule/schedule-page-content.tsx",
        /OperationsSurface page="schedule"/,
      ],
      [
        "/billing",
        "src/components/billing/billing-page-chrome.tsx",
        /OperationsSurface page="billing"/,
      ],
      ["/reports", "src/app/(dashboard)/reports/page.tsx", /OperationsSurface page="reports"/],
      [
        "/automations",
        "src/app/(dashboard)/automations/page.tsx",
        /OperationsSurface page="automations"/,
      ],
      ["/settings", "src/app/(dashboard)/settings/page.tsx", /OperationsSurface page="settings"/],
      [
        "/subscription-required",
        "src/app/(dashboard)/subscription-required/page.tsx",
        /OperationsSurface page="subscription-required"/,
      ],
      ["/onboarding", "src/app/onboarding/page.tsx", /FocusedOperationsSheet page="onboarding"/],
      [
        "/account-archived",
        "src/app/account-archived/page.tsx",
        /FocusedOperationsSheet page="account-archived"/,
      ],
      [
        "/access-denied",
        "src/app/access-denied/page.tsx",
        /FocusedOperationsSheet page="access-denied"/,
      ],
      [
        "/billing/connect/refresh",
        "src/app/billing/connect/refresh/page.tsx",
        /FocusedOperationsSheet page="connect-refresh"/,
      ],
    ];
    for (const [route, file, pattern] of directOwners) {
      assert.match(source(file), pattern, route);
    }
    for (const file of accountRoutes) assert.match(source(file), /<AccountPageShell/);
    for (const file of helpRoutes) {
      assert.match(source(file), /<AccountPageShell/);
      assert.match(source(file), /family="help"/);
    }
    const shell = source("src/components/account-page-shell.tsx");
    assert.match(shell, /<OperationsSurface page=\{family\}>/);

    for (const page of ["schedule", "billing", "reports", "settings"]) {
      const loading = source(`src/app/(dashboard)/${page}/loading.tsx`);
      assert.match(loading, new RegExp(`OperationsLoading[\\s\\S]*page="${page}"`));
    }
  });

  it("keeps styling local, opaque, reduced-motion safe, and print aware", () => {
    const css = source("src/components/operations/operations-surface.module.css");
    const operations = source("src/components/operations/operations-surface.tsx");
    assert.doesNotMatch(css, /gradient|backdrop-filter|backdrop-blur/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /@media print/);
    assert.match(css, /data-print-hide/);
    assert.match(css, /--operations-cobalt:\s*var\(--product-cobalt\);/);
    assert.match(css, /--accent:\s*var\(--product-wood\);/);
    assert.match(css, /outline:\s*2px solid var\(--product-cobalt, var\(--operations-cobalt\)\)/);
    assert.doesNotMatch(operations, /padStart\(2, "0"\)/);
    assert.match(
      css,
      /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\) \{\s*min-width: 44px;\s*min-height: 44px;/,
    );
    assert.match(
      css,
      /label:has\(input\[type="checkbox"\]\)[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
    );
    assert.match(css, /border-radius: 14px;/);
    assert.match(css, /border-radius: 18px/);
    assert.doesNotMatch(css, /text-transform:\s*uppercase/);
    assert.doesNotMatch(css, /\.surface :global\(button\) \{\s*min-height: 44px;/);
    assert.match(
      css,
      /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\),\s*\.surface :global\(\[data-print-hide="true"\]\)/,
    );
    assert.doesNotMatch(
      css,
      /\.surface :global\(button\),\s*\.surface :global\(\[data-print-hide="true"\]\)/,
    );
    assert.doesNotMatch(css, /\.surface > :global\(header\),/);
    assert.match(
      css,
      /\.surface > :global\(header\) \{[\s\S]*?position: static !important;[\s\S]*?display: flex !important;/,
    );
    assert.match(css, /a\[href="#main-content"\]/);
    assert.match(css, /\[class\*="bg-surface"\][\s\S]*?background: #fff !important;/);
  });
});

describe("operations behavior proof", () => {
  it("routes enlarged targets through the mounted schedule handler", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await componentPage(browser);
      const sessions = [
        session("left", "2026-09-07", "06:00", "06:15"),
        session("right", "2026-09-07", "06:00", "06:15"),
        session("tail", "2026-09-07", "06:15", "06:30"),
        session("next-day", "2026-09-08", "06:00", "06:15"),
      ];
      const templates = [template("missing-slot", 1, "06:15", "06:30")];
      await page.evaluate(
        (props) => fixture.renderSchedule(props),
        scheduleProps({ sessions, templates }),
      );
      await page.locator('[data-schedule-time-canvas="week"]').waitFor();

      const targetSizes = await page
        .locator('[data-time-canvas-block="session"]')
        .evaluateAll((buttons) =>
          buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { width: rect.width, height: rect.height, overlap: button.dataset.overlap };
          }),
        );
      assert.equal(
        targetSizes.every(({ width, height }) => width >= 44 && height >= 44),
        true,
      );
      assert.equal(
        targetSizes.slice(0, 3).every(({ overlap }) => overlap === "true"),
        true,
      );

      await page.getByRole("button", { name: "Open left at 6:00 AM" }).press("Enter");
      assert.deepEqual(await page.evaluate(() => fixture.opened), ["left"]);

      await page.evaluate(() => {
        const fallback = document.querySelector('button[aria-label="Open left at 6:00 AM"]');
        const visible = document.querySelector('[data-time-canvas-visible="session:tail"]');
        const rect = visible.getBoundingClientRect();
        fallback.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + 2,
            detail: 1,
          }),
        );
      });
      assert.deepEqual(await page.evaluate(() => fixture.opened), ["left", "tail"]);

      await page.evaluate(() => {
        const fallback = document.querySelector('button[aria-label="Open tail at 6:15 AM"]');
        const visible = document.querySelector(
          '[data-time-canvas-visible="template:missing-slot"]',
        );
        const rect = visible.getBoundingClientRect();
        fallback.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + 2,
            detail: 1,
          }),
        );
      });
      assert.deepEqual(await page.evaluate(() => fixture.opened), ["left", "tail"]);

      const adjacent = await page
        .locator('[data-time-canvas-visible="session:next-day"]')
        .boundingBox();
      await page.evaluate(
        ({ x, y }) => {
          const fallback = document.querySelector('button[aria-label="Open left at 6:00 AM"]');
          fallback.dispatchEvent(
            new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, detail: 1 }),
          );
        },
        { x: adjacent.x + 2, y: adjacent.y + 2 },
      );
      assert.deepEqual(await page.evaluate(() => fixture.opened), ["left", "tail", "left"]);
    } finally {
      await browser.close();
    }
  });

  it("renders recurring gaps and the studio business date consistently in every calendar view", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await componentPage(browser, { width: 1280, height: 900 });
      await page.clock.setFixedTime(new Date("2026-09-06T12:00:00Z"));
      const generated = session(
        "generated-slot",
        "2026-09-07",
        "09:00",
        "10:00",
        "generated-template",
      );
      const recurring = [
        template("generated-template", 1, "09:00", "10:00"),
        template("missing-slot", 1, "10:00", "11:00"),
        template("filtered-slot", 1, "11:00", "12:00", "program-2"),
      ];

      for (const view of ["month", "week", "day"]) {
        await page.evaluate(
          (props) => fixture.renderSchedule(props),
          scheduleProps({
            currentDate: "2026-09-07T12:00:00",
            programFilter: "program-1",
            sessions: [generated],
            templates: recurring,
            view,
          }),
        );
        if (view === "month") {
          const day = page.locator('[data-month-schedule-day="2026-09-07"]');
          await day.waitFor();
          assert.equal(await day.locator("text=generated-slot").count(), 1);
          assert.equal(await day.locator("text=missing-slot").count(), 1);
          assert.equal(await day.locator("text=filtered-slot").count(), 0);
          assert.match(await day.textContent(), /3\/10/);
        } else {
          const canvas = page.locator(`[data-schedule-time-canvas="${view}"]`);
          await canvas.waitFor();
          assert.equal(
            await canvas.locator('[data-time-canvas-visible="session:generated-slot"]').count(),
            1,
          );
          assert.equal(
            await canvas.locator('[data-time-canvas-visible="template:missing-slot"]').count(),
            1,
          );
          assert.equal(
            await canvas.locator('[data-time-canvas-visible="template:filtered-slot"]').count(),
            0,
          );
        }
      }

      await page.evaluate(
        (props) => fixture.renderSchedule(props),
        scheduleProps({
          currentDate: "2026-09-07T12:00:00",
          sessions: [],
          templates: [recurring[1]],
          view: "day",
        }),
      );
      await page.locator('[data-schedule-time-canvas="day"]').waitFor();
      assert.equal(await page.getByText("No sessions scheduled for this day.").count(), 0);

      await page.evaluate(
        (props) => fixture.renderSchedule(props),
        scheduleProps({
          currentDate: "2026-09-08T12:00:00",
          sessions: [],
          templates: recurring,
          view: "day",
        }),
      );
      await page.getByText("No sessions scheduled for this day.").waitFor();
      assert.equal(await page.locator("[data-time-canvas-block]").count(), 0);

      await page.evaluate(
        (props) => fixture.renderSchedule(props),
        scheduleProps({
          currentDate: "2026-09-07T12:00:00",
          view: "week",
        }),
      );
      await page.locator('[data-schedule-time-canvas="week"]').waitFor();
      assert.equal(await page.locator('[aria-current="date"]').textContent(), "Tue8");

      await page.evaluate(
        (props) => fixture.renderSchedule(props),
        scheduleProps({
          currentDate: "2026-09-07T12:00:00",
          view: "month",
        }),
      );
      await page.locator('[data-month-schedule-day="2026-09-08"]').waitFor();
      assert.equal(
        await page.locator('[data-month-day-today="true"]').getAttribute("data-month-schedule-day"),
        "2026-09-08",
      );
    } finally {
      await browser.close();
    }
  });

  it("renders mounted ordinary and crowded Week print geometry without horizontal clipping", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await componentPage(browser, { width: 816, height: 1056 });
      const dates = [
        "2026-09-06",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
        "2026-09-12",
      ];
      for (const entriesPerDay of [1, 7]) {
        const sessions = dates.flatMap((date, day) =>
          Array.from({ length: entriesPerDay }, (_, entry) =>
            session(`session-${day + 1}-${entry + 1}`, date, "08:00", "08:30"),
          ),
        );
        await page.emulateMedia({ media: "screen" });
        await page.evaluate(
          (props) => fixture.renderSchedule(props),
          scheduleProps({
            currentDate: "2026-09-07T12:00:00",
            sessions,
            view: "week",
          }),
        );
        const owner = page.locator('[data-schedule-screen-week="true"]');
        await owner.waitFor();
        const expectedScreenWidth = Math.max(1040, 72 + 7 * entriesPerDay * 48);
        const screenGeometry = await owner.evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          printDisplay: getComputedStyle(
            document.querySelector('[data-schedule-print-week="true"]'),
          ).display,
          peakLanes: Number(
            document.querySelector('[data-schedule-time-canvas="week"]').dataset
              .scheduleWeekPeakLanes,
          ),
        }));
        assert.equal(screenGeometry.clientWidth, 816);
        assert.ok(screenGeometry.scrollWidth >= expectedScreenWidth);
        assert.ok(screenGeometry.scrollWidth <= expectedScreenWidth + 16);
        assert.equal(screenGeometry.printDisplay, "none");
        assert.equal(screenGeometry.peakLanes, entriesPerDay);

        await page.emulateMedia({ media: "print" });
        const printGeometry = await page
          .locator('[data-schedule-print-week="true"]')
          .evaluate((grid) => {
            const owner = document.querySelector('[data-schedule-screen-week="true"]');
            const dayElements = [...grid.querySelectorAll("[data-schedule-print-day]")];
            const entryElements = [...grid.querySelectorAll("[data-schedule-print-entry]")];
            const gridRect = grid.getBoundingClientRect();
            const dayRects = dayElements.map((day) => day.getBoundingClientRect());
            return {
              ownerDisplay: getComputedStyle(owner).display,
              gridDisplay: getComputedStyle(grid).display,
              gridColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
              gridContained:
                gridRect.left >= 0 && gridRect.right <= document.documentElement.clientWidth,
              dayCount: dayElements.length,
              entryCount: entryElements.length,
              dayTopSpread:
                Math.max(...dayRects.map((rect) => rect.top)) -
                Math.min(...dayRects.map((rect) => rect.top)),
              dayWidthsAligned:
                Math.max(...dayRects.map((rect) => rect.width)) -
                  Math.min(...dayRects.map((rect) => rect.width)) <=
                1,
              entriesContained: dayElements.every((day) => {
                const dayRect = day.getBoundingClientRect();
                return [...day.querySelectorAll("[data-schedule-print-entry]")].every((entry) => {
                  const rect = entry.getBoundingClientRect();
                  return (
                    rect.left >= dayRect.left && rect.right <= dayRect.right && rect.height > 0
                  );
                });
              }),
              firstDayOrder: [
                ...dayElements[0].querySelectorAll("[data-schedule-print-entry] strong"),
              ].map((element) => element.textContent),
              documentWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
        const expectedOrder = Array.from(
          { length: entriesPerDay },
          (_, index) => `session-1-${index + 1}`,
        );
        assert.deepEqual(printGeometry, {
          ownerDisplay: "none",
          gridDisplay: "grid",
          gridColumns: 7,
          gridContained: true,
          dayCount: 7,
          entryCount: 7 * entriesPerDay,
          dayTopSpread: 0,
          dayWidthsAligned: true,
          entriesContained: true,
          firstDayOrder: expectedOrder,
          documentWidth: 816,
          scrollWidth: 816,
        });
      }
    } finally {
      await browser.close();
    }
  });

  it("prints Schedule Header and selected Program context natively on the first frame", async () => {
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    const header = source("src/components/header.tsx");
    const globals = source("src/app/globals.css");
    const css = source("src/components/operations/operations-surface.module.css");
    const headerTransitionCss = globals.match(/\.koaryu-surface-transition\s*\{[\s\S]*?\}/)?.[0];
    const selectTransitionCss = globals.match(/input,\s*textarea,\s*select\s*\{[\s\S]*?\}/)?.[0];
    const browserCss = css.replaceAll(":global(", ":is(");
    assert.ok(headerTransitionCss, "shared Header transition CSS must be extractable");
    assert.ok(selectTransitionCss, "production select transition CSS must be extractable");
    assert.match(header, /<header className="koaryu-surface-transition/);
    assert.match(schedule, /data-schedule-program-filter=\{programFilter \? "selected" : "all"\}/);
    assert.match(schedule, /value=\{programFilter\}/);
    assert.match(
      schedule,
      /onChange=\{\(event\) => onProgramFilterChange\(event\.target\.value\)\}/,
    );
    assert.match(
      css,
      /\.surface\[data-operations-page="schedule"\] > :global\(header\),[\s\S]*?\[data-schedule-program-filter\][\s\S]*?border-radius: 0 !important;[\s\S]*?background: #fff !important;[\s\S]*?color: #000 !important;[\s\S]*?box-shadow: none !important;[\s\S]*?transition: none !important;/,
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ media: "screen" });
        const ground = theme === "light" ? "rgb(246, 241, 234)" : "rgb(35, 32, 30)";
        const raised = theme === "light" ? "rgb(255, 252, 247)" : "rgb(52, 48, 45)";
        const screenText = theme === "light" ? "rgb(24, 22, 20)" : "rgb(244, 240, 236)";
        await page.setContent(
          "<style>html, body { width: 100%; margin: 0; } " +
            selectTransitionCss +
            headerTransitionCss +
            browserCss +
            "</style>" +
            '<div data-theme="' +
            theme +
            '" data-koaryu-dashboard-shell="true" style="' +
            "--motion-fast:120ms;--motion-medium:240ms;--ease-standard:ease;" +
            "--product-ground:" +
            ground +
            ";--product-paper:" +
            raised +
            ";--product-card-stock:" +
            raised +
            ";" +
            "--product-rule-soft:rgb(140,140,140);--product-ink:" +
            screenText +
            ";--product-soft-ink:" +
            screenText +
            '">' +
            '<main class="surface" data-operations-page="schedule">' +
            '<header class="koaryu-surface-transition" style="box-sizing:border-box;background:' +
            ground +
            ";color:" +
            screenText +
            ';width:100%;padding:16px"><h1 style="margin:0">Schedule</h1></header>' +
            '<div style="padding:16px">' +
            '<select aria-label="Filter schedule by program" data-schedule-program-filter="selected" ' +
            'style="box-sizing:border-box;background:' +
            raised +
            ";color:" +
            screenText +
            ';box-shadow:none">' +
            '<option value="">All programs</option>' +
            '<option value="program-1" selected>Adult Karate</option>' +
            "</select>" +
            "</div>" +
            "</main>" +
            "</div>",
        );

        const screenChrome = await page.evaluate(() => {
          const headerElement = document.querySelector("header");
          const filter = document.querySelector("[data-schedule-program-filter]");
          const headerStyle = getComputedStyle(headerElement);
          const filterStyle = getComputedStyle(filter);
          return {
            filter: {
              background: filterStyle.backgroundColor,
              radius: filterStyle.borderRadius,
              selectedLabel: filter.selectedOptions[0]?.textContent,
              transitionDuration: filterStyle.transitionDuration,
              transitionProperty: filterStyle.transitionProperty,
              value: filter.value,
            },
            header: {
              background: headerStyle.backgroundColor,
              transitionDuration: headerStyle.transitionDuration,
              transitionProperty: headerStyle.transitionProperty,
            },
          };
        });
        assert.equal(screenChrome.header.background, ground);
        assert.equal(screenChrome.header.transitionProperty.includes("background-color"), true);
        assert.notEqual(screenChrome.header.transitionDuration, "0s");
        assert.equal(screenChrome.filter.background, raised);
        assert.equal(screenChrome.filter.radius, "10px");
        assert.equal(screenChrome.filter.transitionProperty.includes("background-color"), true);
        assert.notEqual(screenChrome.filter.transitionDuration, "0s");
        assert.equal(screenChrome.filter.value, "program-1");
        assert.equal(screenChrome.filter.selectedLabel, "Adult Karate");

        await page.emulateMedia({ media: "print" });
        const printChrome = await page.evaluate(() => {
          const headerElement = document.querySelector("header");
          const filter = document.querySelector("[data-schedule-program-filter]");
          const headerStyle = getComputedStyle(headerElement);
          const filterStyle = getComputedStyle(filter);
          const headerRect = headerElement.getBoundingClientRect();
          const filterRect = filter.getBoundingClientRect();
          return {
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            filter: {
              background: filterStyle.backgroundColor,
              boxShadow: filterStyle.boxShadow,
              color: filterStyle.color,
              contained:
                filterRect.left >= 0 && filterRect.right <= document.documentElement.clientWidth,
              radius: filterStyle.borderRadius,
              selectedLabel: filter.selectedOptions[0]?.textContent,
              transitionDuration: filterStyle.transitionDuration,
              transitionProperty: filterStyle.transitionProperty,
              value: filter.value,
            },
            header: {
              background: headerStyle.backgroundColor,
              boxShadow: headerStyle.boxShadow,
              color: headerStyle.color,
              contained:
                headerRect.left >= 0 && headerRect.right <= document.documentElement.clientWidth,
              radius: headerStyle.borderRadius,
              transitionDuration: headerStyle.transitionDuration,
              transitionProperty: headerStyle.transitionProperty,
            },
          };
        });
        for (const element of [printChrome.header, printChrome.filter]) {
          assert.equal(element.background, "rgb(255, 255, 255)");
          assert.equal(element.boxShadow, "none");
          assert.equal(element.color, "rgb(0, 0, 0)");
          assert.equal(element.contained, true);
          assert.equal(element.radius, "0px");
          assert.equal(element.transitionDuration, "0s");
          assert.equal(element.transitionProperty, "none");
        }
        assert.equal(printChrome.filter.value, "program-1");
        assert.equal(printChrome.filter.selectedLabel, "Adult Karate");
        assert.equal(printChrome.documentClientWidth, 816);
        assert.equal(printChrome.documentScrollWidth, 816);
      }
    } finally {
      await browser.close();
    }
  });

  it("submits the mounted Program form and prints the mounted Month calendar in both themes", async () => {
    const css = source("src/components/operations/operations-surface.module.css");
    const browserCss = css.replaceAll(":global(", ":is(");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await componentPage(browser, { width: 390, height: 844 });
      await page.addStyleTag({
        content:
          browserCss +
          `
          #root { padding: 32px; }
          [data-program-input], [data-program-submit="true"] { min-height: 44px; }
          [data-month-schedule-view] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
          [data-month-schedule-day] { min-width: 0; border: 1px solid rgb(120, 120, 120); overflow: hidden; }
        `,
      });
      await page.evaluate(() => {
        document.getElementById("root").dataset.operationsPage = "settings";
        fixture.programStore = {
          programs: [],
          programsLoaded: true,
          programsUsageLoaded: true,
          programsUsageLoadError: null,
          programsLoadError: null,
          refreshPrograms: async () => {},
          createProgram: async (payload) => fixture.submitted.push({ action: "create", payload }),
          updateProgram: async (id, payload) =>
            fixture.submitted.push({ action: "update", id, payload }),
          archiveProgram: async () => {},
          restoreProgram: async () => {},
        };
        fixture.renderPrograms();
      });
      await page.locator('[data-program-form="true"]').waitFor();
      await page.locator('[data-program-input="name"]').fill("  Adult Karate  ");
      await page.locator('[data-program-input="description"]').fill(" Evening program ");
      await page.getByRole("button", { name: "Use #A855F7" }).click();
      await page.locator('[data-program-submit="true"]').click();
      await page.waitForFunction(() => fixture.submitted.length === 1);
      assert.deepEqual(await page.evaluate(() => fixture.submitted[0]), {
        action: "create",
        payload: {
          name: "Adult Karate",
          description: "Evening program",
          color_hex: "#A855F7",
          sort_order: 0,
        },
      });

      const formGeometry = await page.locator('[data-program-form="true"]').evaluate((form) => {
        const formRect = form.getBoundingClientRect();
        const controls = [...form.querySelectorAll("input, button")];
        return {
          contained: controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return rect.left >= formRect.left && rect.right <= formRect.right;
          }),
          swatches: controls
            .filter((control) => control.hasAttribute("data-program-swatch"))
            .every((control) => {
              const rect = control.getBoundingClientRect();
              return rect.width >= 44 && rect.height >= 44;
            }),
          documentWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      assert.equal(formGeometry.contained, true);
      assert.equal(formGeometry.swatches, true);
      assert.equal(formGeometry.documentWidth, 390);
      assert.equal(formGeometry.scrollWidth, 390);

      await page.setViewportSize({ width: 816, height: 1056 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ media: "screen" });
        await page.evaluate(
          ({ props, theme }) => {
            const root = document.getElementById("root");
            root.dataset.operationsPage = "schedule";
            root.dataset.theme = theme;
            root.style.setProperty("--product-paper", theme === "light" ? "#fafafa" : "#1e1e1e");
            root.style.setProperty("--product-shadow-card", "0 8px 24px rgba(0,0,0,.24)");
            fixture.renderSchedule(props);
          },
          {
            props: scheduleProps({
              businessDate: "2026-09-08",
              currentDate: "2026-09-07T12:00:00",
              sessions: [session("print-session", "2026-09-07", "09:00", "10:00")],
              templates: [template("print-placeholder", 1, "10:00", "11:00")],
              view: "month",
            }),
            theme,
          },
        );
        const month = page.locator("[data-month-schedule-view]");
        await month.waitFor();
        assert.equal(await month.locator("[data-month-schedule-day]").count(), 42);
        assert.equal(await month.locator('[data-month-day-scope="in-month"]').count(), 30);
        assert.equal(await month.locator('[data-month-day-scope="out-of-month"]').count(), 12);
        assert.equal(
          await month
            .locator('[data-month-day-today="true"]')
            .getAttribute("data-month-schedule-day"),
          "2026-09-08",
        );
        assert.equal(
          await month
            .locator('[data-month-day-selected="true"]')
            .getAttribute("data-month-schedule-day"),
          "2026-09-07",
        );

        await page.emulateMedia({ media: "print" });
        const printGeometry = await month.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const cells = [...element.querySelectorAll("[data-month-schedule-day]")];
          return {
            background: style.backgroundColor,
            radius: style.borderRadius,
            shadow: style.boxShadow,
            overflow: style.overflow,
            contained: rect.left >= 0 && rect.right <= document.documentElement.clientWidth,
            cellsWhite: cells.every(
              (cell) => getComputedStyle(cell).backgroundColor === "rgb(255, 255, 255)",
            ),
            cellsFlat: cells.every((cell) => {
              const cellStyle = getComputedStyle(cell);
              return (
                cellStyle.borderTopColor === "rgb(119, 119, 119)" &&
                cellStyle.borderRadius === "0px" &&
                cellStyle.boxShadow === "none" &&
                cellStyle.overflow === "visible"
              );
            }),
            documentWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
        assert.deepEqual(printGeometry, {
          background: "rgb(255, 255, 255)",
          radius: "0px",
          shadow: "none",
          overflow: "visible",
          contained: true,
          cellsWhite: true,
          cellsFlat: true,
          documentWidth: 816,
          scrollWidth: 816,
        });
      }
    } finally {
      await browser.close();
    }
  });

  it("keeps Month responsive while Week remains the sole horizontal schedule canvas", () => {
    const month = source("src/components/schedule/month-schedule-view.tsx");
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    assert.doesNotMatch(month, /overflow-x-auto|min-w-\[980px\]/);
    assert.match(month, /grid grid-cols-2 xl:grid-cols-7/);
    assert.match(month, /hidden grid-cols-7[^"\n]*xl:grid/);
    assert.doesNotMatch(month, /lg:grid-cols-7|lg:grid|lg:hidden/);
    assert.match(month, /MONTH_DAY_NAMES\[day\.date\.getDay\(\)\]/);
    assert.match(schedule, /overflow-x-auto overscroll-x-contain/);
    assert.match(schedule, /data-schedule-scroll-owner="internal"/);
    assert.match(schedule, /const WEEK_CANVAS_MIN_WIDTH = 1040/);
    assert.match(schedule, /const SESSION_LANE_MIN_WIDTH = 48/);
    assert.match(schedule, /const weekDayMinWidth = peakWeekLaneCount \* SESSION_LANE_MIN_WIDTH/);
    assert.match(
      schedule,
      /const weekCanvasMinWidth = Math\.max\([\s\S]*WEEK_CANVAS_MIN_WIDTH,[\s\S]*WEEK_TIME_COLUMN_WIDTH \+ WEEK_DAY_COUNT \* weekDayMinWidth/,
    );
    assert.match(schedule, /style=\{\{ minWidth: weekCanvasMinWidth \}\}/);
    assert.equal(
      (schedule.match(/style=\{\{ gridTemplateColumns: weekGridTemplateColumns \}\}/g) || [])
        .length,
      2,
    );
    assert.match(schedule, /data-schedule-week-peak-lanes=\{peakWeekLaneCount\}/);
    assert.match(schedule, /grid grid-cols-\[4\.5rem_minmax\(0,1fr\)\]/);
  });

  it("keeps six billing views, negative capabilities, and the connected Admin reset gate", () => {
    const chrome = source("src/components/billing/billing-page-chrome.tsx");
    const sections = source("src/components/billing/billing-page-sections.tsx");
    const controller = source("src/lib/billing-page-controller.ts");
    const negativeCopy = [
      source("src/components/billing/billing-plans-tab.tsx"),
      source("src/components/billing/billing-families-tab.tsx"),
      source("src/components/billing/billing-invoices-tab.tsx"),
      source("src/components/billing/billing-reports-tab.tsx"),
    ].join("\n");
    for (const label of [
      "Setup",
      "Tuition Plans",
      "Families",
      "Student Billing",
      "Invoices",
      "Advanced",
    ]) {
      assert.match(chrome, new RegExp(`label: "${label}"`));
    }
    assert.match(chrome, /data-billing-ledger="six-views"/);
    assert.match(chrome, /data-billing-book-index="six-views"/);
    assert.doesNotMatch(chrome, /data-billing-register-context|Open book|View book/);
    assert.match(chrome, /data-billing-setup-register="true"/);
    assert.match(chrome, /<Header title="Billing">/);
    assert.doesNotMatch(chrome, /String\(index \+ 1\)\.padStart/);
    assert.match(sections, /data-billing-money-band="exceptions-first"/);
    assert.match(
      sections,
      /label: "Needs attention"[\s\S]*label: "Open receivables"[\s\S]*label: "Collected this UTC month"/,
    );
    assert.match(sections, /Reset Stripe connection\?/);
    assert.match(sections, /onConnectReset/);
    assert.match(
      controller,
      /!isPreviewMode[\s\S]*canManageKoaryuSubscription[\s\S]*hasStripeConnectedAccount[\s\S]*connectOnboardingEnabled/,
    );
    assert.match(sections, /disabled=\{!coreCheckoutEnabled[\s\S]*Start checkout/);
    assert.match(sections, /disabled=\{!corePortalEnabled[\s\S]*Customer portal/);
    assert.match(sections, /disabled=\{!connectOnboardingEnabled[\s\S]*connectActionLabel/);
    assert.match(sections, /disabled=\{!connectDashboardEnabled[\s\S]*Stripe dashboard/);
    assert.match(negativeCopy, /Existing plans can sync through one replay-safe provider workflow/);
    assert.match(negativeCopy, /Staff cannot accept payment terms for a payer/);
    assert.match(
      negativeCopy,
      /Koaryu preserves the original request key after an uncertain provider outcome/,
    );
    assert.match(negativeCopy, /canUseWorkflow\("plan\.sync"\)[\s\S]*onPlanSync\(plan\.id\)/);
    assert.match(negativeCopy, /canUseWorkflow\("payer\.sync"\)[\s\S]*onPayerSync\(payer\.id\)/);
    assert.match(negativeCopy, /canUseWorkflow\("payer\.setup"\)[\s\S]*onAutopaySetup\(payer\)/);
    assert.match(negativeCopy, /payerSetupActionLabel\(payer\)/);
    assert.match(negativeCopy, /window\.confirm\(`Disable autopay for \$\{payer\.display_name\}\?/);
    assert.match(
      negativeCopy,
      /canUseWorkflow\("invoice\.finalize"\)[\s\S]*onInvoiceAction\(invoice\.id, "finalize"\)/,
    );
  });

  it("keeps Automations read-only with live destinations separated from proposals", () => {
    const automations = source("src/app/(dashboard)/automations/page.tsx");
    const css = source("src/components/operations/operations-surface.module.css");
    const automationCss = css.slice(css.indexOf("/* Automations"), css.indexOf("/* Reports"));
    const futureSection = automations.slice(
      automations.indexOf('<section aria-labelledby="future-workflows-title"'),
      automations.indexOf(
        "</section>",
        automations.indexOf('<section aria-labelledby="future-workflows-title"'),
      ) + "</section>".length,
    );

    assert.doesNotMatch(
      automations,
      /<form|<input|<select|<textarea|onChange=|type="checkbox"|role="switch"|\bfetch\s*\(|\bapi\.|\baxios\b|process\.env|isPreviewMode|useEffect|useState/,
    );
    assert.match(automations, /data-automations-readonly="true"/);
    assert.match(automations, /data-automation-catalog="live-queues-and-proposals"/);
    assert.match(automations, /<Header title="Automations">/);
    assert.doesNotMatch(automations, /<h1/);
    assert.match(
      automations,
      /<ol[^>]*data-automation-live-list="four-destinations"[\s\S]*LIVE_QUEUES\.map[\s\S]*<Link[\s\S]*prefetch=\{crmLinkPrefetch\(queue\.href\)\}[\s\S]*data-automation-live-target="true"/,
    );
    assert.match(
      automations,
      /className="grid min-h-20 min-w-0 grid-cols-\[minmax\(0,1fr\)_auto\][^"]*"/,
    );
    assert.match(
      automations,
      /overflow-x-hidden[\s\S]*sm:grid-cols-\[minmax\(12rem,0\.36fr\)_minmax\(0,1fr\)\][\s\S]*break-words/,
    );
    assert.match(
      automations,
      /<dl[^>]*data-automation-future-list="five-proposals"[\s\S]*FUTURE_WORKFLOWS\.map/,
    );
    assert.doesNotMatch(
      futureSection,
      /<Link|<Button|<button|<form|<input|<select|<textarea|onClick=|onChange=/,
    );
    assert.doesNotMatch(automations, /data-automation-worksheet|>Trigger<|>Action<|>Status</);
    assert.match(
      automationCss,
      /\.surface\[data-operations-page="automations"\][\s\S]*data-automation-catalog="live-queues-and-proposals"[\s\S]*border-radius: 14px;[\s\S]*background: var\(--product-paper\);[\s\S]*box-shadow: var\(--product-shadow-card\);/,
    );
    assert.match(
      automationCss,
      /data-automation-inset="true"[\s\S]*border: 1px solid var\(--product-rule\);[\s\S]*border-radius: 10px;[\s\S]*background: var\(--product-card-stock\);/,
    );
    assert.match(
      automationCss,
      /data-automation-live-target="true"[^\n]*:focus-visible[\s\S]*outline-color: var\(--product-focus\) !important;/,
    );
    assert.doesNotMatch(automationCss, /#[0-9a-f]{3,8}|gradient|--operations-cobalt/);
  });

  it("keeps settings indexed behind the Admin boundary", () => {
    const settings = source("src/app/(dashboard)/settings/page.tsx");
    const programs = source("src/components/settings/programs-section.tsx");
    const staff = source("src/components/settings/staff-roles-section.tsx");
    const operationsStyles = source("src/components/operations/operations-surface.module.css");
    assert.match(
      settings,
      /canAccessSettings\(currentRole\) \? <AdminSettingsContent \/> : <SettingsAccessNotice \/>/,
    );
    assert.match(settings, /<Header title="Settings" \/>/);
    assert.doesNotMatch(settings, /Studio configuration and preferences/);
    assert.match(settings, /data-settings-folio="admin-ownership"/);
    assert.equal((settings.match(/data-settings-owner=/g) || []).length, 5);
    for (const id of ["studio", "programs", "staff-roles", "data-controls"]) {
      assert.match(settings, new RegExp(`(?:href="#${id}"|id="${id}")`));
    }
    for (const marker of [
      "createProgram",
      "updateProgram",
      "archiveProgram",
      "restoreProgram",
      "is_system",
      "usage",
    ]) {
      assert.match(programs, new RegExp(marker));
    }
    assert.match(
      programs,
      /COLOR_SWATCHES\.map[\s\S]*className=\{`relative flex h-11 w-11 shrink-0/,
    );
    assert.doesNotMatch(programs, /className=\{`relative flex h-8 w-8/);
    assert.match(programs, /break-words md:truncate" title=\{program\.description\}/);
    assert.match(
      programs,
      /break-words md:truncate" title=\{usageLabel\(program, programsUsageLoaded, programsUsageLoadError\)\}/,
    );
    for (const marker of [
      "inviteEmail",
      "inviteFullName",
      "inviteLegalFirstName",
      "inviteLegalLastName",
      'useState<StaffRoleName>("instructor")',
      "matchesStaffDeletionConfirmation",
      "archiveStaff",
      "unarchiveStaff",
      "scheduleStaffDeletion",
      "showArchived",
    ]) {
      assert.match(staff, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(
      staff,
      /<label className="flex min-h-11 items-center[\s\S]*aria-label="Show archived staff"/,
    );
    assert.match(
      operationsStyles,
      /data-operations-page="settings"[\s\S]*data-settings-owner[\s\S]*overflow: hidden;[\s\S]*border-radius: 14px/,
    );
  });

  it("keeps report figures semantic and reserves cobalt for data series", () => {
    const reports = source("src/app/(dashboard)/reports/page.tsx");
    const sections = source("src/components/reports/reports-page-sections.tsx");
    assert.match(reports, /data-reports-reading-document="true"/);
    assert.match(reports, /data-report-figure-band="comparisons"/);
    assert.match(reports, /bg-\[var\(--operations-cobalt\)\]/);
    assert.match(sections, /<figure[\s\S]*data-report-figure="headline"/);
    assert.match(sections, /data-report-section="reading-block"/);
    const exports = source("src/components/reports/reports-data-exports-panel.tsx");
    assert.match(exports, /break-words[^"\n]*sm:truncate" title=\{report\.title\}/);
  });

  it("adds the typed deletion gate and complete support context/inbox states without new APIs", () => {
    const account = source("src/app/(dashboard)/account/settings/page.tsx");
    const contact = source("src/app/(dashboard)/help/contact/page.tsx");
    assert.match(account, /Type DELETE to continue/);
    assert.match(account, /deletionConfirmation !== "DELETE"/);
    assert.match(account, /interface confirmation[\s\S]*API does not require this phrase/);
    assert.match(account, /Checking account deletion status/);
    assert.match(
      account,
      /const isPreviewMode = process\.env\.NEXT_PUBLIC_PREVIEW_MODE === "true"/,
    );
    assert.match(account, /useState\(!isPreviewMode\)/);
    assert.match(account, /if \(!isAdmin \|\| staffLoaded\) return;/);
    assert.match(account, /\[isAdmin, refreshStaff, staffLoaded\]/);
    for (const label of ["Current page", "Expected result", "Actual result"])
      assert.match(contact, new RegExp(label));
    assert.match(contact, /page_url: currentPage\.trim\(\) \|\| null/);
    assert.match(contact, /expected_result: expectedResult\.trim\(\)/);
    assert.match(contact, /actual_result: actualResult\.trim\(\)/);
    assert.match(contact, /Subject must be between 3 and 160 characters/);
    assert.match(contact, /Details must be between 10 and 5,000 characters/);
    assert.match(contact, /initialTopic[\s\S]*return "billing"/);
    assert.match(contact, /useState<SupportTicketSeverity>\("normal"\)/);
    for (const state of ["loading", "ready", "error"])
      assert.match(contact, new RegExp(`"${state}"`));
    assert.match(contact, /Retry recent requests/);
  });

  it("checks transition effect ownership and fail-closed source policy", () => {
    const onboarding = source("src/app/onboarding/page.tsx");
    const archived = source("src/app/account-archived/page.tsx");
    const denied = source("src/app/access-denied/page.tsx");
    const refresh = source("src/app/billing/connect/refresh/page.tsx");
    const legal = source("src/components/account/legal-name-blocking-screen.tsx");
    assert.match(onboarding, /useState\("America\/New_York"\)/);
    assert.match(onboarding, /studioName\.trim\(\)/);
    assert.match(onboarding, /"Idempotency-Key"/);
    assert.doesNotMatch(archived, /useStudioStore|\/studios|\/bootstrap/);
    assert.doesNotMatch(denied, /useStudioStore|\bapi\./);
    assert.match(refresh, /acknowledgeConnectOnboardingBeforeNavigation/);
    assert.match(legal, /updateUserLegalName/);
  });
});
