# Tuition currency verification

The candidate enforces the settled USD rule at new price, enrollment-activation and invoice-creation boundaries. It preserves historical confirmed records, completed replay, original provider keys and the existing handling of attempted or uncertain work. Product-only maintenance may reuse an exact historical non-USD price. A product created before an interruption does not authorize a never-attempted non-USD price.

The unused `_sync_plan_price` writer, its forwarding chain and orphaned price lookup are removed. Repository-wide caller inspection found no command caller beyond those wrappers. Public synchronization already uses the durable workflow. Its interval helper, generation adoption, projection CAS and recovery boundaries remain.

## Checks

- Focused price, activation and invoice tests: 338 passed.
- Full backend suite: 1,906 passed, with 5,473 subtests.
- Generated API contracts: unchanged and verified.
- Actual PostgreSQL 17 on all 139 unchanged main migrations: four rejection paths passed. Fresh and registered unattempted parents reject with zero provider attempts. A confirmed product with an unattempted price retains its evidence and moves to reconciliation. Direct price-step rejection likewise preserves the product and zero price attempts. Historical plan rows remain unchanged.
- No provider requests or hosted database actions were used for verification. Final-head CI and a fresh independent reviewer remain required before merge.

The first SQL probe reused provider keys across different synthetic operations and correctly hit the idempotency guard. The corrected fixture then exposed a redundant completion call after step rejection: SQL already updates the parent revision and reconciliation state. The new guard no longer makes that redundant call. The final four-case proof passed on a separate disposable cluster, which was removed.

## Test maintenance

Six legacy-audit cases now share one behavioral test. Three activation branches share their owner, replay and lock-release proof, including exclusion of detaching family members from quantity. The price success/replay test also covers alias adoption instead of duplicating that workflow. Invoice due-date forwarding remains in the success test; malformed date and non-USD intake share the rejection test. Two unused test helpers that copied invoice hashing are removed. The active hash contract test remains.

The shared fake previously omitted the three parent fields created by SQL step-plan registration. That omission hid saved step history from the currency preflight. It now records those fields. This is a bounded fixture correction, not a replacement SQL state machine. Real SQL verifies the new rejection sequences; existing SQL and concurrency contracts retain their role.

Authored test files shrink by 42 lines but grow by 7,073 bytes because the new historical-receipt fixtures contain more explicit data. The number of test functions is unchanged; parameterized cases add assurance at the new financial boundary. This is not a claim that total test volume fell by every measure.

## Remaining work

BB2-04 stays pending until this candidate is reviewed and merged. PROGRAM-CURRENCY-01 remains pending for truthful mixed/unknown-currency totals and provider-fact recovery. BB2-08 must still stop inventing monthly/USD facts. Existing invoice management and historical amounts are not rewritten. No schema migration, deployment, mail/DNS change or financial backfill is part of this candidate.

Private logs and failed probes are under `Koaryu Remediation/2026-09-07/currency-intents`.
