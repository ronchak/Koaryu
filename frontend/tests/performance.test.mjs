import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startPerformanceSpan, startStudentPagePerformanceSpan } from "../src/lib/performance.ts";

const originalWindow = globalThis.window;
const originalConsoleInfo = console.info;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
  console.info = originalConsoleInfo;
});

describe("performance spans", () => {
  it("uses unique mark names for overlapping operations with the same span name", () => {
    const marks = [];
    const measures = [];
    console.info = () => {};
    globalThis.window = {
      localStorage: {
        getItem() {
          return null;
        },
      },
      performance: {
        mark(name) {
          marks.push(name);
        },
        measure(name, start, end) {
          measures.push({ name, start, end });
        },
        getEntriesByName(name) {
          return measures
            .filter((measure) => measure.name === name)
            .map((_, index) => ({ duration: index + 1 }));
        },
      },
    };

    const first = startPerformanceSpan("students.page");
    const second = startPerformanceSpan("students.page");

    first.finish({ page: 1 });
    second.finish({ page: 2 });

    assert.equal(measures.length, 2);
    assert.equal(measures[0].name, "koaryu.students.page.duration");
    assert.equal(measures[1].name, "koaryu.students.page.duration");
    assert.notEqual(measures[0].start, measures[1].start);
    assert.notEqual(measures[0].end, measures[1].end);
    assert.match(measures[0].start, /^koaryu\.students\.page\.[a-z0-9]+\.started$/);
    assert.match(measures[1].end, /^koaryu\.students\.page\.[a-z0-9]+\.finished$/);
    assert.deepEqual(marks, [
      measures[0].start,
      measures[1].start,
      measures[0].end,
      measures[1].end,
    ]);
  });

  it("builds student page fetch instrumentation as request-scoped spans", () => {
    const measures = [];
    console.info = () => {};
    globalThis.window = {
      localStorage: {
        getItem() {
          return null;
        },
      },
      performance: {
        mark() {},
        measure(name, start, end) {
          measures.push({ name, start, end });
        },
        getEntriesByName(name) {
          return measures
            .filter((measure) => measure.name === name)
            .map((_, index) => ({ duration: index + 1 }));
        },
      },
    };

    const first = startStudentPagePerformanceSpan({ page: 2, pageSize: 25 });
    const second = startStudentPagePerformanceSpan({ page: 3, pageSize: 25 });

    first.finish({ total: 50 });
    second.finish({ error: true });

    assert.equal(measures.length, 2);
    assert.equal(measures[0].name, "koaryu.students.page.duration");
    assert.equal(measures[1].name, "koaryu.students.page.duration");
    assert.notEqual(measures[0].start, measures[1].start);
    assert.notEqual(measures[0].end, measures[1].end);
    assert.match(measures[0].start, /^koaryu\.students\.page\.[a-z0-9]+\.started$/);
    assert.match(measures[1].end, /^koaryu\.students\.page\.[a-z0-9]+\.finished$/);
  });
});
