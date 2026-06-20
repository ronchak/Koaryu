import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTH_NOINDEX_METADATA,
  PRIVATE_ROUTE_DISALLOW_PATHS,
  buildRobotsMetadata,
} from "../src/lib/auth-indexing.ts";

describe("auth noindex coverage", () => {
  it("sets noindex metadata for shared auth pages", () => {
    assert.deepEqual(AUTH_NOINDEX_METADATA.robots, {
      index: false,
      follow: false,
    });
  });

  it("disallows auth pages in the generated robots metadata", () => {
    const robots = buildRobotsMetadata();
    const disallow = robots.rules && !Array.isArray(robots.rules) ? robots.rules.disallow : [];

    assert.deepEqual(disallow, [...PRIVATE_ROUTE_DISALLOW_PATHS]);
    assert.ok(disallow.includes("/login"));
    assert.ok(disallow.includes("/signup"));
    assert.ok(disallow.includes("/reset-password"));
  });
});
