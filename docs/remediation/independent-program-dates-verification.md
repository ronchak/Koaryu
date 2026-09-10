# Independent program joining dates

V42 completes DM2-02 for student profile edits. Changing or clearing the overall joining date preserves every retained program's joining date, including unknown dates. New memberships keep their existing creation default. The preview model follows the same rule. Explicit program editing, rank restoration, paused status, tenant checks, lock order, guardian writes and audit rollback remain intact. No historical business rows are rewritten.

The migration replaces only the private profile writer's date-propagation logic. The release generator supplies V23 full readiness, V22 compatibility, the updated V13 rank-return manifest and the V41-to-V42 restore checker. Application readiness and release inspection advance together to 137 migrations, head `20260910084231`, manifest `release-db-attestation-v42` and 53 pending-history versions. Exact V41 remains a predecessor; V22 through V18 preserve the existing application contracts.

## Evidence

The complete disposable PostgreSQL 17 run passed all 137 migrations, 51 SQL contracts, historical/current restore proofs, independent rejection probes and concurrency checks. Its owned cluster was stopped and removed.

- Both an independently upgraded canonical database and an actual V41 logical restore reached exact V42 readiness. All retained fixture rows survived migration unchanged. Both public profile APIs then saved a changed overall date while preserving program dates, statuses and ranks. The complete profile SQL contract passed on both copies.
- The permanent generated restore proof uses all 137 source hashes, exact tool/input hashes, 12 reviewed CHECK representation pairs, six billing-definition replays and 22 owner-ACL representation corrections. The original source database remains unchanged. Current migration SHA-256 is `33df4f374ec26a8c17814f8d794f5b06a7dcd9a7cdf21d469fc622180f86e0f2`; the independently created synthetic dump is `56a0e0ee2ffa0c57ec508bc23187ea99571316106505b175dfd8685806e59d91`.
- Canonical and restored function bodies/definitions match. Only the expected function category changes in the existing 126-function catalog inventory; other catalog categories retain their separate canonical/restored values. V40 rank-command and V41 payer-balance facts stay unchanged. The affected V11/V13/V31/V12 manifest values were derived and checked explicitly.
- Generator checks pass eight groups and reproduce all ten historical restore scripts and historical SQL statements byte-for-byte. A synthetic next release still renders from declarations without reading its target files.
- The 66 rollout tests, 128 workflow checks, 14 readiness tests, three restore-target/normalization tests, eight preview model tests, TypeScript and focused lint pass. The new restore checker also rejects hosted or unowned targets before invoking database tools.

## Test maintenance and remaining work

The old preview/SQL assertions that required overall-to-program date propagation were replaced within existing cases. No additional preview or rollout test case was added. Three repeated rollout transport fixtures now share the existing snapshot-to-header mapping. The rollout test file shrinks by 28 lines while covering V41 predecessor selection, V42 canonical/restored classification, exact suffixes and missing/mixed evidence. The new 232-line restore script is generated; its explicit business fixtures protect migration preservation and continuation rather than matching production source text.

OPS2-05 remains pending. Reclaiming a failed import run can repeat previously committed rows and overwrite staff edits made between attempts. Its acceptance criteria now cover program dates as well as other saved fields. A date-only import patch would leave the broader retry defect intact. Lead conversion's marker and deterministic student commit together; investigation found no equivalent ordinary replay path.

These are disposable local proofs. They are not hosted-state verification or production backup evidence. No production migration, deployment or backfill is authorized. Fresh independent review and exact-head release CI are required before merge.
