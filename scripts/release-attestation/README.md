# Release attestation authoring

This generator owns repeated release identities, preflight and rank-manifest statements, and restore-check orchestration. It does not infer business policy, approve observed database drift, or run a database command.

Run from the repository root:

```sh
npm run generate:release-attestation -- --output-dir /absolute/empty/output-directory
npm run check:release-attestation
```

Generation writes into an empty directory and refuses to overwrite files. Checking compares generated statements and scripts, verifies generated application metadata, and reproduces historical output against the pinned Git baseline. A full Git history is required for the baseline check. No provider credentials or database are required.

## Declared inputs

- `release-states.json` records the current release, release heads, predecessor identities and preflight names. Counts and pending lists derive from the candidate's ordered migration filenames. Each identity row is `[id, head, preflight version, manifest version]`. Schedule V25 and Payments V25 are distinct states.
- `preflight-schema.json` holds shared checks and per-state additions/overrides. Preserve earlier states; put changed pins in the new state's override. `preflight-policy.mjs` contains explicit catalog and semantic checks that a schema inventory cannot infer.
- `manifest-schema.json` holds required rank-writer signatures, return contracts and receipt-schema facts. Expected values remain reviewed facts. They are never silently copied from the database being inspected.
- `restore-cases.json` and `restore-shell.mjs` retain finite historical shell layouts. Their declarations identify source ancestry, probes and expectations. Historical wording and formatting are preserved for byte reproduction.
- `python-restore-schema.json`, `restore-python.mjs` and `fixtures/python-*` own the Python restore cases. Use the reusable forward profile for a new release. Business seeds, snapshots and continuation assertions remain explicit fixtures. A forward case's `semanticManifests` list contains only facts that must remain unchanged across the upgrade. Put intentionally changed facts in its version-bound `checks` instead.
- Other `fixtures/` files contain V31's financial, replay and concurrency proofs. They are substantive tests, not disposable boilerplate.

## Adding a release

1. Write the narrowly scoped business change in a new migration. Never edit applied migration files.
2. Add its identity to `release-states.json` and advance its `current` field. Add the new preflight state by inheriting the previous checks and declaring only the actual changes. Add any required manifest facts without replacing historical declarations.
3. Obtain proposed expected pins from disposable canonical and real logical-restored states. Review the whole difference set. Keep canonical/restored acceptance tuples separate and preserve independent raw observations. Generation does not authorize a pin or make a failed readiness result acceptable.
4. Declare the restore case and its explicit business fixtures. Preserve source rows, prove the intended continuation, and retain owned-database cleanup and target guards. Schema alone cannot supply expected financial or authorization behavior.
5. Generate into an empty directory. Review the emitted function/ACL fragments and place them in the new migration in dependency order. They are not a complete business migration: retain the required predecessor checks, guarded expectation-table corrections and installed-state assertions.
6. Copy the generated history/readiness modules into `scripts/release-attestation/`, the generated Python readiness file into `backend/app/services/`, and approved restore scripts into `scripts/`, preserving their declared file modes. Existing restore outputs may be updated only after historical reproduction and the intended inventory-only differences are verified.
7. Run the offline check, focused tests and the full disposable database suite. Inspect generated API contracts if response shapes changed. Require fresh review and the exact candidate gate before guarded merge.

The backend's generated readiness metadata selects the current full preflight. Historical restore cases need version-bound readiness bindings when a later release exists; a moving `FINAL` alias must not accidentally redirect an older proof.

## Proof boundaries

Current SQL generation covers the full-preflight, compatibility and rank-manifest authoring families, with historical examples checked byte-for-byte. Other historical definitions remain immutable inputs. The checker reports generated coverage separately; it does not claim every historical catalog implementation was replaced.

All ten historical restore scripts must reproduce their committed bytes and modes. The additional V31-through-V37 script runs the V31 business proof once and then explicit forward checks. The local verifier calls that script directly; it no longer rewrites a program at a PASS message.

Canonical and restored evidence, function bodies versus installed definitions, complete ACLs, exact normalization pairs, retained rows and replay behavior are separate contracts. Keep them separate. A generated file or matching hash is not approval to migrate production. Existing human-only production gates and current operator guidance still apply.
