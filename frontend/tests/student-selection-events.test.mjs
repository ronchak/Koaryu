import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stopStudentSelectionPropagation } from "../src/lib/student-selection-events.ts";

describe("stopStudentSelectionPropagation", () => {
  it("stops checkbox clicks from bubbling into the selectable table cell", () => {
    let stopCount = 0;

    stopStudentSelectionPropagation({
      stopPropagation: () => {
        stopCount += 1;
      },
    });

    assert.equal(stopCount, 1);
  });
});
