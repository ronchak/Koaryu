#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  classifyDocument,
  readSecretSafeJson,
} from "./classify-production-data.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function verifyManifest(input, manifest) {
  const expected = classifyDocument(input);
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("manifest does not exactly match deterministic classifier output");
  }
  if (!manifest.summary?.all_partition_checks_passed) {
    throw new Error("manifest partition checks did not pass");
  }
  return {
    manifest_digest: manifest.manifest_digest,
    total_manifest_count: manifest.summary.total_manifest_count,
    unknown_count: manifest.summary.classification_counts.unknown,
  };
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error(
      "usage: node scripts/verify-production-data-classification.mjs "
      + "<secret-safe-input.json> <manifest.json>",
    );
  }
  const input = readSecretSafeJson(resolve(argv[0]));
  const manifest = readSecretSafeJson(resolve(argv[1]), "classification manifest");
  const result = verifyManifest(input, manifest);
  process.stdout.write(
    "production data classification manifest verified: "
    + `${result.manifest_digest}; records=${result.total_manifest_count}; `
    + `unknown=${result.unknown_count}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "verification failed";
    process.stderr.write(`production data classification verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
