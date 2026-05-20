import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseChangelog } from "../src/lib/changelog.ts";

describe("parseChangelog", () => {
  it("renders dated releases and hides unreleased sections", () => {
    const releases = parseChangelog(`
# Changelog

## 0.1.1 - Unreleased

- Draft change that should not be public yet.

## 0.1.0 - 2026-05-19

### Added

- First live release.
`);

    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, "0.1.0");
    assert.equal(releases[0].date, "2026-05-19");
    assert.deepEqual(releases[0].sections, [
      { title: "Added", items: ["First live release."] },
    ]);
  });

  it("keeps uncategorized bullets under a changed section", () => {
    const releases = parseChangelog(`
## 0.1.0 - 2026-05-19

- Launch item.
`);

    assert.deepEqual(releases[0].sections, [
      { title: "Changed", items: ["Launch item."] },
    ]);
  });
});
