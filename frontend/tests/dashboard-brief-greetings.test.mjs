import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDashboardOwnerFirstName } from "../src/lib/dashboard-brief-greetings.ts";

describe("profile first name", () => {
  it("extracts a display-safe first name", () => {
    assert.equal(resolveDashboardOwnerFirstName("Ronak Chakraborty"), "Ronak");
    assert.equal(resolveDashboardOwnerFirstName("  ronak  "), "ronak");
    assert.equal(resolveDashboardOwnerFirstName("Mary-Kate Olsen"), "Mary-Kate");
    assert.equal(resolveDashboardOwnerFirstName("O'Brien"), "O'Brien");
    assert.equal(resolveDashboardOwnerFirstName("宮本 武蔵"), "宮本");
    assert.equal(resolveDashboardOwnerFirstName(""), null);
    assert.equal(resolveDashboardOwnerFirstName(null), null);
    assert.equal(resolveDashboardOwnerFirstName("ronak@example.com"), null);
    assert.equal(resolveDashboardOwnerFirstName("!!!"), null);
  });
});
