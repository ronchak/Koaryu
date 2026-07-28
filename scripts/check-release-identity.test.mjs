import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateReleaseIdentity } from "./check-release-identity.mjs";

const releaseSource = JSON.parse(
  fs.readFileSync(new URL("../backend/release.json", import.meta.url), "utf8"),
);
const changelog = fs.readFileSync(
  new URL("../frontend/CHANGELOG.md", import.meta.url),
  "utf8",
);
const frontendPackage = JSON.parse(
  fs.readFileSync(new URL("../frontend/package.json", import.meta.url), "utf8"),
);
const frontendLock = JSON.parse(
  fs.readFileSync(new URL("../frontend/package-lock.json", import.meta.url), "utf8"),
);

const validInputs = {
  releaseSource,
  changelog,
  frontendPackage: { ...frontendPackage, version: undefined },
  frontendLock: {
    ...frontendLock,
    version: undefined,
    packages: {
      ...frontendLock.packages,
      "": { ...frontendLock.packages[""], version: undefined },
    },
  },
};
delete validInputs.frontendPackage.version;
delete validInputs.frontendLock.version;
delete validInputs.frontendLock.packages[""].version;

test("release identity accepts the repository contract", () => {
  assert.deepEqual(validateReleaseIdentity(validInputs), []);
});

test("release identity rejects changelog drift", () => {
  const drifted = changelog.replace(
    `## ${releaseSource.product_version} -`,
    "## 9.9.9 -",
  );

  assert.match(
    validateReleaseIdentity({ ...validInputs, changelog: drifted }).join("\n"),
    /CHANGELOG\.md starts at 9\.9\.9/,
  );
});

test("release identity rejects a duplicate private package version", () => {
  const versionedPackage = { ...validInputs.frontendPackage, version: "0.1.0" };

  assert.match(
    validateReleaseIdentity({
      ...validInputs,
      frontendPackage: versionedPackage,
    }).join("\n"),
    /must not duplicate the product release/,
  );
});
