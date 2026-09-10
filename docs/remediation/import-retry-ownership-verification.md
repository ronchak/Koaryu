# Import retry ownership verification

PR178 remains a draft. Its first independent review found a missing existing-program binding; that correction is now being verified. OPS2-04, OPS2-05, OPS2-06, OPS2-07 and BT5-02 remain pending until the final change is reviewed and merged. PROGRAM-IMPORT-01 records the separate unanswered product choice for a program-specific belt supplied without Program.

## Result under review

A retry uses committed row and setup outcomes instead of repeating writes over later staff edits. Unknown execution failures retain the same request identity and remain retryable. Invalid input remains a skipped row. Final audit warnings are stored with the completed result, so response loss does not create a different success story on retry.

Program facts are loaded once rather than once per student. Setup requests include only valid unfinished rows. The retired studio-wide ladder repair has no remaining caller and is removed; ordinary single-program ladder creation and renaming remain.

Completed legacy caches remain readable. New or incomplete imports through the retired caller are refused, as are unreceipted row writes and legacy completion. Existing incomplete legacy data is not inferred, rewritten or backfilled. A separately authorized rollout must stop old import callers before the database/backend transition. Rolling back only application code will not restore legacy import writes.

## Database evidence

The actual V45 migration passed on a disposable PostgreSQL 17 cluster after all 139 unchanged predecessors. It reported 140 migrations, head `20260910185031`, 56 pending versions and `release-db-attestation-v45`. V37–V44 compatibility readiness also passed.

Canonical and real logical-restored captures agree on the new function contracts and import schema. The generated rank manifest has zero invalid entries. The only expectation-data correction is the guarded V31 operational-contract row, from `168cc61b…` to `9a317cbe…`; other expectation tables stay unchanged. Historical raw constraint differences remain separately represented. No nonzero manifest was accepted as a new baseline.

The V44-to-V45 restore proof preserves existing students, independent program dates, guardians, legacy import results and a historical EUR plan. It refuses incomplete legacy recovery, replays completed caches and executes the maintained import contracts on canonical and restored copies. Contract source bytes are frozen and their hashes accompany the evidence.

The maintained SQL contracts cover edited/deleted replay, first-rank preservation, actual foreign student and guardian collisions, receipt-failure rollback, setup replay and finalization warnings. A separate disposable proof confirmed that the real clear RPC cascades owned receipts while direct service-role receipt deletion remains forbidden and foreign records stay unchanged.

The student-writer concurrency runner retains five rank cases and adds eight import cases: clear/import in both orders, Auth deletion/import in both orders, first-rank setup against the rank-plan student's lock, and end-of-write progress for row/program/belt commands. All 13 targeted cases passed with observed blocking before settlement. Auth deletion here means actual SQL foreign-key cascades, not a GoTrue API test.

## Test maintenance

The import Python tests shrink from 1,129 to 870 lines. The copied claim state machine and private-loop setup tests are removed. Composed executor tests cover same-key recovery, receipt preload, authoritative final warnings, completed replay and valid-row-only setup. Two program/ladder read tests now assert absence of writes rather than patching a retired helper name.

Three frontend live-import source assertions are replaced by a real StoreProvider test. It confirms a saved import, fails belt refresh before that path can refresh eligibility, then observes the separate eligibility refresh. The fixture defaults were corrected to preserve the older mounted tests. All 40 tests in the two affected files passed. A private negative control removed the live invalidation callback, caused the new test to fail, and restored the original runtime bytes. The one preview sequence guard and unrelated bulk/lead guards remain.

Release-tool tests keep their 66 cases by extending existing predecessor and corruption matrices. They caught a missing V44 predecessor entry in the runtime; that entry is fixed and all 66 passed. Across the changed Python, frontend, SQL, release-tool and concurrency tests plus the new restore fixtures, authored test and local-verifier code shrinks by 65 lines. Generated restore files grow by 265 lines, so those combined repository files grow by 200 lines; the maintained authoring surface is smaller. The generated V45 restore artifact is additional derived output, not another hand-maintained restore implementation. All ten historical restore scripts reproduce their original bytes.

## Current check status

- Actual V45 migration, retained readiness and focused SQL contracts: passed.
- Targeted student-writer concurrency: 13 passed.
- V44-to-V45 restore: passed; full-suite evidence is being refreshed with final maintained contracts.
- Backend: the earlier full run passed 1,886 tests. After V45 metadata changes, one obsolete test-runner filename failed; its targeted guard checks now pass. The final run after dead-code removal passed all 1,886 tests.
- Frontend affected files: 40 passed, with the missing-callback negative control detected.
- Release tool: 66 passed. Generator: eight groups and historical reproduction passed.
- Full local database suite: the first assembled run reached final checks and exposed a stale prior-version rank-manifest literal, which was corrected. The next run passed all migrations, restores and contracts and was stopped during negative checks after independent review identified the program-binding correction. The corrected candidate requires a complete run and follow-up review before merge.

Early failures were retained as evidence: one draft SQL edit removed a guardian-block terminator and was corrected; a restore declaration incorrectly classified changed import manifests as unchanged; private test directories and unconfirmed Auth fixtures were corrected without weakening target or last-admin guards. These were not production failures. One generated whitespace-only line remains byte-identical to the inherited renderer format.

No production migration, deployment, financial backfill, provider change, mail or DNS work occurred. Private logs, captures and failed attempts remain outside the repository under `Koaryu Remediation/2026-09-07/import-ownership`.

## Independent review correction

The fresh Astra reviewer reproduced a retry splitting remaining students into a newly created program after the original existing program was renamed. Root independently reproduced it with the real executor and scripted server responses. Every selected program reference now gets an immutable receipt, including existing programs and imports that create no belts. SQL selection uses an explicit ID and refuses missing, archived or foreign targets instead of falling back to a matching name. The existing two-attempt regression now checks a renamed program and fails against the prior writer. The revised RPC and assembled migration passed their focused SQL contracts; final restore, full-suite and reviewer confirmation are pending.
