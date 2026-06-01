import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getMobileNavPanelState } from "../src/lib/mobile-nav-state.ts";

describe("getMobileNavPanelState", () => {
  it("marks the closed drawer as hidden and inert", () => {
    const state = getMobileNavPanelState(false);

    assert.equal(state.state, "closed");
    assert.equal(state.ariaHidden, true);
    assert.equal(state.inert, true);
    assert.match(state.className, /translate-x-full/);
    assert.match(state.className, /pointer-events-none/);
  });

  it("removes hidden and inert state when the drawer is open", () => {
    const state = getMobileNavPanelState(true);

    assert.equal(state.state, "open");
    assert.equal(state.ariaHidden, false);
    assert.equal(state.inert, false);
    assert.match(state.className, /translate-x-0/);
    assert.doesNotMatch(state.className, /pointer-events-none/);
  });
});
