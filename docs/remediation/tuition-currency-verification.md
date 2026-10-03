# Tuition currency verification

PR179 merged as `7113d130a1523d5048cb9cb15529aed6277a4770`, from reviewed head `08acb81e2b8232b677a14812aa3950d2a76890c5`. It enforces the settled USD rule at new price, enrollment-activation and invoice-creation boundaries. It preserves historical confirmed records, completed replay, original provider keys and the existing handling of attempted or uncertain work. Product-only maintenance may reuse an exact historical non-USD price. A product created before an interruption does not authorize a never-attempted non-USD price.

The unused `_sync_plan_price` writer, its forwarding chain and orphaned price lookup are removed. Repository-wide caller inspection found no command caller beyond those wrappers. Public synchronization already uses the durable workflow. Its interval helper, generation adoption, projection CAS and recovery boundaries remain.

## Checks

- Focused owner checks passed; the final invoice file passed 246 cases.
- Full backend suite: 1,908 passed, with 5,473 subtests.
- Generated API contracts: unchanged and verified.
- Actual PostgreSQL 17 on all 139 unchanged main migrations: five rejection paths passed. Fresh and registered unattempted parents reject with zero provider attempts. A confirmed product with an unattempted price retains its evidence and moves to reconciliation. Direct price-step rejection likewise preserves the product and zero price attempts. An empty provider invoice moves to reconciliation while both monetary items remain unattempted. Historical plan rows remain unchanged.
- No provider requests or hosted database actions were used for verification. All eleven final-head checks passed, the dedicated fresh reviewer approved the final correction, and the guarded merge read production Render auto-deploy as off twice. The main tree matches the tested candidate.

The first SQL probe reused provider keys across different synthetic operations and correctly hit the idempotency guard. The corrected fixture then exposed a redundant completion call after step rejection: SQL already updates the parent revision and reconciliation state. The new guard no longer makes that redundant call. The final five-case proof passed on a separate disposable cluster, which was removed.

## Test maintenance

Six legacy-audit cases now share one behavioral test. Three activation branches share their owner, replay and lock-release proof, including exclusion of detaching family members from quantity. The price success/replay test also covers alias adoption instead of duplicating that workflow. Invoice due-date forwarding remains in the success test; malformed date and non-USD intake share the rejection test. Two unused test helpers that copied invoice hashing are removed. The active hash contract test remains.

The shared fake previously omitted the three parent fields created by SQL step-plan registration. That omission hid saved step history from the currency preflight. It now records those fields. This is a bounded fixture correction, not a replacement SQL state machine. Real SQL verifies the new rejection sequences; existing SQL and concurrency contracts retain their role.

Authored test files shrink by 31 lines but grow by 7,875 bytes because the new historical-receipt fixtures contain more explicit data. The number of test functions is unchanged; parameterized cases add assurance at the new financial boundary. This is not a claim that total test volume fell by every measure.

## Remaining work

BB2-04 is fixed by the merged change. PROGRAM-CURRENCY-01 remains pending for truthful mixed/unknown-currency totals and provider-fact recovery. BB2-08 must still stop inventing monthly/USD facts. Existing invoice management and historical amounts are not rewritten. No schema migration, deployment, mail/DNS change or financial backfill is part of this candidate.

Private logs and failed probes are under `Koaryu Remediation/2026-09-07/currency-intents`.

Root verification after the initial independent approval reproduced an empty-header gap at `a1ce2ec`: retry created two new EUR items despite neither monetary item having been attempted. The guard now distinguishes header work from financial item work. A corresponding positive case completes the original remaining item after a prior monetary item succeeded, preserving its currency and provider key. The dedicated reviewer independently reproduced that regression, approved the correction, and later approved the readiness explanation on the final head. Fresh CI passed on that final head.

The plan response now applies the same USD predicate to its existing readiness flag and reason. A historical non-USD plan stays active with its original price, while the existing plan UI receives an explanation that new tuition requires USD. The final price/read-page checks cover both supported USD readiness and the preserved historical EUR response. No API fields or frontend logic were added.
