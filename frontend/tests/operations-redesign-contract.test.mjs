import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chromium } from "@playwright/test";

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
      ["/schedule", "src/components/schedule/schedule-page-content.tsx", /OperationsSurface page="schedule"/],
      ["/billing", "src/components/billing/billing-page-chrome.tsx", /OperationsSurface page="billing"/],
      ["/reports", "src/app/(dashboard)/reports/page.tsx", /OperationsSurface page="reports"/],
      ["/automations", "src/app/(dashboard)/automations/page.tsx", /OperationsSurface page="automations"/],
      ["/settings", "src/app/(dashboard)/settings/page.tsx", /OperationsSurface page="settings"/],
      ["/subscription-required", "src/app/(dashboard)/subscription-required/page.tsx", /OperationsSurface page="subscription-required"/],
      ["/onboarding", "src/app/onboarding/page.tsx", /FocusedOperationsSheet page="onboarding"/],
      ["/account-archived", "src/app/account-archived/page.tsx", /FocusedOperationsSheet page="account-archived"/],
      ["/access-denied", "src/app/access-denied/page.tsx", /FocusedOperationsSheet page="access-denied"/],
      ["/billing/connect/refresh", "src/app/billing/connect/refresh/page.tsx", /FocusedOperationsSheet page="connect-refresh"/],
    ];
    assert.equal(directOwners.length + accountRoutes.length + helpRoutes.length, 21);
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
    assert.match(css, /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\) \{\s*min-width: 44px;\s*min-height: 44px;/);
    assert.match(css, /label:has\(input\[type="checkbox"\]\)[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/);
    assert.match(css, /border-radius: 14px;/);
    assert.match(css, /border-radius: 18px/);
    assert.doesNotMatch(css, /text-transform:\s*uppercase/);
    assert.doesNotMatch(css, /\.surface :global\(button\) \{\s*min-height: 44px;/);
    assert.match(css, /\.surface :global\(button:not\(\[data-time-canvas-block\]\)\),\s*\.surface :global\(\[data-print-hide="true"\]\)/);
    assert.doesNotMatch(css, /\.surface :global\(button\),\s*\.surface :global\(\[data-print-hide="true"\]\)/);
    assert.doesNotMatch(css, /\.surface > :global\(header\),/);
    assert.match(css, /\.surface > :global\(header\) \{[\s\S]*?position: static !important;[\s\S]*?display: flex !important;/);
    assert.match(css, /a\[href="#main-content"\]/);
    assert.match(css, /\[class\*="bg-surface"\][\s\S]*?background: #fff !important;/);
  });
});

describe("operations behavior proof", () => {
  it("makes schedule time, overlap, internal overflow, and immediate attendance commit truth explicit", () => {
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    const attendance = source("src/components/schedule/session-detail-modal.tsx");
    assert.match(schedule, /data-schedule-time-canvas="week"/);
    assert.match(schedule, /data-schedule-time-canvas="day"/);
    assert.match(schedule, /data-schedule-day-sheet="true"/);
    assert.match(schedule, /data-schedule-register="visible-range"/);
    assert.match(schedule, /<SlidingSegmentedControl[\s\S]*ariaLabel="Schedule view"[\s\S]*onChange=\{onViewChange\}/);
    assert.match(schedule, /style=\{\{ top, height,[\s\S]{0,200}?data-time-canvas-block="template"/);
    assert.match(schedule, /const targetHeight = Math\.max\(44, height\)/);
    assert.match(schedule, /const targetTop = Math\.max\(0, top - \(targetHeight - height\) \/ 2\)/);
    assert.match(schedule, /const sessionWidth = `max\(44px, calc\(\$\{laneWidth\}% - 4px\)\)`/);
    assert.match(schedule, /const sessionLeft = `min\(calc\(\$\{left\}% \+ 2px\), calc\(100% - \$\{sessionWidth\} - 2px\)\)`/);
    assert.match(schedule, /top: targetTop,[\s\S]{0,80}?height: targetHeight,[\s\S]{0,300}?data-time-canvas-block="session"/);
    assert.match(schedule, /style=\{\{ height, top: top - targetTop \}\}/);
    assert.match(schedule, /event\.detail === 0/);
    assert.match(schedule, /function isPointWithinTimeCanvasFootprint/);
    assert.match(schedule, /clientY >= footprint\.top[\s\S]*clientY < footprint\.bottom[\s\S]*clientX >= footprint\.left[\s\S]*clientX < footprint\.right/);
    assert.equal((schedule.match(/data-time-canvas-visible=/g) || []).length, 2);
    assert.match(schedule, /document\.elementsFromPoint\(event\.clientX, event\.clientY\)\.find/);
    assert.match(schedule, /Boolean\(canvas\?\.contains\(element\)\)/);
    assert.match(schedule, /element\.getBoundingClientRect\(\)/);
    assert.match(schedule, /if \(visibleBlock\) \{[\s\S]*if \(visibleBlock\.item\.session\) onOpenSession\(visibleBlock\.item\.session\);[\s\S]*return;[\s\S]*\}[\s\S]*onOpenSession\(session\);/);
    assert.match(schedule, /data-overlap=\{block\.overlaps/);
    assert.match(schedule, /data-schedule-scroll-owner="internal"/);
    assert.match(schedule, /role="region"/);
    assert.match(attendance, /Saved as marked\. Each row saves immediately\./);
    assert.match(attendance, /Saving \$\{pendingAttendanceStudentIds\.size\}/);
    assert.match(attendance, /rolled back/);
    assert.match(attendance, /data-attendance-commit-state/);
  });

  it("routes enlarged session targets by actual session and template footprints", () => {
    const pixelsPerHour = 72;
    const canvasWidth = (1040 - 72) / 7;
    const footprint = (block) => {
      const blockCanvasWidth = block.canvasWidth || canvasWidth;
      const laneWidth = blockCanvasWidth / block.laneCount;
      const calculatedLeft = laneWidth * block.lane + 2;
      const calculatedWidth = laneWidth - 4;
      const width = block.kind === "session" ? Math.max(44, calculatedWidth) : calculatedWidth;
      const localLeft = block.kind === "session"
        ? Math.min(calculatedLeft, blockCanvasWidth - width - 2)
        : calculatedLeft;
      const left = (block.dayOffset || 0) + localLeft;
      return {
        left,
        right: left + width,
        top: (block.startMinute / 60) * pixelsPerHour,
        bottom: (block.endMinute / 60) * pixelsPerHour,
      };
    };
    const blockAt = (blocks, x, y) => [...blocks].reverse().find((block) => {
      const rect = footprint(block);
      return y >= rect.top && y < rect.bottom && x >= rect.left && x < rect.right;
    });
    const resolvedAction = (blocks, x, y, fallbackId) => {
      const visibleBlock = blockAt(blocks, x, y);
      if (visibleBlock) return visibleBlock.kind === "session" ? visibleBlock.id : null;
      return fallbackId;
    };
    const concurrentThenSingle = [
      { id: "left", kind: "session", startMinute: 0, endMinute: 30, lane: 0, laneCount: 3 },
      { id: "middle", kind: "session", startMinute: 0, endMinute: 30, lane: 1, laneCount: 3 },
      { id: "right", kind: "session", startMinute: 0, endMinute: 30, lane: 2, laneCount: 3 },
      { id: "single", kind: "session", startMinute: 30, endMinute: 60, lane: 0, laneCount: 1 },
    ];
    const singleThenConcurrent = [
      { id: "single", kind: "session", startMinute: 0, endMinute: 30, lane: 0, laneCount: 1 },
      { id: "left", kind: "session", startMinute: 30, endMinute: 60, lane: 0, laneCount: 3 },
      { id: "middle", kind: "session", startMinute: 30, endMinute: 60, lane: 1, laneCount: 3 },
      { id: "right", kind: "session", startMinute: 30, endMinute: 60, lane: 2, laneCount: 3 },
    ];
    const threeLaneEdgeAndTailPoints = [2.5, 45.5, 94.5, 135.5];
    const singleEdgePoints = [2.5, 45.5, 94.5, 135.5];

    assert.deepEqual(threeLaneEdgeAndTailPoints.map((x) => resolvedAction(concurrentThenSingle, x, 35, "fallback")), ["left", "left", "right", "right"]);
    assert.equal(resolvedAction(concurrentThenSingle, 137.5, 35, "fallback"), "fallback");
    assert.deepEqual(singleEdgePoints.map((x) => resolvedAction(concurrentThenSingle, x, 37, "fallback")), ["single", "single", "single", "single"]);
    assert.equal(resolvedAction(concurrentThenSingle, 137.5, 37, "fallback"), "fallback");
    assert.deepEqual(singleEdgePoints.map((x) => resolvedAction(singleThenConcurrent, x, 35, "fallback")), ["single", "single", "single", "single"]);
    assert.deepEqual(threeLaneEdgeAndTailPoints.map((x) => resolvedAction(singleThenConcurrent, x, 37, "fallback")), ["left", "left", "right", "right"]);
    assert.equal(resolvedAction(singleThenConcurrent, 137.5, 37, "fallback"), "fallback");
    assert.equal(resolvedAction(singleThenConcurrent, 137.5, 35, "fallback"), "fallback");

    const templateThenSession = [
      { id: "template", kind: "template", startMinute: 0, endMinute: 15, lane: 0, laneCount: 1 },
      { id: "session", kind: "session", startMinute: 15, endMinute: 30, lane: 0, laneCount: 1 },
    ];
    const sessionThenTemplate = [
      { id: "session", kind: "session", startMinute: 0, endMinute: 15, lane: 0, laneCount: 1 },
      { id: "template", kind: "template", startMinute: 15, endMinute: 30, lane: 0, laneCount: 1 },
    ];
    assert.equal(resolvedAction(templateThenSession, 40, 17, "session"), null);
    assert.equal(resolvedAction(templateThenSession, 40, 19, "fallback"), "session");
    assert.equal(resolvedAction(sessionThenTemplate, 40, 17, "fallback"), "session");
    assert.equal(resolvedAction(sessionThenTemplate, 40, 19, "session"), null);

    const fourLaneSessions = [
      { id: "lane-0", kind: "session", startMinute: 0, endMinute: 30, lane: 0, laneCount: 4 },
      { id: "lane-1", kind: "session", startMinute: 0, endMinute: 30, lane: 1, laneCount: 4 },
      { id: "lane-2", kind: "session", startMinute: 0, endMinute: 30, lane: 2, laneCount: 4 },
      { id: "lane-3", kind: "session", startMinute: 0, endMinute: 30, lane: 3, laneCount: 4 },
    ];
    assert.deepEqual(
      [3, 40, 74, 108, 135].map((x) => resolvedAction(fourLaneSessions, x, 12, "fallback")),
      ["lane-0", "lane-1", "lane-2", "lane-3", "lane-3"]
    );

    const sessionUnderTemplate = [
      { id: "session", kind: "session", startMinute: 0, endMinute: 30, lane: 0, laneCount: 4 },
      { id: "template", kind: "template", startMinute: 0, endMinute: 30, lane: 1, laneCount: 4 },
    ];
    const templateUnderSession = [
      { id: "template", kind: "template", startMinute: 0, endMinute: 30, lane: 1, laneCount: 4 },
      { id: "session", kind: "session", startMinute: 0, endMinute: 30, lane: 0, laneCount: 4 },
    ];
    assert.equal(resolvedAction(sessionUnderTemplate, 40, 12, "fallback"), null);
    assert.equal(resolvedAction(templateUnderSession, 40, 12, "fallback"), "session");

    const firstDay = fourLaneSessions.map((block) => ({ ...block, id: `first-${block.id}`, dayOffset: 0 }));
    const secondDay = fourLaneSessions.map((block) => ({ ...block, id: `second-${block.id}`, dayOffset: canvasWidth }));
    const adjacentDays = [...firstDay, ...secondDay];
    for (const block of adjacentDays) {
      const rect = footprint(block);
      assert.ok(rect.right - rect.left >= 44);
      assert.ok(rect.left >= block.dayOffset + 2);
      assert.ok(rect.right <= block.dayOffset + canvasWidth - 2);
    }
    assert.equal(resolvedAction(adjacentDays, 92.5, 12, "fallback"), "first-lane-3");
    assert.equal(resolvedAction(adjacentDays, 135.5, 12, "fallback"), "first-lane-3");
    assert.equal(resolvedAction(adjacentDays, canvasWidth + 2.5, 12, "fallback"), "second-lane-0");
    assert.equal(resolvedAction(adjacentDays, canvasWidth + 45.5, 12, "fallback"), "second-lane-1");
    for (const x of [canvasWidth - 1, canvasWidth, canvasWidth + 1]) {
      assert.equal(resolvedAction(adjacentDays, x, 12, "fallback"), "fallback");
    }
    for (let x = 0; x < canvasWidth * 2; x += 0.5) {
      const owner = blockAt(adjacentDays, x, 12);
      if (owner) assert.equal(resolvedAction(adjacentDays, x, 12, "fallback"), owner.id);
    }

    const weekWidthForPeak = (peakLaneCount) => Math.max(1040, 72 + 7 * peakLaneCount * 48);
    assert.equal(weekWidthForPeak(1), 1040);
    assert.equal(weekWidthForPeak(2), 1040);
    assert.equal(weekWidthForPeak(6), 2088);

    const crowdedDayWidth = (weekWidthForPeak(6) - 72) / 7;
    const crowdedFirstDay = Array.from({ length: 6 }, (_, lane) => ({
      id: `crowded-first-${lane}`,
      kind: "session",
      startMinute: 0,
      endMinute: 30,
      lane,
      laneCount: 6,
      canvasWidth: crowdedDayWidth,
      dayOffset: 0,
    }));
    const crowdedSecondDay = crowdedFirstDay.map((block) => ({
      ...block,
      id: block.id.replace("first", "second"),
      dayOffset: crowdedDayWidth,
    }));
    const crowdedAdjacentDays = [...crowdedFirstDay, ...crowdedSecondDay];
    const firstDayRects = crowdedFirstDay.map(footprint);

    firstDayRects.forEach((rect, lane) => {
      assert.equal(rect.right - rect.left, 44);
      assert.ok(rect.left >= 2);
      assert.ok(rect.right <= crowdedDayWidth - 2);
      assert.equal(
        resolvedAction(crowdedAdjacentDays, (rect.left + rect.right) / 2, 12, "fallback"),
        `crowded-first-${lane}`
      );
      if (lane > 0) assert.ok(firstDayRects[lane - 1].right <= rect.left);
    });

    const lastFirstRect = firstDayRects.at(-1);
    const firstSecondRect = footprint(crowdedSecondDay[0]);
    assert.ok(lastFirstRect.right < crowdedDayWidth);
    assert.ok(firstSecondRect.left > crowdedDayWidth);
    for (const x of [crowdedDayWidth - 1, crowdedDayWidth, crowdedDayWidth + 1]) {
      assert.equal(resolvedAction(crowdedAdjacentDays, x, 12, "fallback"), "fallback");
    }
    crowdedSecondDay.forEach((block) => {
      const rect = footprint(block);
      assert.equal(
        resolvedAction(crowdedAdjacentDays, (rect.left + rect.right) / 2, 12, "fallback"),
        block.id
      );
    });
  });

  it("renders ordinary and crowded Week print geometry without horizontal clipping", async () => {
    const schedule = source("src/components/schedule/schedule-page-section.tsx");
    const printStyle = schedule.match(/<style>\{`([\s\S]*?\[data-schedule-print-week[\s\S]*?)`\}<\/style>/)?.[1];
    assert.ok(printStyle, "component-owned schedule print CSS must be extractable");
    assert.match(schedule, /data-schedule-screen-week="true"/);
    assert.match(schedule, /data-schedule-print-week="true"/);
    assert.match(schedule, /data-schedule-print-day=\{key\}/);
    assert.match(schedule, /data-schedule-print-entry=\{entry\.kind\}/);
    assert.match(schedule, /layoutScheduleTimeItems\(entriesByDate\[key\] \|\| \[\]\)\.map\(\(block\) => block\.item\)/);

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
      const inspectWeek = async ({ entriesPerDay, screenWidth }) => {
        const days = Array.from({ length: 7 }, (_, day) => {
          const entries = Array.from({ length: entriesPerDay }, (_, entry) => `
            <article data-schedule-print-entry="session">
              <span>${8 + entry}:00 AM–${8 + entry}:30 AM</span>
              <strong>Session ${day + 1}.${entry + 1} with a deliberately long recoverable title</strong>
              <span>Adult Karate Program</span>
            </article>
          `).join("");
          return `
            <section data-schedule-print-day="day-${day + 1}">
              <header data-schedule-print-day-header="true"><strong>Day ${day + 1}</strong></header>
              ${entries}
            </section>
          `;
        }).join("");

        await page.setContent(`
          <style>html, body { width: 100%; margin: 0; } ${printStyle}</style>
          <div data-schedule-screen-week="true" style="width: 100%; overflow-x: auto;">
            <div data-schedule-time-canvas="week" style="min-width: ${screenWidth}px; height: 120px;"></div>
          </div>
          <section data-schedule-print-week="true">${days}</section>
        `);

        await page.emulateMedia({ media: "screen" });
        const screenGeometry = await page.evaluate(() => {
          const owner = document.querySelector('[data-schedule-screen-week="true"]');
          const printWeek = document.querySelector('[data-schedule-print-week="true"]');
          return {
            ownerDisplay: getComputedStyle(owner).display,
            ownerClientWidth: owner.clientWidth,
            ownerScrollWidth: owner.scrollWidth,
            printDisplay: getComputedStyle(printWeek).display,
          };
        });

        await page.emulateMedia({ media: "print" });
        const printGeometry = await page.evaluate(() => {
          const owner = document.querySelector('[data-schedule-screen-week="true"]');
          const grid = document.querySelector('[data-schedule-print-week="true"]');
          const dayElements = [...grid.querySelectorAll("[data-schedule-print-day]")];
          const entryElements = [...grid.querySelectorAll("[data-schedule-print-entry]")];
          const headerElements = [...grid.querySelectorAll("[data-schedule-print-day-header]")];
          const gridRect = grid.getBoundingClientRect();
          const dayRects = dayElements.map((day) => day.getBoundingClientRect());
          const headerRects = headerElements.map((header) => header.getBoundingClientRect());
          const entriesInsideDays = dayElements.every((day) => {
            const dayRect = day.getBoundingClientRect();
            return [...day.querySelectorAll("[data-schedule-print-entry]")].every((entry) => {
              const entryRect = entry.getBoundingClientRect();
              return (
                entryRect.left >= dayRect.left &&
                entryRect.right <= dayRect.right &&
                entry.scrollWidth <= entry.clientWidth &&
                entry.scrollHeight <= entry.clientHeight &&
                entryRect.height > 0
              );
            });
          });
          return {
            ownerDisplay: getComputedStyle(owner).display,
            gridDisplay: getComputedStyle(grid).display,
            gridColumnCount: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            gridLeft: gridRect.left,
            gridRight: gridRect.right,
            viewportWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            dayCount: dayRects.length,
            entryCount: entryElements.length,
            dayTopSpread: Math.max(...dayRects.map((rect) => rect.top)) - Math.min(...dayRects.map((rect) => rect.top)),
            dayWidthSpread: Math.max(...dayRects.map((rect) => rect.width)) - Math.min(...dayRects.map((rect) => rect.width)),
            headerTopSpread: Math.max(...headerRects.map((rect) => rect.top)) - Math.min(...headerRects.map((rect) => rect.top)),
            entriesInsideDays,
          };
        });

        return { printGeometry, screenGeometry };
      };

      for (const scenario of [
        { entriesPerDay: 1, screenWidth: 1040 },
        { entriesPerDay: 7, screenWidth: 72 + 7 * 7 * 48 },
      ]) {
        const { printGeometry, screenGeometry } = await inspectWeek(scenario);
        assert.notEqual(screenGeometry.ownerDisplay, "none");
        assert.equal(screenGeometry.printDisplay, "none");
        assert.equal(screenGeometry.ownerClientWidth, 816);
        assert.equal(screenGeometry.ownerScrollWidth, scenario.screenWidth);
        assert.equal(printGeometry.ownerDisplay, "none");
        assert.equal(printGeometry.gridDisplay, "grid");
        assert.equal(printGeometry.gridColumnCount, 7);
        assert.equal(printGeometry.dayCount, 7);
        assert.equal(printGeometry.entryCount, 7 * scenario.entriesPerDay);
        assert.equal(printGeometry.dayTopSpread, 0);
        assert.ok(printGeometry.dayWidthSpread <= 1);
        assert.equal(printGeometry.headerTopSpread, 0);
        assert.ok(printGeometry.gridLeft >= 0);
        assert.ok(printGeometry.gridRight <= printGeometry.viewportWidth);
        assert.equal(printGeometry.documentScrollWidth, printGeometry.viewportWidth);
        assert.equal(printGeometry.entriesInsideDays, true);
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
    assert.match(schedule, /onChange=\{\(event\) => onProgramFilterChange\(event\.target\.value\)\}/);
    assert.match(css, /\.surface\[data-operations-page="schedule"\] > :global\(header\),[\s\S]*?\[data-schedule-program-filter\][\s\S]*?border-radius: 0 !important;[\s\S]*?background: #fff !important;[\s\S]*?color: #000 !important;[\s\S]*?box-shadow: none !important;[\s\S]*?transition: none !important;/);

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ media: "screen" });
        const ground = theme === "light" ? "rgb(246, 241, 234)" : "rgb(35, 32, 30)";
        const raised = theme === "light" ? "rgb(255, 252, 247)" : "rgb(52, 48, 45)";
        const screenText = theme === "light" ? "rgb(24, 22, 20)" : "rgb(244, 240, 236)";
        await page.setContent(
          '<style>html, body { width: 100%; margin: 0; } ' + selectTransitionCss + headerTransitionCss + browserCss + '</style>' +
          '<div data-theme="' + theme + '" data-koaryu-dashboard-shell="true" style="' +
            '--motion-fast:120ms;--motion-medium:240ms;--ease-standard:ease;' +
            '--product-ground:' + ground + ';--product-paper:' + raised + ';--product-card-stock:' + raised + ';' +
            '--product-rule-soft:rgb(140,140,140);--product-ink:' + screenText + ';--product-soft-ink:' + screenText + '">' +
            '<main class="surface" data-operations-page="schedule">' +
              '<header class="koaryu-surface-transition" style="box-sizing:border-box;background:' + ground +
                ';color:' + screenText + ';width:100%;padding:16px"><h1 style="margin:0">Schedule</h1></header>' +
              '<div style="padding:16px">' +
                '<select aria-label="Filter schedule by program" data-schedule-program-filter="selected" ' +
                  'style="box-sizing:border-box;background:' + raised + ';color:' + screenText + ';box-shadow:none">' +
                  '<option value="">All programs</option>' +
                  '<option value="program-1" selected>Adult Karate</option>' +
                '</select>' +
              '</div>' +
            '</main>' +
          '</div>'
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
              contained: filterRect.left >= 0 && filterRect.right <= document.documentElement.clientWidth,
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
              contained: headerRect.left >= 0 && headerRect.right <= document.documentElement.clientWidth,
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

  it("contains Program controls at 390px and flattens Month print in both themes", async () => {
    const programs = source("src/components/settings/programs-section.tsx");
    const month = source("src/components/schedule/month-schedule-view.tsx");
    const css = source("src/components/operations/operations-surface.module.css");
    const browserCss = css.replaceAll(":global(", ":is(");
    assert.match(programs, /data-program-form="true"/);
    assert.equal((programs.match(/data-program-input=/g) || []).length, 2);
    assert.match(programs, /data-program-color-actions="true"/);
    assert.match(programs, /data-program-swatch=\{swatch\}/);
    assert.match(programs, /data-program-submit="true"/);
    assert.match(programs, /onSubmit=\{handleSubmit\}/);
    assert.match(programs, /onClick=\{\(\) => setColor\(swatch\)\}/);
    assert.match(css, /grid-template-columns: repeat\(6, 44px\)/);
    assert.match(css, /\[data-program-submit="true"\][\s\S]*?grid-column: 1 \/ -1;[\s\S]*?width: 100%;/);
    assert.match(css, /\[data-month-schedule-view\][\s\S]*?overflow: visible !important;[\s\S]*?border-radius: 0 !important;[\s\S]*?background: #fff !important;[\s\S]*?box-shadow: none !important;/);
    assert.match(month, /data-month-schedule-day=\{day\.dateKey\}/);
    assert.match(month, /data-month-day-scope=\{day\.inCurrentMonth \? "in-month" : "out-of-month"\}/);
    assert.match(month, /data-month-day-today=\{isToday \? "true" : "false"\}/);
    assert.match(month, /data-month-day-selected=\{isSelected \? "true" : "false"\}/);
    assert.match(month, /data-month-day-selected=[\s\S]{0,500}?transition-colors/);
    assert.match(css, /\[data-month-schedule-view\] \[data-month-schedule-day\][\s\S]*?border-color: #777 !important;[\s\S]*?background: #fff !important;[\s\S]*?box-shadow: none !important;/);
    assert.match(css, /\[data-month-schedule-view\] \[data-month-schedule-day\][\s\S]*?transition: none !important;/);
    assert.match(css, /\[data-month-schedule-view\] \[data-month-schedule-day\] \*[\s\S]*?background-color: transparent !important;[\s\S]*?color: #000 !important;/);

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      for (const actionLabel of ["Create", "Save"]) {
        const swatches = ["#38BDF8", "#F59E0B", "#EF4444", "#22C55E", "#A855F7", "#94A3B8"]
          .map((swatch, index) =>
            '<button type="button" data-program-swatch="' + swatch + '" aria-label="Use ' + swatch +
            '" aria-pressed="' + (index === 0 ? "true" : "false") +
            '" onclick="this.dataset.clicked = \'true\'" style="background:' + swatch + '"></button>'
          )
          .join("");
        await page.setContent(
          '<style>html, body { width: 100%; margin: 0; } ' + browserCss + '</style>' +
          '<main class="surface" data-operations-page="settings" style="box-sizing:border-box;width:390px;padding:32px">' +
            '<form data-program-form="true" onsubmit="event.preventDefault(); this.dataset.submitted = \'true\'">' +
              '<div><label>Program name<input data-program-input="name"></label></div>' +
              '<div><label>Description<input data-program-input="description"></label></div>' +
              '<div data-program-color-field="true"><span>Color</span>' +
                '<div data-program-color-actions="true">' + swatches +
                  '<button type="submit" data-program-submit="true"><span data-program-action-label>' + actionLabel + '</span></button>' +
                '</div>' +
              '</div>' +
            '</form>' +
          '</main>'
        );
        await page.emulateMedia({ media: "screen" });
        await page.locator('[data-program-input="name"]').fill("Adult Karate");
        await page.locator('[data-program-input="description"]').fill("Evening program");
        for (const swatch of await page.locator("[data-program-swatch]").all()) await swatch.click();
        await page.locator('[data-program-submit="true"]').click();

        const geometry = await page.evaluate(() => {
          const form = document.querySelector('[data-program-form="true"]');
          const formRect = form.getBoundingClientRect();
          const inputs = [...form.querySelectorAll("[data-program-input]")];
          const swatches = [...form.querySelectorAll("[data-program-swatch]")];
          const action = form.querySelector('[data-program-submit="true"]');
          const actionLabelElement = action.querySelector("[data-program-action-label]");
          const controls = [...inputs, ...swatches, action];
          const contained = controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return (
              rect.left >= formRect.left &&
              rect.right <= formRect.right &&
              rect.top >= formRect.top &&
              rect.bottom <= formRect.bottom &&
              rect.width >= 44 &&
              rect.height >= 44
            );
          });
          const actionRect = action.getBoundingClientRect();
          const labelRect = actionLabelElement.getBoundingClientRect();
          return {
            actionLabel: actionLabelElement.textContent,
            actionLabelContained: (
              labelRect.left >= actionRect.left &&
              labelRect.right <= actionRect.right &&
              labelRect.top >= actionRect.top &&
              labelRect.bottom <= actionRect.bottom
            ),
            actionSubmitted: form.dataset.submitted,
            allSwatchesClicked: swatches.every((swatch) => swatch.dataset.clicked === "true"),
            contained,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            inputCount: inputs.length,
            swatchCount: swatches.length,
          };
        });
        assert.equal(geometry.actionLabel, actionLabel);
        assert.equal(geometry.actionLabelContained, true);
        assert.equal(geometry.actionSubmitted, "true");
        assert.equal(geometry.allSwatchesClicked, true);
        assert.equal(geometry.contained, true);
        assert.equal(geometry.inputCount, 2);
        assert.equal(geometry.swatchCount, 6);
        assert.equal(geometry.documentScrollWidth, geometry.documentClientWidth);
      }

      await page.setViewportSize({ width: 816, height: 1056 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ media: "screen" });
        const paper = theme === "light" ? "rgb(250, 250, 250)" : "rgb(30, 30, 30)";
        const ground = theme === "light" ? "rgb(238, 238, 238)" : "rgb(18, 18, 18)";
        const todaySurface = theme === "light" ? "rgb(235, 243, 255)" : "rgb(38, 46, 60)";
        const screenText = theme === "light" ? "rgb(17, 17, 17)" : "rgb(238, 238, 238)";
        const monthCells = [
          { scope: "in-month", today: "false", selected: "false", label: "In month", background: paper, shadow: "none" },
          { scope: "out-of-month", today: "false", selected: "false", label: "Out of month", background: ground, shadow: "none" },
          { scope: "in-month", today: "true", selected: "false", label: "Today", background: todaySurface, shadow: "none" },
          { scope: "in-month", today: "false", selected: "true", label: "Selected", background: paper, shadow: "inset 0 0 0 1px rgb(45, 92, 160)" },
        ].map((cell, index) =>
          '<div data-month-schedule-day="2026-08-' + (index + 1) + '" data-month-day-scope="' + cell.scope +
            '" data-month-day-today="' + cell.today + '" data-month-day-selected="' + cell.selected +
            '" style="box-sizing:border-box;min-width:0;border:1px solid rgb(120,120,120);background:' +
            cell.background + ';color:' + screenText + ';box-shadow:' + cell.shadow +
            ';overflow:hidden;padding:12px;transition-property:color,background-color,border-color;' +
            'transition-duration:150ms;transition-timing-function:ease">' +
            '<span data-month-day-copy style="display:block;overflow-wrap:anywhere">' +
              cell.label + ' calendar cell with retained printable text and borders.' +
            '</span>' +
          '</div>'
        ).join("");
        await page.setContent(
          '<style>html, body { width: 100%; margin: 0; } ' + browserCss + '</style>' +
          '<div data-theme="' + theme + '" data-koaryu-dashboard-shell="true" ' +
            'style="--product-paper:' + paper + ';--product-shadow-card:0 8px 24px rgba(0,0,0,.24);' +
            '--product-ground:' + paper + ';--product-ink:' + (theme === "light" ? "#111" : "#eee") + '">' +
            '<main class="surface" data-operations-page="schedule">' +
              '<div data-month-schedule-view="true" style="box-sizing:border-box;width:100%;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden">' +
                monthCells +
              '</div>' +
            '</main>' +
          '</div>'
        );
        const screenMaterial = await page.locator("[data-month-schedule-view]").evaluate((month) => {
          const style = getComputedStyle(month);
          return {
            background: style.backgroundColor,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            cells: [...month.querySelectorAll("[data-month-schedule-day]")].map((cell) => {
              const cellStyle = getComputedStyle(cell);
              return {
                background: cellStyle.backgroundColor,
                boxShadow: cellStyle.boxShadow,
                overflow: cellStyle.overflow,
                scope: cell.dataset.monthDayScope,
                selected: cell.dataset.monthDaySelected,
                today: cell.dataset.monthDayToday,
                transitionDuration: cellStyle.transitionDuration,
                transitionProperty: cellStyle.transitionProperty,
              };
            }),
          };
        });
        assert.equal(screenMaterial.background, paper);
        assert.equal(screenMaterial.borderRadius, "14px");
        assert.notEqual(screenMaterial.boxShadow, "none");
        assert.deepEqual(screenMaterial.cells.map((cell) => cell.scope), ["in-month", "out-of-month", "in-month", "in-month"]);
        assert.deepEqual(screenMaterial.cells.map((cell) => cell.today), ["false", "false", "true", "false"]);
        assert.deepEqual(screenMaterial.cells.map((cell) => cell.selected), ["false", "false", "false", "true"]);
        assert.notEqual(screenMaterial.cells[0].background, screenMaterial.cells[1].background);
        assert.notEqual(screenMaterial.cells[0].background, screenMaterial.cells[2].background);
        assert.equal(screenMaterial.cells[3].boxShadow === "none", false);
        assert.equal(screenMaterial.cells.every((cell) => cell.overflow === "hidden"), true);
        assert.equal(screenMaterial.cells.every((cell) => cell.transitionProperty.includes("background-color")), true);
        assert.equal(screenMaterial.cells.every((cell) => cell.transitionDuration === "0.15s"), true);

        await page.emulateMedia({ media: "print" });
        const printMaterial = await page.locator("[data-month-schedule-view]").evaluate((month) => {
          const style = getComputedStyle(month);
          const monthRect = month.getBoundingClientRect();
          const cells = [...month.querySelectorAll("[data-month-schedule-day]")].map((cell) => {
            const cellStyle = getComputedStyle(cell);
            const cellRect = cell.getBoundingClientRect();
            const copy = cell.querySelector("[data-month-day-copy]");
            const copyStyle = getComputedStyle(copy);
            const copyRect = copy.getBoundingClientRect();
            return {
              background: cellStyle.backgroundColor,
              borderColor: cellStyle.borderTopColor,
              borderStyle: cellStyle.borderTopStyle,
              borderWidth: cellStyle.borderTopWidth,
              boxShadow: cellStyle.boxShadow,
              color: cellStyle.color,
              contentContained: (
                copyRect.left >= cellRect.left &&
                copyRect.right <= cellRect.right &&
                copyRect.top >= cellRect.top &&
                copyRect.bottom <= cellRect.bottom &&
                cell.scrollWidth <= cell.clientWidth &&
                cell.scrollHeight <= cell.clientHeight
              ),
              copyColor: copyStyle.color,
              insideMonth: cellRect.left >= monthRect.left && cellRect.right <= monthRect.right,
              overflow: cellStyle.overflow,
              radius: cellStyle.borderRadius,
              scope: cell.dataset.monthDayScope,
              selected: cell.dataset.monthDaySelected,
              today: cell.dataset.monthDayToday,
              transitionDuration: cellStyle.transitionDuration,
              transitionProperty: cellStyle.transitionProperty,
            };
          });
          return {
            background: style.backgroundColor,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            color: style.color,
            cells,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            monthLeft: monthRect.left,
            monthRight: monthRect.right,
            overflow: style.overflow,
          };
        });
        assert.equal(printMaterial.background, "rgb(255, 255, 255)");
        assert.equal(printMaterial.borderRadius, "0px");
        assert.equal(printMaterial.boxShadow, "none");
        assert.equal(printMaterial.color, "rgb(0, 0, 0)");
        assert.equal(printMaterial.overflow, "visible");
        assert.equal(printMaterial.cells.length, 4);
        for (const cell of printMaterial.cells) {
          assert.equal(cell.background, "rgb(255, 255, 255)");
          assert.equal(cell.borderColor, "rgb(119, 119, 119)");
          assert.equal(cell.borderStyle, "solid");
          assert.equal(cell.borderWidth, "1px");
          assert.equal(cell.boxShadow, "none");
          assert.equal(cell.color, "rgb(0, 0, 0)");
          assert.equal(cell.copyColor, "rgb(0, 0, 0)");
          assert.equal(cell.contentContained, true);
          assert.equal(cell.insideMonth, true);
          assert.equal(cell.overflow, "visible");
          assert.equal(cell.radius, "0px");
          assert.equal(cell.transitionDuration, "0s");
          assert.equal(cell.transitionProperty, "none");
        }
        assert.ok(printMaterial.monthLeft >= 0);
        assert.ok(printMaterial.monthRight <= printMaterial.documentClientWidth);
        assert.equal(printMaterial.documentClientWidth, 816);
        assert.equal(printMaterial.documentScrollWidth, 816);
        assert.equal(printMaterial.documentScrollWidth, printMaterial.documentClientWidth);
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
    assert.match(schedule, /const weekCanvasMinWidth = Math\.max\([\s\S]*WEEK_CANVAS_MIN_WIDTH,[\s\S]*WEEK_TIME_COLUMN_WIDTH \+ WEEK_DAY_COUNT \* weekDayMinWidth/);
    assert.match(schedule, /style=\{\{ minWidth: weekCanvasMinWidth \}\}/);
    assert.equal((schedule.match(/style=\{\{ gridTemplateColumns: weekGridTemplateColumns \}\}/g) || []).length, 2);
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
    for (const label of ["Setup", "Tuition Plans", "Families", "Student Billing", "Invoices", "Advanced"]) {
      assert.match(chrome, new RegExp(`label: "${label}"`));
    }
    assert.match(chrome, /data-billing-ledger="six-views"/);
    assert.match(chrome, /data-billing-book-index="six-views"/);
    assert.doesNotMatch(chrome, /data-billing-register-context|Open book|View book/);
    assert.match(chrome, /data-billing-setup-register="true"/);
    assert.match(chrome, /<Header title="Billing">/);
    assert.doesNotMatch(chrome, /String\(index \+ 1\)\.padStart/);
    assert.match(sections, /data-billing-money-band="exceptions-first"/);
    assert.match(sections, /label: "Needs attention"[\s\S]*label: "Open receivables"[\s\S]*label: "Collected this UTC month"/);
    assert.match(sections, /Reset Stripe connection\?/);
    assert.match(sections, /onConnectReset/);
    assert.match(controller, /!isPreviewMode[\s\S]*canManageKoaryuSubscription[\s\S]*hasStripeConnectedAccount[\s\S]*connectOnboardingEnabled/);
    assert.match(negativeCopy, /Creating or syncing plans is currently unavailable/);
    assert.match(negativeCopy, /Creating or syncing payers and changing autopay are currently unavailable/);
    assert.match(negativeCopy, /Creating, finalizing, retrying, or voiding provider invoices is currently unavailable/);
    assert.match(negativeCopy, /New CSV exports are currently unavailable/);
  });

  it("keeps Automations a read-only catalog with exact live destinations and proposals", () => {
    const automations = source("src/app/(dashboard)/automations/page.tsx");
    const css = source("src/components/operations/operations-surface.module.css");
    const automationCss = css.slice(css.indexOf("/* Automations"), css.indexOf("/* Reports"));
    const futureSection = automations.slice(
      automations.indexOf('<section aria-labelledby="future-workflows-title"'),
      automations.indexOf("</section>", automations.indexOf('<section aria-labelledby="future-workflows-title"')) + "</section>".length,
    );

    assert.match(
      automations,
      /title: "Lead follow-ups", description: "Call, trial, and next-step obligations already live in Leads\.", href: "\/leads"[\s\S]*title: "Students going quiet", description: "Dashboard surfaces students crossing inactivity thresholds\.", href: "\/dashboard"[\s\S]*title: "Ready to promote", description: "Belt Tracker applies the current rank and approval requirements\.", href: "\/belt-tracker"[\s\S]*title: "Tuition needs attention", description: "Billing holds failed payments, past-due families, and open invoices\.", href: "\/billing"/,
    );
    assert.equal((automations.match(/href: "\/(?:leads|dashboard|belt-tracker|billing)"/g) || []).length, 4);
    assert.match(
      automations,
      /\["Trial reminders", "Reminder before a trial class and a follow-up afterward\."\][\s\S]*\["Missed-class nudges", "Family email after a configurable attendance gap\."\][\s\S]*\["Payment recovery", "Failed-payment notice that stops after provider recovery\."\][\s\S]*\["Promotion congratulations", "Studio-approved note after a promotion is recorded\."\][\s\S]*\["Belt test announcements", "Notice to eligible students and families before a testing cycle\."\]/,
    );
    assert.equal((automations.match(/^  \["(?:Trial reminders|Missed-class nudges|Payment recovery|Promotion congratulations|Belt test announcements)"/gm) || []).length, 5);
    assert.doesNotMatch(automations, /<form|<input|<select|<textarea|onChange=|type="checkbox"|role="switch"|\bfetch\s*\(|\bapi\.|\baxios\b|process\.env|isPreviewMode|useEffect|useState/);
    assert.match(automations, /data-automations-readonly="true"/);
    assert.match(automations, /data-automation-catalog="live-queues-and-proposals"/);
    assert.match(automations, /<Header title="Automations">/);
    assert.doesNotMatch(automations, /<h1/);
    assert.match(automations, /Open today&apos;s work/);
    assert.match(automations, /No automation builder is live\./);
    assert.match(automations, /There are no message toggles, schedules, forms, or hidden sends on this page\./);
    assert.match(automations, /<h2 id="live-queues-title"[^>]*>Four live queue destinations<\/h2>/);
    assert.match(automations, /<h2 id="future-workflows-title"[^>]*>Five proposed workflows<\/h2>/);
    assert.match(automations, /<ol[^>]*data-automation-live-list="four-destinations"[\s\S]*LIVE_QUEUES\.map[\s\S]*<Link[\s\S]*prefetch=\{crmLinkPrefetch\(queue\.href\)\}[\s\S]*data-automation-live-target="true"/);
    assert.match(automations, /className="grid min-h-20 min-w-0 grid-cols-\[minmax\(0,1fr\)_auto\][^"]*"/);
    assert.match(automations, /overflow-x-hidden[\s\S]*sm:grid-cols-\[minmax\(12rem,0\.36fr\)_minmax\(0,1fr\)\][\s\S]*break-words/);
    assert.match(automations, /<dl[^>]*data-automation-future-list="five-proposals"[\s\S]*FUTURE_WORKFLOWS\.map/);
    assert.doesNotMatch(futureSection, /<Link|<Button|<button|<form|<input|<select|<textarea|onClick=|onChange=/);
    assert.doesNotMatch(automations, /data-automation-worksheet|>Trigger<|>Action<|>Status</);
    assert.match(automationCss, /\.surface\[data-operations-page="automations"\][\s\S]*data-automation-catalog="live-queues-and-proposals"[\s\S]*border-radius: 14px;[\s\S]*background: var\(--product-paper\);[\s\S]*box-shadow: var\(--product-shadow-card\);/);
    assert.match(automationCss, /data-automation-inset="true"[\s\S]*border: 1px solid var\(--product-rule\);[\s\S]*border-radius: 10px;[\s\S]*background: var\(--product-card-stock\);/);
    assert.match(automationCss, /data-automation-live-target="true"[^\n]*:focus-visible[\s\S]*outline-color: var\(--product-focus\) !important;/);
    assert.doesNotMatch(automationCss, /#[0-9a-f]{3,8}|gradient|--operations-cobalt/);
  });

  it("keeps settings indexed behind the Admin boundary", () => {
    const settings = source("src/app/(dashboard)/settings/page.tsx");
    const programs = source("src/components/settings/programs-section.tsx");
    const staff = source("src/components/settings/staff-roles-section.tsx");
    const operationsStyles = source("src/components/operations/operations-surface.module.css");
    assert.match(settings, /canAccessSettings\(currentRole\) \? <AdminSettingsContent \/> : <SettingsAccessNotice \/>/);
    assert.match(settings, /<Header title="Settings" \/>/);
    assert.doesNotMatch(settings, /Studio configuration and preferences/);
    assert.match(settings, /data-settings-folio="admin-ownership"/);
    assert.equal((settings.match(/data-settings-owner=/g) || []).length, 5);
    for (const id of ["studio", "programs", "staff-roles", "data-controls"]) {
      assert.match(settings, new RegExp(`(?:href="#${id}"|id="${id}")`));
    }
    for (const marker of ["createProgram", "updateProgram", "archiveProgram", "restoreProgram", "is_system", "usage"]) {
      assert.match(programs, new RegExp(marker));
    }
    assert.match(programs, /COLOR_SWATCHES\.map[\s\S]*className=\{`relative flex h-11 w-11 shrink-0/);
    assert.doesNotMatch(programs, /className=\{`relative flex h-8 w-8/);
    assert.match(programs, /break-words md:truncate" title=\{program\.description\}/);
    assert.match(programs, /break-words md:truncate" title=\{usageLabel\(program\)\}/);
    for (const marker of ["inviteEmail", "inviteFullName", "inviteLegalFirstName", "inviteLegalLastName", 'useState<StaffRoleName>("instructor")', "matchesStaffDeletionConfirmation", "archiveStaff", "unarchiveStaff", "scheduleStaffDeletion", "showArchived"]) {
      assert.match(staff, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(staff, /<label className="flex min-h-11 items-center[\s\S]*aria-label="Show archived staff"/);
    assert.match(operationsStyles, /data-operations-page="settings"[\s\S]*data-settings-owner[\s\S]*overflow: hidden;[\s\S]*border-radius: 14px/);
  });

  it("renders Reports as an exact-heading analytical document with cobalt reserved for its data series", () => {
    const reports = source("src/app/(dashboard)/reports/page.tsx");
    const reportsLoading = source("src/app/(dashboard)/reports/loading.tsx");
    const sections = source("src/components/reports/reports-page-sections.tsx");
    assert.match(reports, /<Header title="Reports" \/>/);
    assert.doesNotMatch(reports, /Studio performance, operating comparisons|Loading studio reporting panels/);
    assert.doesNotMatch(reportsLoading, /Loading studio reporting panels/);
    assert.match(reports, /data-reports-reading-document="true"/);
    assert.match(reports, /data-report-figure-band="comparisons"/);
    assert.match(reports, /bg-\[var\(--operations-cobalt\)\]/);
    assert.match(sections, /<figure[\s\S]*data-report-figure="headline"/);
    assert.match(sections, /data-report-section="reading-block"/);
    const exports = source("src/components/reports/reports-data-exports-panel.tsx");
    assert.match(exports, /break-words[^"\n]*sm:truncate" title=\{report\.title\}/);
  });

  it("keeps all five Operations route Headers description-free", () => {
    const routeHeaders = [
      ["Schedule", source("src/components/schedule/schedule-page-section.tsx")],
      ["Billing", source("src/components/billing/billing-page-chrome.tsx")],
      ["Automations", source("src/app/(dashboard)/automations/page.tsx")],
      ["Reports", source("src/app/(dashboard)/reports/page.tsx")],
      ["Settings", source("src/app/(dashboard)/settings/page.tsx")],
    ];

    for (const [title, routeSource] of routeHeaders) {
      assert.match(routeSource, new RegExp(`<Header title="${title}"(?:>| \\/>)`));
      assert.doesNotMatch(routeSource, new RegExp(`<Header[^>]*title="${title}"[^>]*description=`));
    }
  });

  it("adds the typed deletion gate and complete support context/inbox states without new APIs", () => {
    const account = source("src/app/(dashboard)/account/settings/page.tsx");
    const contact = source("src/app/(dashboard)/help/contact/page.tsx");
    assert.match(account, /Type DELETE to continue/);
    assert.match(account, /deletionConfirmation !== "DELETE"/);
    assert.match(account, /interface confirmation[\s\S]*API does not require this phrase/);
    assert.match(account, /Checking account deletion status/);
    assert.match(account, /const isPreviewMode = process\.env\.NEXT_PUBLIC_PREVIEW_MODE === "true"/);
    assert.match(account, /useState\(!isPreviewMode\)/);
    assert.match(account, /if \(!isAdmin \|\| staffLoaded\) return;/);
    assert.match(account, /\[isAdmin, refreshStaff, staffLoaded\]/);
    for (const label of ["Current page", "Expected result", "Actual result"]) assert.match(contact, new RegExp(label));
    assert.match(contact, /page_url: currentPage\.trim\(\) \|\| null/);
    assert.match(contact, /expected_result: expectedResult\.trim\(\)/);
    assert.match(contact, /actual_result: actualResult\.trim\(\)/);
    assert.match(contact, /Subject must be between 3 and 160 characters/);
    assert.match(contact, /Details must be between 10 and 5,000 characters/);
    assert.match(contact, /initialTopic[\s\S]*return "billing"/);
    assert.match(contact, /useState<SupportTicketSeverity>\("normal"\)/);
    for (const state of ["loading", "ready", "error"]) assert.match(contact, new RegExp(`"${state}"`));
    assert.match(contact, /Retry recent requests/);
  });

  it("preserves transition effect owners and fail-closed copy", () => {
    const onboarding = source("src/app/onboarding/page.tsx");
    const archived = source("src/app/account-archived/page.tsx");
    const denied = source("src/app/access-denied/page.tsx");
    const refresh = source("src/app/billing/connect/refresh/page.tsx");
    const legal = source("src/components/account/legal-name-blocking-screen.tsx");
    assert.equal((onboarding.match(/^  "(?:America|Pacific|Europe|Asia|Australia)\//gm) || []).length, 17);
    assert.match(onboarding, /useState\("America\/New_York"\)/);
    assert.match(onboarding, /studioName\.trim\(\)/);
    assert.match(onboarding, /"Idempotency-Key"/);
    assert.doesNotMatch(archived, /useStudioStore|\/studios|\/bootstrap/);
    assert.match(archived, /No studio data is loaded on this page/);
    assert.doesNotMatch(denied, /useStudioStore|\bapi\./);
    assert.match(denied, /No protected billing information was loaded/);
    assert.match(refresh, /acknowledgeConnectOnboardingBeforeNavigation/);
    assert.match(legal, /updateUserLegalName/);
    assert.match(legal, /Save legal name/);
    assert.match(legal, /Sign out/);
  });
});
