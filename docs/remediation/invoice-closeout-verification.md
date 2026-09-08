# Invoice local-closeout verification

[PR #162](https://github.com/ronchak/Koaryu/pull/162) addresses BB1-07 and supporting
BT2-01, which describe one incomplete workflow. Invoice creation
and payment retry could mark the operation completed before audit and payer
balance work finished. Completed replay repaired the audit but skipped balance.
The same key could therefore return success while the old balance remained.

The unchanged main implementation reproduces this for both commands. A local
balance outage leaves completed state, and replay returns draft/paid respectively
without another balance attempt. A deliberately stale balance of 123456 remains.
Each case makes one provider mutation. This does not mean Stripe charged twice.

The correction has one local-closeout owner for these two commands. It verifies
the local invoice as before, writes the deterministic original-actor audit,
recomputes the payer's current balance, validates the response and then completes
an owned projected operation. Historical completed replay performs the same local
repair without another completion call or changing its terminal identity/revision.
The existing financial definitions, consent checks, account/generation binding,
request identities and provider-operation state machine remain intact.

Retry projection returns its latest operation revision before local closeout.
Audit or balance failure after that point stays local instead of being classified
as provider ambiguity. Actual provider/readback/projection ambiguity retains the
existing reconciliation path. Completion still uses SQL's lease and revision
checks; the application never forces a new revision or reopens a terminal record.

Review identified an important claim detail. A valid V33 resource replay can
return projected/provider_succeeded while another request owns the lease. The
retry now verifies returned lease ownership before either branch performs work.
Completed replay is exempt, and reconciliation adoption keeps its existing rules.
A still-owned failed operation may need its existing lease to expire before the
same-key retry can finish. This change introduces no new lease-release protocol.

Local evidence:

- All 12 new cases fail with the byte-identical main invoice workflow and pass the
  correction. A private pytest plugin substitutes only that original workflow
  class into the current invoice manager, keeping the same tests and fixtures.
  Ten failures concern premature completion or stale balances; the foreign-lease
  cases fail at the completion lease assertion or return 503 instead of the
  required 409 refusal before work refusal. No baseline code was edited in the repository.
- Audit-insert and actual payer-write failures for create/retry leave projected
  state. A valid later claim finishes locally without more provider reads or
  writes. Historical completed repair includes a later same-payer invoice,
  another payer and another studio, proving the current total and scoped update.
- Failure before completion and a lost response after durable completion converge
  on one original-actor audit and one provider mutation. Completed repair calls
  no completion RPC. Nonterminal completion passes the current revision and owner.
- Both valid foreign-lease replay states reject with the expected 409 before local
  writes, provider reads or completion. An acquired lease with the same replay
  outcome succeeds, so replay itself is not incorrectly rejected.
- Focused invoice operations/lifecycle suites pass 287 tests and 15 subtests after
  final test refinements. The full backend passed 1,895 tests and 5,447 subtests
  before those test-only refinements and one source-test deletion. API
  contract generation check passes without generated changes. Independent plan, code, test and final cross-system review approved commit
  `fa641b37b3cddca9bf02eaa27d25858a9b3b6618`. Its deterministic performance gate
  also passed. Exact-head CI and guarded merge remain required.

These are Python orchestration tests using real managers/coordinators and the
production payer-balance method, with existing provider/RPC doubles. They are not
new PostgreSQL race or hosted-payment evidence. The shared fake does not fully
model create lease transfer or retry lease validation. Tests therefore script a
valid create acquisition response, explicitly assert completion revision/owner,
and retain the certified V33 envelope while reproducing the real replay outcome.
Existing database contracts and the required complete release gate remain intact.

Two duplicate BillingService retry tests were folded into retained canonical-key
and completed-replay cases, retaining their audit and provider-attempt assertions.
The retained tests now assert real payer balances and both paid response values.
A misleading new-key recovery name was corrected. Another test now reaches a
projected operation through a failed completion call and clock expiry instead of
rewriting a completed row's state. Distinct consent, tenant, account/generation,
changed-key, step, projection-corruption and genuine provider-ambiguity tests stay.
A source-name allowlist test was removed while its behavioral matrices remain; the
unused fake classifier referencing an undefined exception was also deleted. These
changes close BT2-03/06/07. The broader stale-name/fixture finding BT2-04 is partial.

The delinquency definition, family invoice allocation, external-payment receipt
retention and missing historical external-payment actor evidence remain separate
open work. This correction changes execution of the existing balance calculation,
not its business policy. No migration, hosted payment, backfill or deployment is
part of this change.
