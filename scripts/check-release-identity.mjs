import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function validateReleaseIdentity({
  releaseSource,
  changelog,
  frontendPackage,
  frontendLock,
}) {
  const errors = [];
  let productVersion = null;

  if (
    releaseSource
    && typeof releaseSource === "object"
    && typeof releaseSource.product_version === "string"
    && SEMANTIC_VERSION_PATTERN.test(releaseSource.product_version)
  ) {
    productVersion = releaseSource.product_version;
  } else {
    errors.push("backend/release.json must define one semantic product_version.");
  }

  const currentRelease = changelog.match(
    /^##\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s+-\s+(?!Unreleased\b).+$/im,
  )?.[1] ?? null;
  if (!currentRelease) {
    errors.push("frontend/CHANGELOG.md must begin its release history with a dated semantic version.");
  } else if (productVersion && currentRelease !== productVersion) {
    errors.push(
      `frontend/CHANGELOG.md starts at ${currentRelease}, but backend/release.json declares ${productVersion}.`,
    );
  }

  if (!frontendPackage.private) {
    errors.push("frontend/package.json must remain private.");
  }
  if (Object.hasOwn(frontendPackage, "version")) {
    errors.push("frontend/package.json must not duplicate the product release as a package version.");
  }

  const lockedFrontend = frontendLock.packages?.[""];
  if (!lockedFrontend || lockedFrontend.name !== frontendPackage.name) {
    errors.push("frontend/package-lock.json must retain the frontend root package.");
  } else if (Object.hasOwn(frontendLock, "version") || Object.hasOwn(lockedFrontend, "version")) {
    errors.push("frontend/package-lock.json must not restore a duplicate root package version.");
  }

  return errors;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = validateReleaseIdentity({
    releaseSource: readJson(path.join(repoRoot, "backend", "release.json")),
    changelog: fs.readFileSync(path.join(repoRoot, "frontend", "CHANGELOG.md"), "utf8"),
    frontendPackage: readJson(path.join(repoRoot, "frontend", "package.json")),
    frontendLock: readJson(path.join(repoRoot, "frontend", "package-lock.json")),
  });

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Product release identity is consistent.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
