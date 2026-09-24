import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  LEDGER_PATH,
  MARKDOWN_PATHS,
  applyLedgerCounts,
  deriveLedgerCounts,
  planLedgerCountFiles,
  renderCountsBlock,
  serializeLedger,
} from "./remediation-ledger-counts.mjs";

const finding = (id, disposition, track) => ({ id, disposition, track });
const syntheticLedger = () => ({
  dispositions: ["pending", "fixed", "obsolete"],
  findings: [
    finding("A-1", "fixed", "Sol"),
    finding("A-2", "pending", "Astra"),
    finding("A-3", "pending", "Sol"),
    finding("A-4", "obsolete", "Sol"),
  ],
  current_counts: { fixed: 9, pending: 9, obsolete: 9 },
  current_pending_tracks: { Sol: 9, Astra: 9 },
  current_disposition_tracks: {
    fixed: { Sol: 9 },
    pending: { Sol: 9, Astra: 9 },
    obsolete: { Sol: 9 },
  },
  program_findings: [
    finding("P-1", "fixed", "Astra"),
    finding("P-2", "pending", "Sol"),
  ],
});

function writeRepository(
  ledger,
  markdownBody = (block) => `# Doc\n\n${block}\n\nTail.\n`,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-counts-"));
  fs.mkdirSync(path.join(root, "docs/remediation"), { recursive: true });
  const expected = applyLedgerCounts(ledger);
  fs.writeFileSync(path.join(root, LEDGER_PATH), serializeLedger(expected));
  for (const file of MARKDOWN_PATHS)
    fs.writeFileSync(
      path.join(root, file),
      markdownBody(renderCountsBlock(expected)),
    );
  return root;
}

const drift = (root) =>
  planLedgerCountFiles(root).filter((file) => file.current !== file.expected);

test("derives disposition and track counts from the findings", () => {
  const { counts, tracks, trackTotals, total } =
    deriveLedgerCounts(syntheticLedger());
  assert.deepEqual(counts, { pending: 2, fixed: 1, obsolete: 1 });
  assert.deepEqual(tracks.pending, { Astra: 1, Sol: 1 });
  assert.deepEqual(trackTotals, { Astra: 1, Sol: 3 });
  assert.equal(total, 4);
});

test("rewrites stored counts while preserving key order", () => {
  const ledger = applyLedgerCounts(syntheticLedger());
  assert.deepEqual(Object.keys(ledger.current_counts), [
    "fixed",
    "pending",
    "obsolete",
  ]);
  assert.deepEqual(ledger.current_counts, {
    fixed: 1,
    pending: 2,
    obsolete: 1,
  });
  assert.deepEqual(Object.keys(ledger.current_pending_tracks), [
    "Sol",
    "Astra",
  ]);
  assert.deepEqual(ledger.current_disposition_tracks.obsolete, { Sol: 1 });
});

test("a current repository passes, and a changed disposition without regeneration drifts", () => {
  const root = writeRepository(syntheticLedger());
  assert.deepEqual(drift(root), []);
  const ledgerFile = path.join(root, LEDGER_PATH);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.findings[1].disposition = "fixed";
  fs.writeFileSync(ledgerFile, serializeLedger(ledger));
  assert.deepEqual(
    drift(root).map((file) => file.path),
    [LEDGER_PATH, ...MARKDOWN_PATHS],
  );
});

test("moving a finding between tracks drifts even when disposition totals are unchanged", () => {
  const root = writeRepository(syntheticLedger());
  const ledgerFile = path.join(root, LEDGER_PATH);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.findings[2].track = "Astra";
  fs.writeFileSync(ledgerFile, serializeLedger(ledger));
  assert.deepEqual(
    drift(root).map((file) => file.path),
    [LEDGER_PATH, ...MARKDOWN_PATHS],
  );
});

test("program findings are counted separately from the audit findings", () => {
  const block = renderCountsBlock(applyLedgerCounts(syntheticLedger()));
  assert.match(block, /\| Total \| 1 \| 3 \| 4 \|/);
  assert.match(
    block,
    /2 program findings, tracked separately: 1 fixed, 1 pending\./,
  );
  const root = writeRepository(syntheticLedger());
  const ledgerFile = path.join(root, LEDGER_PATH);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.program_findings[1].disposition = "fixed";
  fs.writeFileSync(ledgerFile, serializeLedger(ledger));
  assert.deepEqual(
    drift(root).map((file) => file.path),
    MARKDOWN_PATHS,
  );
});

test("a hand-edited Markdown count drifts", () => {
  const root = writeRepository(syntheticLedger());
  const file = path.join(root, MARKDOWN_PATHS[0]);
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("| Pending | 1 | 1 | 2 |", "| Pending | 1 | 1 | 3 |"),
  );
  assert.deepEqual(
    drift(root).map((entry) => entry.path),
    [MARKDOWN_PATHS[0]],
  );
});

test("missing or duplicated generated blocks are refused", () => {
  assert.throws(
    () =>
      planLedgerCountFiles(
        writeRepository(syntheticLedger(), () => "# No block\n"),
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      planLedgerCountFiles(
        writeRepository(syntheticLedger(), (block) => `${block}\n${block}\n`),
      ),
    /exactly one/,
  );
});

test("invalid findings are refused instead of counted", () => {
  const ledger = syntheticLedger();
  ledger.findings.push(finding("A-1", "fixed", "Sol"));
  assert.throws(() => deriveLedgerCounts(ledger), /Duplicate finding id/);
  const undeclared = syntheticLedger();
  undeclared.findings[0].disposition = "done";
  assert.throws(() => deriveLedgerCounts(undeclared), /undeclared disposition/);
  const track = syntheticLedger();
  track.findings[0].track = "Other";
  assert.throws(() => deriveLedgerCounts(track), /unknown track/);
});

test("the committed ledger and documents match their findings", () => {
  assert.deepEqual(
    drift(path.resolve(import.meta.dirname, "..")).map((file) => file.path),
    [],
  );
});

test("the generated block is delimited for regeneration", () => {
  const block = renderCountsBlock(applyLedgerCounts(syntheticLedger()));
  assert.ok(block.startsWith(BLOCK_BEGIN) && block.endsWith(BLOCK_END));
});
