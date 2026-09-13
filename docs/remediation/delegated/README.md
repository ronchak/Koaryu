# Sol execution batches

These recipes are starting points for a fresh Sol thread with current AGENTS.md, package guidance and the selected recipe only. Verify current callers and the ledger before editing; completed recipes contain historical instructions. Do not pass remediation history or a cumulative reviewer thread to a new batch.

Root owns architecture, personal review, integration, CI, guarded merges and tracking. Each PR gets a separate fresh reviewer with its diff and recipe. A correction may reuse a thread within that same batch/PR only. Sol implements application/docs work; Astra owns Supabase, migrations, SQL contracts and concurrency proofs. Database work and the three remaining prerequisites below were excluded from the September 13 run. Selected staff Auth hydration was explicitly authorized and completed in PR205. No production execution, backfill, mail/DNS or extra infrastructure is authorized.

| Batch | Current status | Pending IDs |
| --- | --- | --- |
| [01 billing product truth](01-billing-product-truth.md) | Complete, PR195 | None |
| [02 operator/release docs](02-operator-and-release-docs.md) | Complete, PR194; generator prerequisite was PR167 | None |
| [03 customer copy/setup](03-customer-copy-and-first-read-docs.md) | Complete, PR193 and PR198 | None |
| [04 backend contract/copy](04-backend-contract-and-copy-maintenance.md) | Eligible work complete, PR199 and PR205 | BT4-06 → ACS1-04 |
| [05 backend dead code/fixtures](05-backend-dead-code-and-fixtures.md) | Complete, PR171 | None |
| [06 performance evidence](06-performance-evidence-maintenance.md) | Eligible work complete, PR174 and PR200 | BT3-07 → OPS1-06 |
| [07 frontend fixtures/claims](07-frontend-test-fixtures-and-claims.md) | Partial, PR177, PR196 and PR204; FT2-07 obsolete after PR169 | FT1-11, FT2-08 |
| [08 display/dead interfaces](08-display-and-dead-interfaces.md) | Complete, PR180, PR192 and PR197 | None |
| [09 shared route/UI contracts](09-shared-route-and-ui-contracts.md) | Complete, PR169 | None |
| [10 schedule rendering](10-schedule-rendering-and-operations-tests.md) | Complete, PR173 | None |
| [11 student/roster presentation](11-student-and-roster-presentation.md) | Eligible work complete, PR176 and PR191 | FC3-08 → FC3-01 |
| [12 marketing scene](12-marketing-scene-contracts.md) | Complete, PR165 | None |
| [13 dependency advisories](13-dependency-maintenance.md) | Complete, PR166; program finding outside the audit 278 | None |

[Recipe14](14-dead-ui-interface-closeout.md) is the completed six-finding subset of batch08, merged in PR180. It is not another independent audit batch. Of the original 55 selected findings, 49 are fixed, one is obsolete and five remain pending. [Recipe15](15-staff-export-auth-hydration.md) completed OPS1-09 and BT5-05 together in PR205; OPS1-09 was outside that original 55. The ledger also contains broader application findings outside this original batch index.

Three prerequisite-dependent items remain pending by explicit owner direction. PR204 completes the named shared packer/compiler and storage work, with no new framework. FT1-11/FT2-08 remain partial: decorative and redundant checks were removed, but protected Dashboard/legal-name/transition workflow claims and source-parsed report metadata remain. A further behavioral pass needs an explicit bounded ownership plan; do not erase safety checks to close the umbrella IDs.

Use [source-test cleanup ownership](../source-test-cleanup.md) to distinguish incidental wording/shape checks from meaningful policies. Preserve authorization, identity, destructive mutation, financial, idempotency and lifecycle assertions. Delete duplicates and obsolete checks without adding a test per removed grep. Record collected cases, lines and retained static-check limits honestly.

DOC1-05 remains owner action. Its future support-address note is in the operations docs; no mailbox, mail or DNS work was performed. [HANDOFF](../HANDOFF.md) records the budget, exact final preparation state and next recommended PR. The program is paused after this bounded run, not complete.
