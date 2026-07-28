import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const script = join(repositoryRoot, "scripts", "backup-recovery.mjs");
const passphrase = `${createHash("sha256")
  .update("public Koaryu synthetic backup fixture")
  .digest("hex")}\n`;
const wrongPassphrase = `${createHash("sha256")
  .update("public Koaryu wrong-key fixture")
  .digest("hex")}\n`;
const plaintextNames = [
  "data.sql",
  "record-classification-manifest.json",
  "roles.sql",
  "schema.sql",
  "storage-objects.tar",
];

async function runCli(args, { input = "", env = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
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
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function makeFixture(directory, label) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const content = new Map([
    ["roles.sql", `create role synthetic_${label};\n`],
    ["schema.sql", `create table synthetic_${label}(id integer);\n`],
    ["data.sql", `insert into synthetic_${label} values (1);\n`],
    [
      "record-classification-manifest.json",
      `${JSON.stringify({ synthetic: true, label })}\n`,
    ],
    ["storage-objects.tar", `synthetic-storage-archive:${label}\n`],
  ]);
  for (const [name, value] of content) {
    await writeFile(join(directory, name), value, { mode: 0o600 });
    await chmod(join(directory, name), 0o600);
  }
  return content;
}

async function parseSuccessful(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test(
  "synthetic encrypted generations verify, retrieve, reject wrong keys, restore cleanly, and rotate without deletion",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "koaryu-backup-recovery-"));
    await chmod(root, 0o700);
    try {
      const source = join(root, "plaintext");
      const expectedContent = await makeFixture(source, "one");
      const generations = join(root, "generations");
      const createOne = await parseSuccessful(
        await runCli(
          [
            "create",
            "--source-dir",
            source,
            "--generations-dir",
            generations,
            "--generation-id",
            "synthetic-20260727T000001Z",
          ],
          { input: passphrase },
        ),
      );
      assert.equal(createOne.action, "created");
      assert.match(createOne.manifest_sha256, /^[a-f0-9]{64}$/);

      const extraSource = join(root, "plaintext-with-extra-file");
      await makeFixture(extraSource, "extra");
      await writeFile(join(extraSource, "unexpected.txt"), "refuse me\n", {
        mode: 0o600,
      });
      const extraSourceResult = await runCli(
        [
          "create",
          "--source-dir",
          extraSource,
          "--generations-dir",
          generations,
          "--generation-id",
          "synthetic-20260727T000099Z",
        ],
        { input: passphrase },
      );
      assert.notEqual(extraSourceResult.code, 0);
      assert.match(
        extraSourceResult.stderr,
        /exactly the five required artifacts/,
      );
      assert.equal(
        (await readdir(generations)).some((entry) =>
          entry.includes("000099"),
        ),
        false,
      );

      const verifyOne = await parseSuccessful(
        await runCli([
          "verify",
          "--generation-dir",
          createOne.generation_dir,
          "--expected-manifest-sha256",
          createOne.manifest_sha256,
        ]),
      );
      assert.equal(verifyOne.artifact_count, 5);

      const tampered = join(root, "tampered");
      await cp(createOne.generation_dir, tampered, { recursive: true });
      await appendFile(join(tampered, "data.sql.gpg"), "tampered");
      const tamperCheck = await runCli([
        "verify",
        "--generation-dir",
        tampered,
        "--expected-manifest-sha256",
        createOne.manifest_sha256,
      ]);
      assert.notEqual(tamperCheck.code, 0);
      assert.match(tamperCheck.stderr, /(?:Size|SHA-256) mismatch/);

      const manifestTampered = join(root, "manifest-tampered");
      await cp(createOne.generation_dir, manifestTampered, { recursive: true });
      const manifestPath = join(
        manifestTampered,
        "generation-manifest.json",
      );
      const changedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      changedManifest.created_at = "2026-07-27T23:59:59.000Z";
      await writeFile(
        manifestPath,
        `${JSON.stringify(changedManifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await chmod(manifestPath, 0o600);
      const manifestTamperCheck = await runCli([
        "verify",
        "--generation-dir",
        manifestTampered,
        "--expected-manifest-sha256",
        createOne.manifest_sha256,
      ]);
      assert.notEqual(manifestTamperCheck.code, 0);
      assert.match(
        manifestTamperCheck.stderr,
        /manifest SHA-256 does not match trusted evidence/,
      );

      const cleanGpgHome = join(root, "clean-gnupg-home");
      await mkdir(cleanGpgHome, { mode: 0o700 });
      const retrievedRoot = join(root, "clean-machine-download");
      const unanchoredRetrieval = await runCli([
        "retrieve",
        "--source-generation-dir",
        createOne.generation_dir,
        "--destination-root",
        retrievedRoot,
      ]);
      assert.notEqual(unanchoredRetrieval.code, 0);
      assert.match(
        unanchoredRetrieval.stderr,
        /requires --expected-manifest-sha256/,
      );
      const retrieved = await parseSuccessful(
        await runCli([
          "retrieve",
          "--source-generation-dir",
          createOne.generation_dir,
          "--destination-root",
          retrievedRoot,
          "--expected-manifest-sha256",
          createOne.manifest_sha256,
        ]),
      );
      assert.equal(retrieved.action, "retrieved");

      const wrongRestore = join(root, "wrong-key-restore");
      const wrongKeyResult = await runCli(
        [
          "restore",
          "--generation-dir",
          retrieved.generation_dir,
          "--restore-dir",
          wrongRestore,
          "--expected-manifest-sha256",
          createOne.manifest_sha256,
        ],
        {
          input: wrongPassphrase,
          env: { GNUPGHOME: cleanGpgHome },
        },
      );
      assert.notEqual(wrongKeyResult.code, 0);
      assert.match(wrongKeyResult.stderr, /GnuPG failed closed/);
      await assert.rejects(readdir(wrongRestore), { code: "ENOENT" });
      assert.equal(
        (await readdir(root)).some((entry) =>
          entry.startsWith(".partial-restore-"),
        ),
        false,
      );

      const correctRestore = join(root, "clean-machine-restore");
      const restored = await parseSuccessful(
        await runCli(
          [
            "restore",
            "--generation-dir",
            retrieved.generation_dir,
            "--restore-dir",
            correctRestore,
            "--expected-manifest-sha256",
            createOne.manifest_sha256,
          ],
          {
            input: passphrase,
            env: { GNUPGHOME: cleanGpgHome },
          },
        ),
      );
      assert.equal(restored.action, "restored");
      for (const name of plaintextNames) {
        assert.equal(
          await readFile(join(correctRestore, name), "utf8"),
          expectedContent.get(name),
        );
      }

      for (const [id, label] of [
        ["synthetic-20260727T000002Z", "two"],
        ["synthetic-20260727T000003Z", "three"],
      ]) {
        const nextSource = join(root, `plaintext-${label}`);
        await makeFixture(nextSource, label);
        await parseSuccessful(
          await runCli(
            [
              "create",
              "--source-dir",
              nextSource,
              "--generations-dir",
              generations,
              "--generation-id",
              id,
            ],
            { input: passphrase },
          ),
        );
      }

      const plan = await parseSuccessful(
        await runCli([
          "rotate",
          "--generations-dir",
          generations,
          "--retain",
          "2",
        ]),
      );
      assert.deepEqual(plan.quarantine_candidates, [
        "synthetic-20260727T000001Z",
      ]);
      assert.deepEqual(plan.deleted, []);

      const applied = await parseSuccessful(
        await runCli([
          "rotate",
          "--generations-dir",
          generations,
          "--retain",
          "2",
          "--apply",
        ]),
      );
      assert.deepEqual(applied.quarantined, [
        "synthetic-20260727T000001Z",
      ]);
      assert.deepEqual(applied.deleted, []);
      assert.deepEqual(
        (await readdir(generations))
          .filter((entry) => !entry.startsWith("."))
          .sort(),
        [
          "synthetic-20260727T000002Z",
          "synthetic-20260727T000003Z",
        ],
      );
      const quarantinedGeneration = join(
        generations,
        ".rotation-quarantine",
        "synthetic-20260727T000001Z",
      );
      const quarantineCheck = await parseSuccessful(
        await runCli([
          "verify",
          "--generation-dir",
          quarantinedGeneration,
          "--expected-manifest-sha256",
          createOne.manifest_sha256,
        ]),
      );
      assert.equal(quarantineCheck.action, "verified");

      const unsafeRetention = await runCli([
        "rotate",
        "--generations-dir",
        generations,
        "--retain",
        "1",
        "--apply",
      ]);
      assert.notEqual(unsafeRetention.code, 0);
      assert.match(unsafeRetention.stderr, /retain at least two/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
