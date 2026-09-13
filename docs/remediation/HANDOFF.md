# Koaryu remediation handoff

The September 13 bounded run has stopped implementation. The remediation program remains incomplete. No production release was executed.

## Main, budget and clean stopping point

- Main at handoff preparation, after PR205: `4244384fb701d7a2bb9b8fcca581a403e695836b`. Its own exact-head Release candidate run `34790631140` passed. API contracts run `34790631200` passed. The closing documentation PR has a later merge SHA. The closing task report records that SHA, its own CI and the final meter read; a committed handoff cannot contain its own merge hash.
- Usage read at 2026-09-13 23:50 UTC: 50% weekly used, against this run's 45% baseline, so 5 points spent and 5 remain under the 10-point cap. Stop new work at 53%, hard ceiling 55%. Implementation has already stopped. Remaining allowance is for review, CI and cleanup. Do not reuse the previous run's zero baseline or 50% ceiling. The weekly window resets September 19 at 10:16:57 UTC; no reset credit was taken.
- Four implementation PRs are merged and their commits pushed. Final worktree/ref/PR sweeps follow the handoff merge. Nothing may remain uncommitted, unpublished or as a non-draft remediation PR mid-verification. Older unrelated PRs 63–74 are outside this run.

## What landed

Every item used a fresh Sol implementer, coordinator review and a fresh independent PR reviewer. All four PRs passed exact-head CI and the guarded merge. See [verification](bounded-refactor-verification.md) for exact heads, tests and limits.

| PR | Result |
| --- | --- |
| 202 | Normalize billing calendar ISO date/timestamp inputs before UTC formatting; preserve local timestamp rendering. |
| 203 | Inject export test clocks and control provider timeout/completion ordering; keep real production limits. Loaded proof passed all four cases while the frontend suite ran. |
| 204 | Share the existing packing/compiler and Map storage fixtures; replace preference source checks with actual behavior; remove incidental assertions. |
| 205 | Fetch Auth facts only for selected active studio staff; propagate provider failures and strengthen the fixture that previously missed hydration. |

Four original findings are newly fixed: FT1-07, FT1-12, OPS1-09 and BT5-05. Item 3 is partial: FT1-11 and FT2-08 still contain protected workflow/source-shape claims. No item was skipped entirely, but those umbrella remainders were not expanded into another implementation PR.

This run removes 240 test-source lines overall: frontend/e2e −316, backend +76. Frontend cases fall 902→894; backend stays 1,904. PR204's changed scope removes 123 assertion calls; raw readFileSync occurrences fall 103/33 files→101/32. These metrics differ because reads include loaders and policies. Since the formatter baseline `d6bab29209d2ee4650b8f01e0ece474ff519f422`, application Python/TypeScript is 1,192 lines smaller and the recorded test/JSON-fixture scopes are 87 lines smaller. Billing's earlier opaque-owner/facade removal remains intact; see [ownership verification](enrollment-ownership-verification.md).

## Exact ledger counts

Original 278 observations, by current execution track:

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 22 | 107 | 129 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 29 | 104 | 133 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

Seven program findings remain separate: fixed Astra 1/Sol 2; pending Astra 4/Sol 0. Fixed are PROGRAM-SECURITY-01, PROGRAM-ATTESTATION-01 and PROGRAM-DEPENDENCIES-02. Pending are PROGRAM-CURRENCY-01, PROGRAM-IMPORT-01, PROGRAM-ACTIVATION-01 and PROGRAM-REFUND-01. No new high-consequence risk was accepted.

## Delegated batches and remaining work

Batches 01, 02, 03, 05, 08, 09, 10, 12 and 13 are complete. Batches 04, 06 and 11 have only the excluded prerequisites below. Batch07 remains partial. Recipe14 completed its batch08 subset in PR180; recipe15 completed OPS1-09/BT5-05 in PR205. The [batch index](delegated/README.md) links all recipes and PRs.

Of the original 55 selected findings, 49 are fixed, one obsolete and five pending:

- BT4-06 waits for ACS1-04; BT3-07 waits for OPS1-06; FC3-08 waits for FC3-01. All three prerequisites were explicitly excluded. Do not infer permission to implement them from the leftover fixture work.
- FT1-11/FT2-08 retain Dashboard identity/pointer state, legal-name gate, transition helper-name and source-parsed report-catalog claims. Replace one owning workflow's claims with a small behavioral contract, then reassess. Do not repeat completed fixture extraction or delete protected assertions in bulk. A further behavioral pass is roughly 4–6 implementation/review points plus wind-down reserve, a planning estimate to recheck after scoping. It was not started inside this run's remaining allowance.

## Recommended next PR

Give [PROGRAM-REFUND-01](refund-completion-risk.md) its own database-capable budget. It remains a production-release gate. A succeeded refund can project its changed refunded amount, fail receipt completion, then receive 409 on same-key retry because its stored resource version changed. The prior reproduction used actual service/projector code with synthetic provider/database fixtures; SQL source supports the mechanism. No forward correction or new database proof was attempted here. Do not bypass claims/leases, forge resource hashes or complete before projection. Astra owns SQL, migration, attestation, restore and concurrency proof; Sol owns application changes. The owner estimated comparable migrations at 8–15 points, so this was explicitly excluded from the current cap.

Then revisit PROGRAM-ACTIVATION-01 with BB1-06/BT1-02: a pre-provider failure can freeze derived quantity. Preserve already-attempted provider operations and idempotency. Unknown/mixed currency reporting, family attribution, overdue definitions and other worker/lock findings remain pending. PROGRAM-IMPORT-01 still needs the omitted-Program/program-specific-belt decision; retain its safe refusal. Settled decisions in REMEDIATION.md remain authoritative. DOC1-05 is support-address owner action, with no mail/DNS work.

## Production release stays blocked

[PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md) is still pinned to `f942dad3509a2e2cc9b55d546c2d22e097f77abe`, not current main. A new candidate needs a fresh packet, approvals, rehearsal, backup/restore evidence and deployment requests. No packet step was executed.

There are 140 migrations through V45, unchanged in this run. The packet's seven V39–V45 hashes match. The last hosted database inspection was September 11 UTC, V38/133 migrations; the last observed production application pair was `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. These are dated observations, not fresh database/app readbacks.

The chain is forward-only with no approved down-migration. Fresh pre-apply backup/restore proof and hosted V45 staging rehearsal still do not exist. The private backup helper needs reviewed post-V45 mappings. Database first, backend second, frontend last: current backend RPCs are absent from the last-observed production database. Neither application may be promoted before migration and verification.

Each guarded merge read Render production auto-deploy off; Vercel main auto-deployment remains false in source. No production migration, deployment, live billing or historical financial backfill occurred. Production apply remains human-only in a real interactive terminal. No local migration state was created; CI used disposable verification.

## Traps and log-only follow-ups

- CI belongs to one exact SHA. Fetch current refs and use `scripts/merge-release-pr.sh`; never reuse a superseded green result. Read back GitHub state after a transport error before retrying a merge.
- PR203 fixes the three reported wall-clock tests without changing the 35ms caller or 15s export limits. Use the existing injected clock for resource-boundary tests. Keep the independent 15.0/16.0-second behavioral boundary proof.
- PR205 uses one Auth call per selected user under the unchanged 320-call ceiling. Large staff exports can hit that ceiling; no batching infrastructure was added.
- Ruff/Prettier are pinned. Keep behavior diffs free of reflow. Use physical dependency copies in worktrees; a node_modules symlink previously broke Turbopack. Older backend venv copies may lack the pinned Ruff.
- Plain-HTTP external payments still depend on unavailable crypto.randomUUID. No fix was started. Seven restore-contract scripts reportedly retain 56–65% duplication; no rewrite was started.
- The old import-verification 870-line claim was already absent. Do not invent a replacement 884 count. CTA1-04 remains rejected: root CHANGELOG.md is a 21-byte symlink whose target matches the audited content.
- One usage read returned an inconsistent reset window; two fresh reads confirmed the original window. The cap never changed. New work needs a fresh authorized baseline, not assumptions from a previous run.
- Private records are under `/Users/openclaw/Projects/Koaryu-Repo/.git/orchestrator/20260913-bounded-refactor/`. Credentials, dumps and operator evidence remain outside the repository. Read current AGENTS.md and private operator guidance before credential/release work.
