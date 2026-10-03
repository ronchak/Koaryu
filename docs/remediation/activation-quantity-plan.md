# Activation quantity ownership

A subscription safety read could time out before any financial write, yet activation recorded an attempt and rejected the request as scheduled cancellation. Another enrollment could then activate. A new-key retry reused the first request's stale quantity: three active enrollments, provider quantity two, followed by a cancellation that refused the mismatch.

The correction belongs at the first-attempt boundary. Request identity stays fixed; V48 saves the execution branch, subscription/item identity and current seat count in the same transaction that records the first attempt. It uses existing enrollment metadata and provider operations. No new table or generic workflow layer is introduced.

New intents use version 2 and keep an execution entry per operation. Legacy version 1 hashes and attempted snapshots remain readable. A transient preflight read leaves `started` with zero attempts and returns a retryable 503. A confirmed closed subscription still rejects. Once attempted, recovery retains its original quantity and provider key. A different current subscription/item refuses recovery before another write.

The RPC checks the active scoped actor, enrollment, payer, plan, account generation, resource owner, operation identity/revision, operation lease and quantity token. Locks follow the existing group-before-enrollment/payer order. It also refuses another unresolved attempted activation in the group after a quantity lease expires. The existing policy-rejection cleanup accepts version 2 only under its unchanged empty-reservation checks.

Post-write verification independently counts the current linked seats before projecting success. It cannot certify a stale quantity merely because it matches the execution snapshot. The regression now writes quantities `[2, 3]`; the following cancellation succeeds and writes two.

## Verification and release

- Real PostgreSQL commit/rollback and competing-call proofs cover zero-attempt and post-attempt boundaries. Existing financial concurrency cases remain.
- Canonical and logical-restored V47 copies preserve every seeded row during migration. Continuation keeps the old request hash and stale legacy quantity while deriving three seats for its first actual attempt.
- The full migration/contract gate, versioned readiness, independent raw function/ACL checks and exact-head CI remain mandatory. Historical migration files are unchanged.
- The V47 backend remains readiness-compatible after V48. Pause serving writers for migration, then deploy backend before frontend. No historical financial backfill or live billing activation is included.
- The reviewed operator patch adds exact count/head readiness mappings for V47 and V48. Apply it to the private helper only after review; a fresh production backup and verified disposable restore are still required before production apply.

Implementation and local verification do not mean production has been migrated. The final release record owns deployed identity and execution evidence.
