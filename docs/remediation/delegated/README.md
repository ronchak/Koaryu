# Sol execution batches

These recipes are starting points for a fresh Sol thread with current AGENTS.md, package guidance and the selected recipe only. Verify current callers and the ledger before editing; completed recipes contain historical instructions. Do not pass remediation history or a cumulative reviewer thread to a new batch.

Root owns architecture, personal review, integration, CI, guarded merges and tracking. Each PR gets a separate fresh reviewer with its diff and recipe. A correction may reuse a thread within that same batch/PR only. Sol implements application/docs work; Astra owns Supabase, migrations, SQL contracts and concurrency proofs. Database work and the four prerequisites below were excluded from this run. No production execution, backfill, mail/DNS or extra infrastructure is authorized.

| Batch | Current status | Pending IDs |
| --- | --- | --- |
| [01 billing product truth](01-billing-product-truth.md) | Complete, PR195 | None |
| [02 operator/release docs](02-operator-and-release-docs.md) | Complete, PR194; generator prerequisite was PR167 | None |
| [03 customer copy/setup](03-customer-copy-and-first-read-docs.md) | Complete, PR193 and PR198 | None |
| [04 backend contract/copy](04-backend-contract-and-copy-maintenance.md) | Eligible work complete, PR199 | BT4-06 → ACS1-04; BT5-05 → OPS1-09 |
| [05 backend dead code/fixtures](05-backend-dead-code-and-fixtures.md) | Complete, PR171 | None |
| [06 performance evidence](06-performance-evidence-maintenance.md) | Eligible work complete, PR174 and PR200 | BT3-07 → OPS1-06 |
| [07 frontend fixtures/claims](07-frontend-test-fixtures-and-claims.md) | Partial, PR177 and PR196; FT2-07 obsolete after PR169 | FT1-07, FT1-11, FT1-12, FT2-08 |
| [08 display/dead interfaces](08-display-and-dead-interfaces.md) | Complete, PR180, PR192 and PR197 | None |
| [09 shared route/UI contracts](09-shared-route-and-ui-contracts.md) | Complete, PR169 | None |
| [10 schedule rendering](10-schedule-rendering-and-operations-tests.md) | Complete, PR173 | None |
| [11 student/roster presentation](11-student-and-roster-presentation.md) | Eligible work complete, PR176 and PR191 | FC3-08 → FC3-01 |
| [12 marketing scene](12-marketing-scene-contracts.md) | Complete, PR165 | None |
| [13 dependency advisories](13-dependency-maintenance.md) | Complete, PR166; program finding outside the audit 278 | None |

[Recipe14](14-dead-ui-interface-closeout.md) is the completed six-finding subset of batch08, merged in PR180. It is not another independent audit batch. Of the 55 findings selected for this run, 46 are fixed, one is obsolete and eight remain pending. The ledger also contains broader application findings outside this original batch index.

The four prerequisite-dependent items remain pending by explicit owner direction. Shared packer/storage work was not started in the remaining allowance; it needs a bounded design that reduces indirection without adding a generic fixture layer. FT1-11/FT2-08 remain broad obligations, not a claim that every source assertion must become a new test. Their remaining work crosses multiple safety-sensitive suites and needs a larger review boundary than the wind-down budget permits.

Use [source-test cleanup ownership](../source-test-cleanup.md) to distinguish incidental wording/shape checks from meaningful policies. Preserve authorization, identity, destructive mutation, financial, idempotency and lifecycle assertions. Delete duplicates and obsolete checks without adding a test per removed grep. Record collected cases, lines and retained static-check limits honestly.

DOC1-05 remains owner action. Its future support-address note is in the operations docs; no mailbox, mail or DNS work was performed. [HANDOFF](../HANDOFF.md) records the budget, exact final preparation state and next recommended PR. The program is paused after this bounded run, not complete.
