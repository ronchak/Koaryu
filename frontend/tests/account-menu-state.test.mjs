import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCOUNT_MENU_WIDTH,
  ACCOUNT_SUBMENU_WIDTH,
  ACCOUNT_MENU_GAP,
  calculateAccountMenuPanelWidth,
  calculateAccountMenuPosition,
} from "../src/lib/account-menu-position.ts";

describe("account menu state extraction", () => {
  it("keeps viewport positioning in a pure helper", () => {
    assert.equal(
      calculateAccountMenuPanelWidth({
        compactLayout: false,
        hasSubmenu: true,
      }),
      ACCOUNT_MENU_WIDTH + ACCOUNT_SUBMENU_WIDTH + ACCOUNT_MENU_GAP
    );

    assert.deepEqual(
      calculateAccountMenuPosition({
        triggerRect: { left: 760, top: 100, bottom: 140 },
        viewportWidth: 900,
        viewportHeight: 700,
        hasSubmenu: true,
      }),
      {
        left: 352,
        compactLayout: false,
        top: 148,
        maxHeight: 544,
      }
    );

    assert.deepEqual(
      calculateAccountMenuPosition({
        triggerRect: { left: 20, top: 500, bottom: 540 },
        viewportWidth: 500,
        viewportHeight: 700,
        hasSubmenu: true,
      }),
      {
        left: 20,
        compactLayout: true,
        bottom: 208,
        maxHeight: 484,
      }
    );
  });
});
