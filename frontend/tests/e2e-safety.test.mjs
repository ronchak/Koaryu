import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const coreUiPolishSpecPath = new URL("../e2e/core-ui-polish.spec.ts", import.meta.url);

describe("stateful Playwright e2e safety", () => {
  it("restricts the preview-stateful Core UI check to loopback", async () => {
    const spec = await readFile(coreUiPolishSpecPath, "utf8");

    assert.match(spec, /KOARYU_CORE_UI_E2E/);
    assert.match(spec, /\["localhost", "127\.0\.0\.1"\]/);
    assert.match(spec, /may run only against loopback/);
  });
});
