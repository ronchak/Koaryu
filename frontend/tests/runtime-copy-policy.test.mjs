import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const runtimeRoots = [
  resolve(testDirectory, "../src"),
  resolve(testDirectory, "../../backend/app"),
];
const runtimeExtensions = new Set([".js", ".jsx", ".py", ".ts", ".tsx"]);
const forbiddenPatterns = [
  /friendly[_\s-]+pilot/i,
  /pilot[_\s-]+core/i,
  /outside this release/i,
  /requires separate approval/i,
];

function runtimeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return runtimeFiles(path);
    return runtimeExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

describe("runtime copy policy", () => {
  it("keeps pilot-era release language out of frontend and backend runtime code", () => {
    const violations = runtimeRoots.flatMap((root) =>
      runtimeFiles(root).flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return forbiddenPatterns
          .filter((pattern) => pattern.test(source))
          .map((pattern) => `${path}: ${pattern}`);
      })
    );

    assert.deepEqual(violations, []);
  });
});
