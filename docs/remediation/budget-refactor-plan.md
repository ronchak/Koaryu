# September 12 budget-capped refactor

The owner resumed the program with a hard limit of 50 percentage points from a weekly baseline of 0% used. Check the live account-wide Codex weekly meter before each batch and during work. Account-wide use counts conservatively against this run. Stop starting batches at 45 points and reserve the final five for review, CI, ledger updates and a clean stopping point. Do not redeem resets or substitute token estimates for this meter. If the meter becomes unavailable, do not start another batch.

A fresh GPT-5.6 Sol thread implements each batch with only its recipe and repository/package guidance. The coordinator reviews the result before opening a PR. A separate fresh reviewer receives the diff and recipe. Threads are never reused across batches or PRs. The coordinator owns integration, exact-head CI, guarded merge and tracking. One implementation owns each worktree. No Supabase, migration, SQL-contract or database-concurrency implementation is in scope.

## Revised priority: remove billing's implicit shared object

The owner redirected the run after PR182: peripheral cleanup is insufficient while billing's manager/workflow/private-facade graph remains. The six display/recovery fixes and remaining copy batches are still pending, but no longer lead the sequence. The student-presentation worker was interrupted before changing any implementation file; there is no half-written UI change.

Current baseline at `d6bab29209d2ee4650b8f01e0ece474ff519f422`:

| Measure | Verified baseline |
| --- | ---: |
| Billing service modules | 29 |
| Source bytes | 834,268 |
| Source lines, after formatter | 20,760 |
| Opaque workflow owners | 4 |
| Classes reaching through an owner/service back-reference | 16 |
| Static owner attribute references | 192 |
| Private-facade methods | 71 |

The catalogue declares 28 supported workflows, seven internal-only workflows and three unsupported workflows. These classifications do not prove enabled studio grants or commercial availability. The stale README does not justify deleting financial functionality. Preserve the actual implemented contract and correct its description.

The owner also authorizes replacing billing implementation from scratch where that yields a simpler design. Existing code is a behavioral reference, not a structure that must survive. This does not waive API/tenant/financial/retry contracts, the database exclusion, or budget gates. No parallel billing engine or generic workflow framework. Replacement remains incremental by coherent product responsibility, with the old path deleted in the same merge.

The structural target is BB1-09: remove opaque workflow owners, manager back-references to BillingService, private-method forwarding and the facade's import back into the service. Keep BillingService only where it provides a useful public entry/composition boundary; components underneath it must not call back into it. Moving methods into another opaque context object, callback bag, Protocol or mixin does not count as progress.

Sequence, reassessed after each merge:

1. **Complete plan ownership, done in PR183.** Merge the plan sync implementation into the existing plan manager, using the concrete database client, existing Connect account store and Stripe factory. Delete the workflow module/class and dead facade plan aliases. Preserve the V44 RPC, provider step plan, idempotency, replay, projection and audit ordering. This is the first bounded proof that a billing component can work without the shared service object.
2. **Remove shared back-reference routes.** PR184 completed the next cut, removing 35 of the 68 remaining facade methods and four unused enrollment forwarders. Six facade aliases were test-only, 27 lacked BillingService receiver callers, and two more belonged solely to a dead enrollment forwarding chain. Existing implementations stay with their actual managers/projectors. PR185 made payer operations concrete and relocated their four existing fact/balance functions, eliminating manager construction for those facts and the reverse service import. PR186 gave the three provider projectors concrete dependencies and removed their service back-references. The next slice makes Connect/autopay commands concrete, reuses existing redirect rules and consolidates the ordinary billing audit insert. Follow actual dependency direction through account/payer facts and provider projections. Move existing rules to their real owners or call existing pure functions directly. Remove forwarding methods at their callers. Do not create a replacement common facade or new behavior. Projection must not need to call command managers through BillingService.
3. **Complete invoice and enrollment ownership.** Remove their opaque owner paths. Collapse wrappers where responsibilities are inseparable; retain an independent workflow component only with concrete dependencies and a distinct responsibility. Do not merge different workflow state machines merely to reduce file count. Delete obsolete paths as each replacement is proved.
4. **Delete the remaining private facade and reverse import.** Re-enumerate every runtime and test caller; no compatibility shim maintained solely for tests. BB1-09 remains pending until the whole graph meets this condition, not merely because one family improved.
5. **Correct product/operator truth, then remaining defects.** DOC1-02 and the other release-guide corrections remain valuable and require no execution of their commands. Return to the six verified user-visible defects and other delegated work if budget remains after meaningful structural progress. Omit lower-value work before jeopardizing cleanup.

The first slice merged as `91184e7`, removing one module, one class, ten net method definitions and two opaque back-references. Its exact-head PR and main CI passed. Moving roughly 1,500 lines is not deletion. Record actual net source/test changes, move-aware comparison and removed call hops. Do not claim this first slice alone fixes billing architecture.

This explicitly adds billing's architectural finding to the prior 55-finding selection scope. Eight original batches contain those 55 findings; saved recipe14 is a subset of batch08, not another set of findings. All paused items retain their dispositions. Four prerequisites remain excluded: BT4-06/ACS1-04, BT5-05/OPS1-09, BT3-07/OPS1-06 and FC3-08/FC3-01. DOC1-05 remains owner action. Draft PR180 stays saved.

## Verification and stopping conditions

Keep behavior unless a verified defect requires correction. Correct false promises without building missing features. No new abstraction, generic helper or fixture framework. Reuse existing test machinery and remove redundant tests. Do not add source-text assertions, replace each deleted grep with a test, or change safety assertions under a presentation recipe. Verify all numeric claims independently. The formatter baseline increases physical test/e2e lines without increasing cases; measure later reductions from that new baseline.

Every structural PR must remove dependency routes or competing implementations, not merely rename files. Record removed objects/forwarders/back-references separately from moved code. No new database state, receipts, migrations, verification framework or infrastructure. Preserve provider/RPC payloads, side-effect order, tenancy, authorization and retry identity. Use existing strong tests and remove obsolete fixture indirection; do not add a regression test for a move. Every PR records its exact head, fresh review, meaningful verification, and actual before/after test lines/cases. Existing safety and database CI gates remain mandatory. Read production auto-deploy off before every guarded merge. No production deployment/migration, backup execution, billing activation, historical backfill, mail or DNS work. Nothing in [PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md) executes in this run.

At wind-down, leave every change committed/pushed or safely parked in a draft, no non-draft PR mid-verification, and main green on its own exact-head CI. Update the ledger, REMEDIATION.md and HANDOFF.md with exact counts by disposition/track, completed/remaining/dropped batches and reasons, final main identity, and actual budget position. The complete remediation program may remain unfinished.
