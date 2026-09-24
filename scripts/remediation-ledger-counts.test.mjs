import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  LEDGER_PATH,
  MARKDOWN_PATHS,
  applyLedgerCounts,
  deriveLedgerCounts,
  main,
  planLedgerCountFiles,
  renderCountsBlock,
  serializeLedger,
} from "./remediation-ledger-counts.mjs";

const script = fileURLToPath(new URL("./remediation-ledger-counts.mjs", import.meta.url));
const repositoryRoot = path.resolve(path.dirname(script), "..");
const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

const finding = (id, disposition, track) => ({ id, disposition, track });
// Pending is split unevenly (1 Astra, 2 Sol) so swapped columns cannot pass.
const syntheticLedger = () => ({
  dispositions: ["pending", "fixed", "obsolete"],
  findings: [
    finding("A-1", "fixed", "Sol"),
    finding("A-2", "pending", "Astra"),
    finding("A-3", "pending", "Sol"),
    finding("A-4", "pending", "Sol"),
    finding("A-5", "obsolete", "Sol"),
  ],
  current_counts: { fixed: 9, pending: 9, obsolete: 9 },
  current_pending_tracks: { Sol: 9, Astra: 9 },
  current_disposition_tracks: {
    fixed: { Sol: 9 },
    pending: { Sol: 9, Astra: 9 },
    obsolete: { Sol: 9 },
  },
  program_findings: [finding("P-1", "fixed", "Astra"), finding("P-2", "pending", "Sol")],
});

function writeRepository(ledger, markdownBody = (block) => `# Doc\n\n${block}\n\nTail.\n`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-counts-"));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, "docs/remediation"), { recursive: true });
  const expected = applyLedgerCounts(ledger);
  fs.writeFileSync(path.join(root, LEDGER_PATH), serializeLedger(expected));
  for (const file of MARKDOWN_PATHS)
    fs.writeFileSync(path.join(root, file), markdownBody(renderCountsBlock(expected)));
  return root;
}

function editLedger(root, edit) {
  const file = path.join(root, LEDGER_PATH);
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(ledger);
  fs.writeFileSync(file, serializeLedger(ledger));
}

const drift = (root) =>
  planLedgerCountFiles(root)
    .filter((file) => file.current !== file.expected)
    .map((file) => file.path);

const snapshot = (root) =>
  [LEDGER_PATH, ...MARKDOWN_PATHS].map((file) => fs.readFileSync(path.join(root, file), "utf8"));

test("derives disposition and track counts from the findings", () => {
  const { counts, tracks, trackTotals, total } = deriveLedgerCounts(syntheticLedger());
  assert.deepEqual(counts, { pending: 3, fixed: 1, obsolete: 1 });
  assert.deepEqual(tracks.pending, { Astra: 1, Sol: 2 });
  assert.deepEqual(trackTotals, { Astra: 1, Sol: 4 });
  assert.equal(total, 5);
});

test("rewrites every stored count while preserving key order", () => {
  const ledger = applyLedgerCounts(syntheticLedger());
  assert.deepEqual(Object.entries(ledger.current_counts), [
    ["fixed", 1],
    ["pending", 3],
    ["obsolete", 1],
  ]);
  assert.deepEqual(Object.entries(ledger.current_pending_tracks), [
    ["Sol", 2],
    ["Astra", 1],
  ]);
  assert.deepEqual(ledger.current_disposition_tracks, {
    fixed: { Sol: 1 },
    pending: { Sol: 2, Astra: 1 },
    obsolete: { Sol: 1 },
  });
});

test("renders exact per-track rows, totals and summaries", () => {
  assert.equal(
    renderCountsBlock(applyLedgerCounts(syntheticLedger())),
    [
      BLOCK_BEGIN,
      "| Disposition | Astra | Sol | Total |",
      "| --- | ---: | ---: | ---: |",
      "| Fixed | 0 | 1 | 1 |",
      "| Pending | 1 | 2 | 3 |",
      "| Obsolete | 0 | 1 | 1 |",
      "| Total | 1 | 4 | 5 |",
      "",
      "3 audit observations are pending: 1 Astra and 2 Sol. These are observations, not ticket or PR counts. 2 program findings, tracked separately: 1 fixed, 1 pending.",
      BLOCK_END,
    ].join("\n"),
  );
});

test("a current repository passes, and a changed disposition without regeneration drifts", () => {
  const root = writeRepository(syntheticLedger());
  assert.deepEqual(drift(root), []);
  editLedger(root, (ledger) => {
    ledger.findings[1].disposition = "fixed";
  });
  assert.deepEqual(drift(root), [LEDGER_PATH, ...MARKDOWN_PATHS]);
});

test("moving a finding between tracks drifts even when disposition totals are unchanged", () => {
  const root = writeRepository(syntheticLedger());
  editLedger(root, (ledger) => {
    ledger.findings[2].track = "Astra";
  });
  assert.deepEqual(drift(root), [LEDGER_PATH, ...MARKDOWN_PATHS]);
});

for (const field of ["current_counts", "current_pending_tracks", "current_disposition_tracks"]) {
  test(`a stale ${field} alone drifts`, () => {
    const root = writeRepository(syntheticLedger());
    editLedger(root, (ledger) => {
      if (field === "current_counts") ledger.current_counts.pending += 1;
      if (field === "current_pending_tracks") ledger.current_pending_tracks.Sol += 1;
      if (field === "current_disposition_tracks")
        ledger.current_disposition_tracks.pending.Astra += 1;
    });
    assert.deepEqual(drift(root), [LEDGER_PATH]);
  });
}

test("program findings are counted separately from the audit findings", () => {
  const root = writeRepository(syntheticLedger());
  editLedger(root, (ledger) => {
    ledger.program_findings[1].disposition = "fixed";
  });
  assert.deepEqual(drift(root), MARKDOWN_PATHS);
});

test("a hand-edited Markdown count drifts", () => {
  const root = writeRepository(syntheticLedger());
  const file = path.join(root, MARKDOWN_PATHS[0]);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("| Pending | 1 | 2 | 3 |", "| Pending | 2 | 1 | 3 |"),
  );
  assert.deepEqual(drift(root), [MARKDOWN_PATHS[0]]);
});

test("missing, duplicated or stray generated block markers are refused", () => {
  for (const body of [
    () => "# No block\n",
    (block) => `${block}\n${block}\n`,
    (block) => `${block}\n${BLOCK_END}\n`,
    (block) => `${BLOCK_BEGIN}\n${block}\n`,
  ])
    assert.throws(() => planLedgerCountFiles(writeRepository(syntheticLedger(), body)), /exactly one/);
});

test("invalid audit or program findings are refused instead of counted", () => {
  const cases = [
    [(ledger) => ledger.findings.push(finding("A-1", "fixed", "Sol")), /Duplicate findings id/],
    [
      (ledger) => {
        ledger.findings[0].disposition = "done";
      },
      /undeclared disposition/,
    ],
    [
      (ledger) => {
        ledger.findings[0].track = "Other";
      },
      /unknown track/,
    ],
    [
      (ledger) => {
        ledger.program_findings[0].disposition = "done";
      },
      /undeclared disposition/,
    ],
    [
      (ledger) => {
        ledger.program_findings[0].track = "Other";
      },
      /unknown track/,
    ],
    [
      (ledger) => ledger.program_findings.push(finding("P-1", "fixed", "Sol")),
      /Duplicate program_findings id/,
    ],
    [
      (ledger) => {
        delete ledger.findings;
      },
      /must be an array/,
    ],
  ];
  for (const [edit, message] of cases) {
    const ledger = syntheticLedger();
    edit(ledger);
    assert.throws(() => deriveLedgerCounts(ledger), message);
  }
});

test("--check exits 1 on drift without changing files, and --write repairs them", () => {
  const root = writeRepository(syntheticLedger());
  assert.equal(main(["--check"], root), 0);
  editLedger(root, (ledger) => {
    ledger.findings[1].disposition = "fixed";
  });
  const drifted = snapshot(root);
  assert.equal(main(["--check"], root), 1);
  assert.deepEqual(snapshot(root), drifted, "--check must not write");
  assert.equal(main(["--write"], root), 0);
  assert.equal(main(["--check"], root), 0);
  assert.deepEqual(drift(root), []);
});

test("an invalid ledger or usage fails the command", () => {
  const root = writeRepository(syntheticLedger());
  editLedger(root, (ledger) => {
    ledger.findings[0].track = "Other";
  });
  assert.equal(main(["--check"], root), 1);
  assert.equal(main(["--write"], root), 1);
  assert.equal(main([], root), 2);
  assert.equal(main(["--check", "--write"], root), 2);
});

test("the CLI entry point reports its exit status", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(run("--check").status, 0);
  assert.equal(run().status, 2);
});

test("serialization escapes non-ASCII as UTF-16 code units like the committed ledger", () => {
  assert.equal(
    serializeLedger({ text: "café ’ \u2028 😀" }),
    '{\n  "text": "caf\\u00e9 \\u2019 \\u2028 \\ud83d\\ude00"\n}\n',
  );
});

test("the committed ledger and documents match their findings", () => {
  assert.deepEqual(drift(repositoryRoot), []);
});
