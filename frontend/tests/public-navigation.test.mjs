import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicFooterLinks, publicNavLinks } from "../src/lib/public-navigation.ts";

describe("public navigation", () => {
  it("keeps primary public routes in one exported list", () => {
    assert.deepEqual(publicNavLinks.map((link) => link.href), [
      "/features",
      "/use-cases",
      "/explore",
      "/#pricing",
      "/about",
    ]);
  });

  it("keeps footer public routes in one exported list", () => {
    assert.deepEqual(publicFooterLinks.map((link) => link.href), [
      "/explore",
      "/features",
      "/use-cases",
      "/about",
      "/terms",
      "/privacy",
    ]);
  });
});
