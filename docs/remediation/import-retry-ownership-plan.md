# Import retry ownership

Base: main `ddacde14e3c0a43ae8faa0536a732b9b5ece59ed`, after PR176. Target OPS2-04, OPS2-05, OPS2-06, OPS2-07 and BT5-02 together where the final implementation proves closure. Financial read corrections remain pending; this change comes first because retries can overwrite committed customer data.

## Verified problem

The existing run hash and processing token prevent competing claims, but deterministic student IDs are not completion receipts. Replaying the current row RPC overwrites subsequent phone, guardian, program-date and paused-status edits. Transient row failures can also be cached as completed input errors. Setup uses separate, unclaimed upserts, including a broad ladder repair that can change unrelated configuration. Finally, audit warnings are added after result finalization clears the token, so the returned result and cached replay can disagree.

A disposable PostgreSQL 17 probe on the same 139 migrations reproduced destructive row replay and an actual clear/import deadlock. It also reproduced an Auth-deletion deadlock under a studio-before-run lock prelude. Locking the referenced Auth user before studio/run avoided that observed cycle; deletion-first refused before mutation. These are real SQL cascades and explicit lock preludes, not a GoTrue API test or a completed receipt implementation.

## Bounded change

- Keep the existing studio/request hash, claim token, completed result cache and logical row identity. Add import-owned durable outcomes so a completed row returns its original outcome without calling the upsert or compatibility-rank update again. Use independently stored receipts rather than rewriting a growing run JSON document for every row. At 10,000 rows, the latter repeats 50,005,000 accumulated entries. Store only metadata needed for truthful recovery and diagnostics.
- Load completed outcomes once when claiming recovery, before replanning or setup. Reuse their original counts and diagnostics; current student state is not evidence of the original result. Revalidate unfinished work. Unknown execution failures retain the same request/key and remain retryable; genuine input validation failures remain skipped rows.
- Give requested setup an import-specific transaction and receipt owner. Preserve default-program behavior for valid unmapped rows, the default ladder for an import-created program, and explicitly requested missing belts/ladders. Exclude rejected student rows from setup requests. Remove import calls to studio-wide ladder repair; do not port unrelated ladder renaming, attachment or program creation into the new transaction. Reuse confirmed setup identities after later staff edits, rather than upserting them again.
- Fetch program facts once for planning and report archived programs before execution. The SQL row owner still rechecks tenant and archive boundaries. Remove per-row program lookup requests while retaining those database checks.
- Freeze the final result and audit outcome together. Preserve the current noncritical audit-warning policy, but persist that warning before clearing the token. A lost finalization response is an unknown outcome recovered with the existing key, not an instruction to import the rows again.
- Completed legacy caches remain replayable. Incomplete runs without trustworthy receipts fail closed rather than inferring success from editable records. Initialize the receipt contract atomically with the claim and distinguish old callers safely. Keep one authoritative claim implementation if compatibility entry points are needed. Old import callers must pause and drain during a separately authorized rollout.

## Locks and remaining design checks

Reuse V44's shared clear advisory gate before import operations that acquire domain locks. Clear takes the existing matching exclusive gate before its membership-to-run deletes. The import claim advisory key can stabilize actor identity across reclaim. Referenced Auth parents, studio and run must be ordered consistently before domain locks where those parents are needed. Audit actor IDs have no Auth foreign key; do not add staff/profile locks for audit display names.

Before adopting the complete order, verify changing-actor reclaim, deletion-first behavior, setup rank-insert triggers and ordinary program/rank writers. The initial probe validates only the stated cases. Avoid broad studio UPDATE locks and lock upgrades: V44 already demonstrated their danger to existing student writers. Preserve the current row RPC interfaces where practical, with the private owner performing compatibility reconciliation before recording success and the public wrapper doing no second write on replay. Finalize the setup packet and default-program trace before implementation.

## Assurance and exclusions

Extend the existing import-row and worker-claim SQL contracts. Prove failure after one committed row, a lost row response, preservation of later edits and deletion, exact cached outcomes, stale-worker rejection, tenant collisions, setup replay, and final-result warning consistency. Exercise the actual new functions in two-session tests after implementation. Replace the private-loop happy-path fixture with composed executor recovery coverage; remove obsolete failure expectations and redundant source checks rather than adding a test per observation. Retain meaningful authorization, rank and transaction coverage.

Use a forward migration and the existing attestation generator, preserving historical migration bytes and old verified consumers. Require local contracts, restore continuation, relevant application checks, a fresh independent reviewer and final-head CI before guarded merge. Do not change parser/status-alias policy, logical or displayed row numbering, existing UUID mappings, unrelated program management, provider behavior, production state or historical financial data. OPS2-11 and DC2-03 remain separate unless subsequent verification establishes a necessary dependency.
