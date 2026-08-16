import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearActiveStudioIdCookie,
  parseStudioStateCookie,
  setActiveStudioIdCookie,
  setStudioStateCookie,
  serializeStudioStateCookie,
} from "../src/lib/studio-state-cookie.ts";

describe("studio state cookie membership status", () => {
  it("infers active and none from legacy two-part values", () => {
    assert.deepEqual(parseStudioStateCookie("user-1|1"), {
      userId: "user-1",
      hasStudio: true,
      membershipStatus: "active",
    });
    assert.deepEqual(parseStudioStateCookie("user-1|0"), {
      userId: "user-1",
      hasStudio: false,
      membershipStatus: "none",
    });
  });

  it("serializes and parses an explicit archived membership", () => {
    const serialized = serializeStudioStateCookie("user-1", false, "archived");
    assert.equal(serialized, "user-1|0|archived");
    assert.deepEqual(parseStudioStateCookie(serialized), {
      userId: "user-1",
      hasStudio: false,
      membershipStatus: "archived",
    });
    assert.equal(parseStudioStateCookie("user-1|0|unknown"), null);
    assert.equal(parseStudioStateCookie("user-1|0|none|extra"), null);
  });

  it("writes explicit status and clears an active studio when membership is archived", () => {
    const jar = new Map();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { protocol: "https:" } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.document, "cookie", {
      configurable: true,
      get() {
        return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
      },
      set(value) {
        const [pair] = value.split(";", 1);
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const rawValue = pair.slice(separator + 1);
        if (value.includes("Max-Age=0")) {
          jar.delete(name);
        } else {
          jar.set(name, rawValue);
        }
      },
    });

    try {
      setActiveStudioIdCookie("studio-1");
      setStudioStateCookie("user-1", false, "archived");
      clearActiveStudioIdCookie();
      assert.equal(jar.get("koaryu-active-studio"), undefined);
      assert.deepEqual(parseStudioStateCookie(decodeURIComponent(jar.get("koaryu-studio-state"))), {
        userId: "user-1",
        hasStudio: false,
        membershipStatus: "archived",
      });
    } finally {
      delete globalThis.document;
      delete globalThis.window;
    }
  });
});
