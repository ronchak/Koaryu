# Invoice closeout and payer-balance verification

[PR #162](https://github.com/ronchak/Koaryu/pull/162) remains unmerged pending final
commit-bound review and exact-head CI. Its earlier Python-only checks do not
certify this expanded candidate. BB1-07 and BT2-01 are fixed in this candidate;
merge and deployment status are separate.

Invoice creation and payment retry previously marked the operation completed
before audit and payer-balance work finished. Same-key replay could then return
success while leaving a stale balance. A shared closeout now writes the original
actor's deterministic audit, recomputes the balance, validates the response, and
only then completes an owned projected operation. Historical completed replay
repairs local facts without another provider mutation, reopening the receipt, or
changing its terminal revision.

Retry projection returns the current operation revision. Later audit or balance
errors remain local failures; genuine provider ambiguity retains reconciliation.
A projected/provider-succeeded retry replay must hold the lease returned by SQL
before doing work. Saved projected or completed creation replay permits subsequent payment or voiding
without dropping the request, provider, item, account, generation or original-total
checks. First-time creation projection still requires the original unpaid balance.

A subsequent review identified the same lifecycle issue for projected receipts.
An audit/balance failure leaves creation projected, while independent invoice
commands or webhooks can legitimately advance it. Requiring the original unpaid
balance on that replay falsely sent it to reconciliation. The existing paid/void
failure cases reproduce this against commit `e673344`; saved-projection replay now
permits that progress. Initial projection and all identity checks stay strict.

The initial implementation's balance repair had a real race: one replay read 7,400,
a concurrent payment wrote 0, and the replay overwrote it with 7,400. V41 replaces the
shared Python SELECT/calculation/UPDATE with one required service-role RPC. The
function locks the payer matching both studio and payer IDs, then uses a separate
MVCC statement to sum invoice balances and update that payer. It takes no invoice
row locks. READ COMMITTED is required; stronger transaction isolation is refused
before writes. Missing scoped payers remain no-ops and errors propagate.

This PR preserves the current balance formula, including its status set and
explicit zero handling. Wide intermediate arithmetic retains an error if the
existing integer balance column overflows. The settled overdue, family-attribution
and provider-reconstruction policies will be implemented separately. It introduces
no historical financial backfill or new provider operation.

## Evidence and test changes

- Baseline fault/replay cases demonstrate premature completion and skipped balance
  repair. The corrected orchestration covers audit/RPC/completion failures, durable
  completion with a lost response, valid later lease acquisition, and refusal of a
  foreign lease before local or provider work. Paid, void and partially paid
  completed-create replays fail the prior candidate and pass the correction.
- Python fakes acknowledge only the named balance RPC, with explicit scoped
  callbacks where ordering matters. They do not duplicate its SUM algorithm.
  Orchestration assertions prove a balance acknowledgement in the current attempt
  before completion. Formula and tenant-scope assurance live in real SQL.
- The SQL contract runs as service_role with legal rows and explicit expected
  totals. It covers included/excluded statuses, zero and negative contributions,
  empty and missing payers, another payer and studio, more than 1,000 invoices,
  future/no-date preservation, overflow, transactional failure, and browser-role
  denial. The actual remaining-balance column is NOT NULL; no constraint is
  disabled to invent a null fixture.
- Separate real sessions prove a waiting recomputation sees a preceding committed
  payment, sees the original facts after rollback, and permits an independent payer
  to progress. Observed blocking PIDs establish the intended lock ordering. An
  invoice-owning transaction does not block the balance command's ordinary read.
  One-time controlled SUM-before-lock and invoice-lock mutants fail their intended checks.
- Actual canonical and logically restored V40 copies upgrade to V41 with identical
  retained payer/invoice/operation/audit and supporting rows before explicit repair.
  The explicit command changes only the intended payer balance/status and normal
  timestamp; an old completed receipt replays without changing persisted facts.
  Sources remain V40 and all owned databases and dump files are removed.
- Full V22 and V21/V20/V19/V18 compatibility match their exact tuples. Existing
  semantic values and V40 catalog/rank evidence remain unchanged. The new raw
  writer digest is measured independently from catalog definitions and complete
  explicit EXECUTE ACL entries. Ten isolated function/privilege/overload mutations must fail
  both raw evidence and all five readiness consumers, then restore the exact
  baseline after rollback.
- The final full backend passed 1,897 tests plus 5,450 subtests. Focused invoice
  verification passed 290 plus 15 subtests; expanded local-target refusal checks
  passed 3 tests. The permanent restore, SQL and concurrency entrypoints passed on
  disposable PostgreSQL 17. The complete integrated runner passed all 136 migrations and 51 contracts,
  retained restores, attestation negatives and concurrency checks. Release-workflow
  checks passed all 130 tests. Generated API contracts remain unchanged.

Two duplicate service retry tests were consolidated, one source-name allowlist
and an unused broken fake hook were removed, and paid-response assertions were
corrected. The incorrect projected-balance-corruption case was removed, and existing
audit/balance failure cases now include later paid/void progress without adding
cases. The old Python balance-algorithm test was replaced by a scoped adapter
contract; SQL owns the arithmetic. Three low-level refund/dispute cases correctly
assert that those helpers leave payer state unchanged rather than pretending they
perform recomputation. A release-tool source-text test was removed: the retained
metadata acceptance/rejection matrix and read-only query tests cover its contract.
The independent optional-column allowlist assertion remains in the behavior test.
BT2-03/06/07 are addressed; the broader BT2-04 cleanup remains partial. Test growth
elsewhere in the program remains a separate problem, not a claimed achievement.

## Release and limits

The new migration is `20260908183744_serialize_billing_payer_balance_v41.sql`,
SHA256 `c8471ad12c1f534d0fe216a7f77db4c0dcfab1e1cc8f75075a2d6683fbc65ab7`.
All 135 earlier migration files are unchanged. Current readiness requires
136/head 20260908183744 and release-db-attestation-v41. The one inherited whitespace
line 474 is retained inside the copied, attested preflight body; it is the sole
`git diff --check` exception, not a changed whitespace rule.

The concurrency guarantee starts when every serving backend and worker uses the
RPC and old split operations have drained. Database-first compatibility does not
serialize an older application's later direct update. Recalculation remains a
follow-up to invoice projection: a crash before that request still needs replay or
worker repair. Post-migration application rollback can restore the old race even
though its readiness interface remains compatible.

This evidence is local and synthetic. No hosted payment, production migration,
backfill or deployment was performed. Production apply remains human-only with
fresh candidate-bound inspection, backup and approval evidence. One fresh reviewer
receives the final diff and this PR's plan without the previous reviewers' history.

## Dependency prerequisite and rebase

CI on 0eeed52 passed the database, backend and other release components, but the
frontend dependency audit reported high/critical Next.js/Sharp advisories. PR163
resolved that independent gate failure and merged as 6901f71. PR162 now starts
from that patched main. Its invoice/V41 production code, tests and SQL/helper
inputs are byte-identical to the reviewed 0eeed52 candidate; the patched frontend
is inherited unchanged. Tracking records were reconciled separately. Fresh review
binding and exact-head CI on the rebased candidate remain required.
