import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicFooterLinks, publicNavLinks } from "../src/lib/public-navigation.ts";

describe("public document navigation", () => {
  it("offers distinct product, workflow, and pricing destinations", () => {
    assert.deepEqual(publicNavLinks, [
      { href: "/features", label: "Features" },
      { href: "/use-cases", label: "Workflows" },
      { href: "/#pricing", label: "Pricing" },
    ]);
    assert.equal(new Set(publicNavLinks.map(({ href }) => href)).size, publicNavLinks.length);
  });

  it("provides product recovery, real support contact, and legal destinations in the footer", () => {
    assert.deepEqual(
      publicFooterLinks.map(({ href }) => href),
      ["/features", "/use-cases", "mailto:support@koaryu.app", "/terms", "/privacy"],
    );
    assert.equal(new Set(publicFooterLinks.map(({ href }) => href)).size, publicFooterLinks.length);
    for (const { href, label } of [...publicFooterLinks, ...publicNavLinks]) {
      assert.ok(label.trim());
      assert.ok(
        !["/explore", "/about", "/studio-types/family-martial-arts-schools"].includes(href),
      );
    }
  });
});
