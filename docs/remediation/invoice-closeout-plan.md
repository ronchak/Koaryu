# Invoice balance repair: amended PR162 plan
Status: completed in PR162, merged as `66e8240a5d4ed3a21af74e60ee6aa8574cd9c703`.
The plan below records the reviewed boundary; final evidence is in
[invoice-closeout verification](invoice-closeout-verification.md).

PR162 must remain unmerged until its new repair calls cannot overwrite newer payer balances. The coordinator and independent reviewer reproduced the issue and accepted the review comment on technical merit. The completed-create lifecycle correction is a separate approved stage already implemented locally. External-payment/plan transactions remain subsequent work.

## One balance owner

Add one service-role-only required RPC, provisionally recompute_billing_payer_balance_v1, over existing tables. Use VOLATILE PL/pgSQL with explicit schema names and a fixed search path. Lock exactly the payer matching studio and payer IDs, then issue a separate ordinary MVCC invoice SUM after that lock is acquired, then update only balance_cents/billing_status under the same transaction. Require READ COMMITTED and reject other isolation levels before writes; do not change isolation inside the started call. No invoice, operation or consent row locks. This preserves invoice-to-payer locking used by existing billing claims and avoids the inverse lock edge.

Keep the current formula exactly: draft/open/uncollectible/partially_refunded; explicit remaining including zero, otherwise nonnegative due-minus-paid with nulls treated as zero; clamp each contribution to zero; sum all matching invoices; empty sum zero; current iff zero else past_due. Use wide intermediate arithmetic, preserving overflow failure on the current integer balance column. Do not add dates, currency allocation or overdue policy. Null payer remains an application no-op; missing scoped payer remains a no-op rather than touching another tenant.

BillingPayerManager becomes a thin required-RPC adapter. All current Python recomputation callers already delegate to it. Remove its split SELECT/calculation/UPDATE; no deployment fallback. The RPC return contract should fit the existing void application helper and make errors propagate, with the exact signature/result type included in readiness. Preserve caller behavior and response schemas.

## Assurance ownership

Move balance arithmetic assurance to a real SQL contract with explicit expected totals, all statuses/legal null/zero/clamp cases, no-date and future-date preservation, no rows, tenant/payer scope, missing payer, privileges, rollback and overflow. Add deterministic separate-session proof: wait for the exact payer blocker before releasing a transaction that commits paid facts; the later SUM must see that commit. Prove the RPC's MVCC read does not block on an invoice row held by the existing opposite-order owner. Confirm separate payers progress independently. A deliberately stale-snapshot/incorrect-lock variant should fail its intended proof; elapsed time alone is not evidence.

Python tests prove call/order/recovery/lease contracts rather than reimplementing SQL totals. Reuse strict named RPC dispatch with one small billing-specific canned/scripted handler. Do not add a SUM algorithm or generic success fallback. Adapt the shared billing lifecycle fake, invoice-operation fake and payer fake. Supply explicit scoped acknowledgements/failures for closeout tests and assert the named RPC ran before completion. Replace the old payer formula unit test with adapter/no-op/error checks, retaining the formula in SQL. Strengthen or remove zero-start balance assertions that would pass a no-op. Keep existing financial, consent, tenant and provider tests.

## Additive forward release

Derive the exact next timestamp/version from current merged main and preserve all135 prior migration hashes. The expected new release is136/V41 with fullV22 and a V21 compatibility adapter; V20/V19/V18 bodies should remain unchanged. The new RPC is additive and absent from existing V16/V17/V18 inventories. Existing critical/operational/student manifest values should stay unchanged, but canonical/restored execution must prove that expectation.

Independently attest the new function definition, owner, exact signature/return, volatility, search path and EXECUTE grants in full readiness and raw release evidence. Never classify this write RPC as a STABLE billing read. Preserve historical exports/catalogs, approved canonical-versus-restored differences, exact pending/history tuples and all human-only production gates. Update the local verifier, restore continuation, backend readiness and release-tool fixtures only as required by this new release. Use actual disposable PostgreSQL17; no hosted SQL.

Rehearse actual V40 backup/restore/forward upgrade with retained invoice/payer facts, current formula/replay continuation and old readiness consumers. Keep the existing historical restore proofs. Compare full seeded payer/invoice/operation/audit rows before and immediately after the forward migration, before explicitly invoking repair, to prove there is no backfill. Required drift negatives must invalidate current/compatibility readiness or the independent raw gate as appropriate, then recover the exact baseline after rollback. Reuse existing local tools without adding a new infrastructure framework.

## Rollout and completion limits

The guarantee starts after every serving backend/worker uses the RPC and old split operations have drained. A database-first interval with old Python callers can still overwrite a newer result. Do not add broad triggers or pretend compatibility solves that interval. Balance recomputation remains a follow-up to invoice projection: a crash before requesting it still needs replay/worker repair. This correction serializes competing recomputations; it does not move every invoice mutation into one giant transaction.

After independent review of this plan, implement and review core SQL/proof, then forward attestation/restore integration, then the application adapter/meaningful tests and full candidate checks. Re-review any changed stage. Rewrite PR162 around the final invoice-accounting behavior, read substantive bot feedback, resolve both original threads only after verification, require fresh exact-head CI, and merge through the unchanged guard. No production apply/deployment or automatic historical backfill is authorized by this work.

Independent amended-plan review gave GREEN LIGHT. Current amount_remaining_cents
is NOT NULL; preserve the old fallback expression but do not disable required
constraints to manufacture a runtime null case. All fixtures must obey the current
verified schema.

## Projected replay correction

Subsequent review reproduced ordinary provider progress while a create operation
remains projected after audit/balance failure. Creation uses a generic operation
claim, so independent finalization/void commands and webhook projection can advance
the invoice before local replay. The saved projected receipt already follows strict
initial projection validation. Both projected and completed loads must verify the
original command/provider/item identity without requiring the original unpaid
balance. Fresh `_project_invoice_results` remains strict. Reuse the existing local
failure cases with later paid/void progress; remove the test that incorrectly calls
that progress corruption. No SQL or financial-definition change is needed.
