import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { differenceInLocalDateKeys } from "../src/lib/date.ts";

describe("toLocalDateKey", () => {
  it("uses local date fields instead of UTC ISO date fields in a behind-UTC timezone", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        [
          'import { toLocalDateKey } from "./src/lib/date.ts";',
          "const date = new Date(2026, 4, 23, 20, 30, 0);",
          "console.log(toLocalDateKey(date));",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TZ: "America/Los_Angeles" },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "2026-05-23");
  });
});

describe("differenceInLocalDateKeys", () => {
  it("counts calendar days across daylight-saving transitions", () => {
    assert.equal(differenceInLocalDateKeys("2026-03-08", "2026-03-09"), 1);
  });

  it("does not return negative inactivity days", () => {
    assert.equal(differenceInLocalDateKeys("2026-03-09", "2026-03-08"), 0);
  });
});
