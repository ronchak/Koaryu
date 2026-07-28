#!/usr/bin/env node

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn } from "node:child_process";

const MANIFEST_NAME = "generation-manifest.json";
const SCHEMA_VERSION = 1;
const REQUIRED_PLAINTEXT_ARTIFACTS = [
  "data.sql",
  "record-classification-manifest.json",
  "roles.sql",
  "schema.sql",
  "storage-objects.tar",
];
const REQUIRED_ENCRYPTED_ARTIFACTS = REQUIRED_PLAINTEXT_ARTIFACTS.map(
  (name) => `${name}.gpg`,
);
const GPG_BIN = process.env.KOARYU_GPG_BIN || "gpg";

class UsageError extends Error {}

function usage() {
  return `Koaryu encrypted backup recovery helper

Usage:
  node scripts/backup-recovery.mjs doctor
  node scripts/backup-recovery.mjs create --source-dir DIR --generations-dir DIR --generation-id ID
  node scripts/backup-recovery.mjs verify --generation-dir DIR [--expected-manifest-sha256 HEX]
  node scripts/backup-recovery.mjs retrieve --source-generation-dir DIR --destination-root DIR [--expected-manifest-sha256 HEX]
  node scripts/backup-recovery.mjs restore --generation-dir DIR --restore-dir DIR [--expected-manifest-sha256 HEX]
  node scripts/backup-recovery.mjs rotate --generations-dir DIR --retain COUNT [--apply]

create and restore read one passphrase from standard input. They refuse an
interactive terminal so the passphrase can come from a private secret store
without appearing in arguments, environment variables, logs, or repository
files.
`;
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (name === "apply") {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`Missing value for --${name}`);
    }
    if (options.has(name)) {
      throw new UsageError(`Duplicate option: --${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`Missing required option: --${name}`);
  }
  return value;
}

function rejectUnknownOptions(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new UsageError(`Unknown option: --${name}`);
    }
  }
}

function assertGenerationId(value) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}[A-Za-z0-9]$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new UsageError(
      "Generation IDs must be 2-128 safe filename characters",
    );
  }
}

function assertSha256(value, optionName = "expected manifest SHA-256") {
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) {
    throw new UsageError(`${optionName} must be 64 lowercase hex characters`);
  }
}

function pathIsWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function assertPrivateDirectory(path, label, { create = false } = {}) {
  if (create) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions`);
  }
}

async function assertPrivateFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must have mode 0600 or stricter`);
  }
  return details;
}

async function fileSha256(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", rejectPromise);
    stream.on("end", () => {
      resolvePromise(hash.digest("hex"));
    });
  });
}

async function readPassphrase() {
  if (process.stdin.isTTY) {
    throw new UsageError(
      "Refusing to read a backup passphrase from an interactive terminal",
    );
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks);
  const passphrase = input.toString("utf8").replace(/\r?\n$/, "");
  input.fill(0);
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  if (!passphrase) {
    throw new UsageError("The backup passphrase on standard input was empty");
  }
  if (/[\r\n]/.test(passphrase)) {
    throw new UsageError("The backup passphrase must be a single line");
  }
  return passphrase;
}

async function runGpg(args, passphrase) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(GPG_BIN, args, {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) {
        stderr += chunk;
      }
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `GnuPG failed closed (exit ${code}): ${stderr.trim() || "no diagnostic"}`,
          ),
        );
      }
    });
    child.stdio[3].end(`${passphrase}\n`);
  });
}

async function encryptFile(source, destination, passphrase) {
  await runGpg(
    [
      "--batch",
      "--yes",
      "--symmetric",
      "--force-ocb",
      "--cipher-algo",
      "AES256",
      "--pinentry-mode",
      "loopback",
      "--passphrase-fd",
      "3",
      "--output",
      destination,
      source,
    ],
    passphrase,
  );
  await chmod(destination, 0o600);
}

async function decryptFile(source, destination, passphrase) {
  await runGpg(
    [
      "--batch",
      "--quiet",
      "--decrypt",
      "--pinentry-mode",
      "loopback",
      "--passphrase-fd",
      "3",
      "--output",
      destination,
      source,
    ],
    passphrase,
  );
  await chmod(destination, 0o600);
}

async function writePrivateJson(path, value) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function verifyGeneration(
  generationDir,
  { expectedManifestSha256 } = {},
) {
  const requestedGenerationDir = resolve(generationDir);
  await assertPrivateDirectory(requestedGenerationDir, "Generation directory");
  const absoluteGenerationDir = await realpath(requestedGenerationDir);

  const manifestPath = join(absoluteGenerationDir, MANIFEST_NAME);
  await assertPrivateFile(manifestPath, "Generation manifest");
  const manifestSha256 = await fileSha256(manifestPath);
  if (
    expectedManifestSha256 &&
    manifestSha256 !== expectedManifestSha256
  ) {
    throw new Error("Generation manifest SHA-256 does not match trusted evidence");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Generation manifest is not valid JSON");
  }
  if (
    manifest.schema_version !== SCHEMA_VERSION ||
    typeof manifest.generation_id !== "string" ||
    typeof manifest.created_at !== "string" ||
    manifest.encryption?.format !== "OpenPGP" ||
    manifest.encryption?.cipher !== "AES256" ||
    manifest.encryption?.aead !== "OCB" ||
    manifest.encryption?.minimum_gnupg !== "2.4" ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("Generation manifest has an unsupported schema");
  }
  assertGenerationId(manifest.generation_id);
  if (Number.isNaN(Date.parse(manifest.created_at))) {
    throw new Error("Generation manifest has an invalid creation time");
  }

  const paths = manifest.artifacts.map((artifact) => artifact?.path);
  if (
    paths.some((path) => typeof path !== "string") ||
    new Set(paths).size !== paths.length ||
    [...paths].sort().join("\n") !==
      [...REQUIRED_ENCRYPTED_ARTIFACTS].sort().join("\n")
  ) {
    throw new Error("Generation manifest does not list the required artifacts");
  }

  const expectedEntries = new Set([MANIFEST_NAME, ...paths]);
  const actualEntries = await readdir(absoluteGenerationDir);
  if (
    actualEntries.length !== expectedEntries.size ||
    actualEntries.some((entry) => !expectedEntries.has(entry))
  ) {
    throw new Error("Generation directory contains missing or unlisted entries");
  }

  for (const artifact of manifest.artifacts) {
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 || "")
    ) {
      throw new Error(`Invalid manifest record for ${artifact.path}`);
    }
    const artifactPath = join(absoluteGenerationDir, artifact.path);
    const details = await assertPrivateFile(
      artifactPath,
      `Encrypted artifact ${artifact.path}`,
    );
    if (details.size !== artifact.bytes) {
      throw new Error(`Size mismatch for ${artifact.path}`);
    }
    if ((await fileSha256(artifactPath)) !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch for ${artifact.path}`);
    }
  }

  return {
    generationDir: absoluteGenerationDir,
    generationId: manifest.generation_id,
    createdAt: manifest.created_at,
    manifest,
    manifestSha256,
  };
}

async function createGeneration({
  sourceDir,
  generationsDir,
  generationId,
  passphrase,
}) {
  assertGenerationId(generationId);
  const absoluteSourceDir = await realpath(resolve(sourceDir));
  await assertPrivateDirectory(absoluteSourceDir, "Plaintext source directory");
  const sourceEntries = await readdir(absoluteSourceDir);
  if (
    sourceEntries.length !== REQUIRED_PLAINTEXT_ARTIFACTS.length ||
    sourceEntries.some(
      (entry) => !REQUIRED_PLAINTEXT_ARTIFACTS.includes(entry),
    )
  ) {
    throw new Error(
      "Plaintext source must contain exactly the five required artifacts",
    );
  }

  const absoluteGenerationsDir = resolve(generationsDir);
  await assertPrivateDirectory(absoluteGenerationsDir, "Generations root", {
    create: true,
  });
  const realGenerationsDir = await realpath(absoluteGenerationsDir);
  if (
    pathIsWithin(absoluteSourceDir, realGenerationsDir) ||
    pathIsWithin(realGenerationsDir, absoluteSourceDir) ||
    absoluteSourceDir === realGenerationsDir
  ) {
    throw new Error(
      "Plaintext source and encrypted generations must be separate directories",
    );
  }

  const destination = join(realGenerationsDir, generationId);
  try {
    await lstat(destination);
    throw new Error(`Generation already exists: ${generationId}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const partial = join(
    realGenerationsDir,
    `.partial-${generationId}-${randomUUID()}`,
  );
  await mkdir(partial, { mode: 0o700 });
  try {
    const artifacts = [];
    for (const plaintextName of REQUIRED_PLAINTEXT_ARTIFACTS) {
      const source = join(absoluteSourceDir, plaintextName);
      await assertPrivateFile(source, `Plaintext artifact ${plaintextName}`);
      const encryptedName = `${plaintextName}.gpg`;
      const encryptedPath = join(partial, encryptedName);
      await encryptFile(source, encryptedPath, passphrase);
      const encryptedDetails = await stat(encryptedPath);
      artifacts.push({
        path: encryptedName,
        bytes: encryptedDetails.size,
        sha256: await fileSha256(encryptedPath),
      });
    }

    const manifest = {
      schema_version: SCHEMA_VERSION,
      generation_id: generationId,
      created_at: new Date().toISOString(),
      encryption: {
        format: "OpenPGP",
        cipher: "AES256",
        aead: "OCB",
        minimum_gnupg: "2.4",
      },
      artifacts,
    };
    await writePrivateJson(join(partial, MANIFEST_NAME), manifest);
    const verified = await verifyGeneration(partial);
    await rename(partial, destination);
    return {
      action: "created",
      generation_id: generationId,
      generation_dir: destination,
      manifest_sha256: verified.manifestSha256,
      artifact_count: artifacts.length,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function retrieveGeneration({
  sourceGenerationDir,
  destinationRoot,
  expectedManifestSha256,
}) {
  const verifiedSource = await verifyGeneration(sourceGenerationDir, {
    expectedManifestSha256,
  });
  const absoluteDestinationRoot = resolve(destinationRoot);
  if (
    absoluteDestinationRoot === verifiedSource.generationDir ||
    pathIsWithin(verifiedSource.generationDir, absoluteDestinationRoot) ||
    pathIsWithin(absoluteDestinationRoot, verifiedSource.generationDir)
  ) {
    throw new Error(
      "Retrieval source and destination roots must be separate directories",
    );
  }
  await assertPrivateDirectory(
    absoluteDestinationRoot,
    "Retrieval destination root",
    { create: true },
  );
  const realDestinationRoot = await realpath(absoluteDestinationRoot);
  const destination = join(
    realDestinationRoot,
    verifiedSource.generationId,
  );
  try {
    await lstat(destination);
    throw new Error(
      `Retrieved generation already exists: ${verifiedSource.generationId}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const partial = join(
    realDestinationRoot,
    `.partial-retrieval-${verifiedSource.generationId}-${randomUUID()}`,
  );
  await mkdir(partial, { mode: 0o700 });
  try {
    for (const entry of [
      MANIFEST_NAME,
      ...verifiedSource.manifest.artifacts.map((artifact) => artifact.path),
    ]) {
      await copyFile(
        join(verifiedSource.generationDir, entry),
        join(partial, entry),
      );
      await chmod(join(partial, entry), 0o600);
    }
    const verifiedCopy = await verifyGeneration(partial, {
      expectedManifestSha256: verifiedSource.manifestSha256,
    });
    await rename(partial, destination);
    return {
      action: "retrieved",
      generation_id: verifiedCopy.generationId,
      generation_dir: destination,
      manifest_sha256: verifiedCopy.manifestSha256,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function restoreGeneration({
  generationDir,
  restoreDir,
  expectedManifestSha256,
  passphrase,
}) {
  const verified = await verifyGeneration(generationDir, {
    expectedManifestSha256,
  });
  const requestedRestoreDir = resolve(restoreDir);
  const requestedRestoreParent = dirname(requestedRestoreDir);
  if (
    requestedRestoreDir === verified.generationDir ||
    pathIsWithin(verified.generationDir, requestedRestoreDir) ||
    pathIsWithin(requestedRestoreDir, verified.generationDir)
  ) {
    throw new Error(
      "Encrypted generation and plaintext restore roots must be separate",
    );
  }
  await assertPrivateDirectory(requestedRestoreParent, "Restore parent", {
    create: true,
  });
  const restoreParent = await realpath(requestedRestoreParent);
  const absoluteRestoreDir = join(
    restoreParent,
    basename(requestedRestoreDir),
  );
  try {
    await lstat(absoluteRestoreDir);
    throw new Error("Restore destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const partial = join(
    restoreParent,
    `.partial-restore-${verified.generationId}-${randomUUID()}`,
  );
  await mkdir(partial, { mode: 0o700 });
  try {
    for (const encryptedName of REQUIRED_ENCRYPTED_ARTIFACTS) {
      const plaintextName = encryptedName.slice(0, -4);
      await decryptFile(
        join(verified.generationDir, encryptedName),
        join(partial, plaintextName),
        passphrase,
      );
    }
    await writePrivateJson(join(partial, "restore-evidence.json"), {
      schema_version: SCHEMA_VERSION,
      generation_id: verified.generationId,
      restored_at: new Date().toISOString(),
      manifest_sha256: verified.manifestSha256,
    });
    await rename(partial, absoluteRestoreDir);
    return {
      action: "restored",
      generation_id: verified.generationId,
      restore_dir: absoluteRestoreDir,
      manifest_sha256: verified.manifestSha256,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function rotateGenerations({ generationsDir, retain, apply }) {
  if (!Number.isSafeInteger(retain) || retain < 2) {
    throw new UsageError("Rotation must retain at least two active generations");
  }
  const absoluteGenerationsDir = resolve(generationsDir);
  await assertPrivateDirectory(absoluteGenerationsDir, "Generations root");
  const entries = await readdir(absoluteGenerationsDir, {
    withFileTypes: true,
  });
  const active = [];
  for (const entry of entries) {
    if (entry.name === ".rotation-quarantine") {
      continue;
    }
    if (entry.name.startsWith(".") || !entry.isDirectory()) {
      throw new Error(
        `Generations root contains an incomplete or unknown entry: ${entry.name}`,
      );
    }
    const verified = await verifyGeneration(
      join(absoluteGenerationsDir, entry.name),
    );
    if (verified.generationId !== entry.name) {
      throw new Error(
        `Generation directory name does not match its manifest: ${entry.name}`,
      );
    }
    active.push(verified);
  }
  active.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.generationId.localeCompare(right.generationId),
  );
  const candidates = active.slice(0, Math.max(0, active.length - retain));
  const retained = active.slice(Math.max(0, active.length - retain));

  if (!apply || candidates.length === 0) {
    return {
      action: apply ? "no-op" : "planned",
      retained: retained.map((generation) => generation.generationId),
      quarantine_candidates: candidates.map(
        (generation) => generation.generationId,
      ),
      deleted: [],
    };
  }

  const quarantineRoot = join(
    absoluteGenerationsDir,
    ".rotation-quarantine",
  );
  await assertPrivateDirectory(quarantineRoot, "Rotation quarantine", {
    create: true,
  });
  const moved = [];
  for (const generation of candidates) {
    const destination = join(quarantineRoot, generation.generationId);
    try {
      await lstat(destination);
      throw new Error(
        `Quarantine already contains ${generation.generationId}; refusing overwrite`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await rename(generation.generationDir, destination);
    await verifyGeneration(destination, {
      expectedManifestSha256: generation.manifestSha256,
    });
    moved.push(generation.generationId);
  }
  for (const generation of retained) {
    await verifyGeneration(generation.generationDir, {
      expectedManifestSha256: generation.manifestSha256,
    });
  }
  return {
    action: "quarantined",
    retained: retained.map((generation) => generation.generationId),
    quarantined: moved,
    deleted: [],
  };
}

async function doctor() {
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(GPG_BIN, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(new Error(`GnuPG version check failed: ${stderr.trim()}`));
      }
    });
  });
  const match = result.match(/^gpg \(GnuPG\) ([0-9]+)\.([0-9]+)/m);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || major < 2 || (major === 2 && minor < 4)) {
    throw new Error("GnuPG 2.4 or newer is required for AES-256/OCB AEAD");
  }
  return {
    action: "doctor",
    gnupg_version: `${match[1]}.${match[2]}`,
    encryption: "OpenPGP AES256/OCB AEAD",
  };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(argv);
  let result;

  if (command === "doctor") {
    rejectUnknownOptions(options, new Set());
    result = await doctor();
  } else if (command === "create") {
    rejectUnknownOptions(
      options,
      new Set(["source-dir", "generations-dir", "generation-id"]),
    );
    const passphrase = await readPassphrase();
    result = await createGeneration({
      sourceDir: requireOption(options, "source-dir"),
      generationsDir: requireOption(options, "generations-dir"),
      generationId: requireOption(options, "generation-id"),
      passphrase,
    });
  } else if (command === "verify") {
    rejectUnknownOptions(
      options,
      new Set(["generation-dir", "expected-manifest-sha256"]),
    );
    const expectedManifestSha256 = options.get("expected-manifest-sha256");
    assertSha256(expectedManifestSha256);
    const verified = await verifyGeneration(
      requireOption(options, "generation-dir"),
      { expectedManifestSha256 },
    );
    result = {
      action: "verified",
      generation_id: verified.generationId,
      generation_dir: verified.generationDir,
      manifest_sha256: verified.manifestSha256,
      artifact_count: verified.manifest.artifacts.length,
    };
  } else if (command === "retrieve") {
    rejectUnknownOptions(
      options,
      new Set([
        "source-generation-dir",
        "destination-root",
        "expected-manifest-sha256",
      ]),
    );
    const expectedManifestSha256 = options.get("expected-manifest-sha256");
    if (typeof expectedManifestSha256 !== "string") {
      throw new UsageError(
        "retrieve requires --expected-manifest-sha256 from independent evidence",
      );
    }
    assertSha256(expectedManifestSha256);
    result = await retrieveGeneration({
      sourceGenerationDir: requireOption(
        options,
        "source-generation-dir",
      ),
      destinationRoot: requireOption(options, "destination-root"),
      expectedManifestSha256,
    });
  } else if (command === "restore") {
    rejectUnknownOptions(
      options,
      new Set([
        "generation-dir",
        "restore-dir",
        "expected-manifest-sha256",
      ]),
    );
    const expectedManifestSha256 = options.get("expected-manifest-sha256");
    if (typeof expectedManifestSha256 !== "string") {
      throw new UsageError(
        "restore requires --expected-manifest-sha256 from independent evidence",
      );
    }
    assertSha256(expectedManifestSha256);
    const passphrase = await readPassphrase();
    result = await restoreGeneration({
      generationDir: requireOption(options, "generation-dir"),
      restoreDir: requireOption(options, "restore-dir"),
      expectedManifestSha256,
      passphrase,
    });
  } else if (command === "rotate") {
    rejectUnknownOptions(
      options,
      new Set(["generations-dir", "retain", "apply"]),
    );
    const retain = Number(requireOption(options, "retain"));
    result = await rotateGenerations({
      generationsDir: requireOption(options, "generations-dir"),
      retain,
      apply: options.get("apply") === true,
    });
  } else {
    throw new UsageError(`Unknown command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const prefix = error instanceof UsageError ? "Usage error" : "Backup check failed";
  process.stderr.write(`${prefix}: ${error.message}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(usage());
  }
  process.exitCode = 1;
});
