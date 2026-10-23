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
- `python-restore-schema.json`, `restore-python.mjs` and `fixtures/python-*` own the Python restore cases. Use the reusable forward profile for a new release. Business seeds, snapshots and continuation assertions remain explicit fixtures. A forward case may declare `upgradeSnapshotCheck` as a fixture function name for an intentional repair. That comparison must enumerate the exact permitted row/column changes; source preservation remains unconditional. A forward case's `semanticManifests` list contains only facts that must remain unchanged across the upgrade. Put intentionally changed facts in its version-bound `checks` instead.
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

Canonical and restored evidence, function bodies versus installed definitions, complete ACLs, exact normalization pairs, retained rows and replay behavior are separate contracts. Keep them separate. A generated file or matching hash is not approval to migrate production. Owner-authorized release execution follows `docs/cutover-gates.md`, including its announce-and-pause protocol and every technical gate.

V57's current catalog facts use fixed UTC, ISO/YMD and postgres interval deparse settings. Preserve those settings in both the generated V38 guard and raw CLI queries, and verify that the guard restores caller settings. The final restore owner extends the historical CHECK normalization with the single named `automation_workflow_email_attempts_recipient_email_check` BETWEEN replay. Earlier release declarations and the original twelve pairs remain unchanged.

V58 retains V57 as an exact predecessor and advances the current guard to preflight V39.
Its forward proof preserves expired pilot grants/checkpoints and incomplete legacy
bootstrap rows, then tests GA authority and onboarding continuation on canonical and
logical-restored copies. V58 uses the existing V57 CHECK normalization pairs. The
complete table facts change only the bootstrap checkpoint column's nullability;
canonical, restored and Supabase profile pins remain separate.

V59 installs `private.timezone_names` with PostgreSQL's accepted names at migration
execution. Stable invoker helpers use its primary key; PostgreSQL still supplies
live conversion rules. The 12 current SQL callers preserve their UTC fallback or
validation rejection, including onboarding's New York default for NULL and the
workflow validator's syntax and namespace restrictions. Inventory reconciliation
runs in `timezone_names_reference_contract.sql` and guarded release inspection,
never in routine readiness. Deliberate runtime inventory changes use the guarded
transactional refresh procedure below and the same disposable parity proof. V59's full preflight V40
retains V58-shaped success rows through the generated V39 compatibility bridge.
Its forward restore case binds V58 and V59 independently and permits only the
named V31 expectation singleton to change among retained rows.
V59 preserves the four separate table profiles. The existing Supabase canonical
V58 table pin was reproduced locally with the Supabase ALL-table-grant bootstrap;
V59's Supabase canonical and logical-restored pins come from that same disposable
profile. This does not inspect or authorize a hosted database.

V59 rollout inspection reads the V59 catalog, complete table/function states,
release manifest and exact V58 compatibility response. It also compares the
stored names with the target runtime's catalog and refuses missing or surplus
names. This read-only enumeration runs during guarded release inspection, where
runtime changes matter; routine preflight/readiness remains a cached lookup.
The standalone check uses the same SQL and validator on a disposable restore:

```sh
backend/venv/bin/python scripts/check-timezone-names-parity.py \
  "$KOARYU_PG_BIN_DIR/psql" /tmp/koaryu-pg.<owned>/socket 5432 <owned_database>
```

Before a deliberate PostgreSQL/tzdata upgrade, restore a fresh backup under the
proposed runtime and run parity plus the populated V59 round-trip proof. Review
missing and surplus names. Rule/offset changes for retained names need no refresh.
If inventory changes are intentional, the named owner must authorize the runtime
upgrade and refresh using the normal backup, disposable restore and production
apply gates. This worktree has no production authority.

Refresh only as the reference owner in one transaction during a quiesced application
write window, with a bounded lock wait and a bounded transaction lifetime: PostgreSQL 17's
`transaction_timeout` and `idle_in_transaction_session_timeout` roll the refresh back and
release its locks if the session stalls or idles after acquiring them. Lock the business tables against writes
before locking the reference and checking stored zones; this also excludes direct
studio updates that do not call a timezone helper. A lock timeout or deadlock
refuses the whole transaction; resolve active writers before retrying.
The operator must set the explicit approval flag shown below. Refuse removal of a
zone still stored by a studio, trial, belt event or open invoice collection episode
(which keeps the zone frozen when it opened, even if the studio later changes zone);
resolve those rows through the normal application owners before retrying. Do not
disable their CHECKs.

```sql
BEGIN;
SET LOCAL transaction_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL koaryu.timezone_names_refresh = 'approved-runtime-upgrade';
LOCK TABLE public.studios, public.lead_trial_appointments, public.belt_test_events,
  private.workflow_invoice_collection_episodes IN SHARE MODE;
LOCK TABLE private.timezone_names IN ACCESS EXCLUSIVE MODE;
DO $refresh_guard$
BEGIN
  IF current_setting('koaryu.timezone_names_refresh', true)
       IS DISTINCT FROM 'approved-runtime-upgrade' THEN
    RAISE EXCEPTION 'Explicit runtime-upgrade refresh approval required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT timezone FROM public.studios
      UNION SELECT timezone FROM public.lead_trial_appointments
      UNION SELECT timezone FROM public.belt_test_events
      UNION SELECT frozen_timezone FROM private.workflow_invoice_collection_episodes
        WHERE closed_at IS NULL
    ) stored
    WHERE timezone IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_timezone_names runtime WHERE runtime.name = stored.timezone
    )
  ) THEN
    RAISE EXCEPTION 'Stored timezone absent from proposed runtime; resolve before refresh';
  END IF;
END;
$refresh_guard$;
DELETE FROM private.timezone_names stored
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names runtime WHERE runtime.name = stored.name);
INSERT INTO private.timezone_names(name)
SELECT name FROM pg_catalog.pg_timezone_names ON CONFLICT DO NOTHING;
DO $parity$
BEGIN
  IF EXISTS (SELECT name FROM pg_catalog.pg_timezone_names EXCEPT SELECT name FROM private.timezone_names)
     OR EXISTS (SELECT name FROM private.timezone_names EXCEPT SELECT name FROM pg_catalog.pg_timezone_names) THEN
    RAISE EXCEPTION 'Timezone refresh parity failed';
  END IF;
END;
$parity$;
COMMIT;
```

After committing, repeat guarded inspection and service-role lookups. Refresh
changes reference rows only; ownership, grants, RLS and readiness declarations
stay fixed. The populated backup proof restores ordinary trial/belt CHECKs without
changing the dump order or bypassing validation, then compares names and security
and exercises service-role lookups and both drift directions.

V60 replaces only `private.missed_class_automation_candidates`: the absence clock
starts at the first class day after a visit and stops 60 days past the threshold.
No table, type, reason value or privilege changes. Its full preflight V41 replaces
`timezone_functions_v59` with `missed_class_functions_v60` (the same inventory plus
the V40 bridge, excluding V41) and advances only the `automation_functions_v56`
override. Every other V59 pin, the V31 expectation singleton and the table and
catalog profiles are unchanged; the canonical pins were measured on a replayed
V59 upgrade and the restored ones by the generated V59-to-V60 restore proof. V41
retains V59-shaped success rows through the generated V40 compatibility bridge.
The forward restore case permits no retained-row change and probes the new gaps
at explicit references. Guarded inspection accepts an exact V59 predecessor,
including timezone name parity, and V60 post-state evidence with V59
compatibility. The private backup helper needs reviewed `(154,'20261014083106')
-> 40` and `(155,'20261021093000') -> 41` mappings before backing up V59 or V60.


V61 installs nullable student/guardian import provenance, paired source identity
fields and indexes, the reserved `skipped` receipt kind, and four appended optional
row-import arguments. The arguments are accepted but unused; imports only gain
provenance stamps. Both old function signatures are removed. The V11 security
manifest and generated V13 return manifest bind the replacement signatures.
Preflight V42 inherits V60, replaces the changed RPC/receipt and complete catalog
facts, and retains exact V60 readiness through the V41 compatibility bridge.

The V60-to-V61 forward proof uses `student-import-v61.mjs` for version-bound
observations. A forward case can select a `module` under this directory; historical
cases keep the rollout module. V61's four table profiles were measured separately
on disposable PostgreSQL 17 canonical and logical-restored databases, with CRUD
and Supabase ALL-table-default ACL bootstraps. Only students, guardians and receipt
constraints differ from V60. Its snapshot comparison permits the new NULL columns
and the exact guarded V31 expectation correction, preserving every other retained
field. Continuation uses the deployed ten-argument call, checks provenance and a
receipt, then compares rows and physical tuple identities across replay.

The local runner's `history` branch advances its V56 database through V59 before
running the retained V60 restore proof. It then applies V60 and runs the V61
restore proof before exiting. The `all` path runs these proofs later once each;
`current` runs the V61 proof. A focused dispatch test checks migration order and
proves that both history restore calls are reachable before early exit.

`install_final_v60` is version-bound to V60. Current application composition uses
`install_final_v61`, which validates the generated application readiness metadata,
upgrades through V60, and installs V61. Historical V57 setup callers stay bound
to V57; only the graph-mail and test-email application composition callers advance.
