# Invoice local-closeout plan

This change addresses BB1-07 and supporting BT2-01 from `main` at `9988c6265c04ab6621dda4c468de6d21af143bc4` after PR161 merged. It is independent of the held delinquency, family allocation and external-note decisions. Existing rank frontend ownership remains open. No future PR number is assumed.

Root reproduced the failure on the unchanged invoice implementation using the real invoice manager and operation coordinator with existing local provider/RPC doubles. An injected payer-balance outage leaves both create and payment retry completed; same-key replay returns success without another balance attempt. The stale sentinel balance remains 123456. Each case made one provider mutation and one audit. This is Python orchestration evidence, not a new PostgreSQL concurrency proof.

The implementation boundary is invoice creation and payment-retry local closeout in billing_invoice_operations.py. Preserve all provider claims, durable steps, consent/ownership checks, projection verification, exact actor/account/generation binding and existing balance calculations. Finalize/void and unrelated payment commands remain separate unless verification exposes a necessary shared dependency.

After a valid local invoice projection, finish deterministic audit insertion and the existing payer-balance recomputation before completing a nonterminal operation. Validate the response before marking completion where practical. Use one explicit invoice-closeout owner for these two operation kinds if it reduces repeated sequencing; do not build a workflow abstraction or change the database state machine.

The projected replay path must perform the same local closeout without a provider read or mutation. The completed replay path must also repair audit/balance, because historical completed rows do not prove that either succeeded. It must preserve terminal state/revision and never repeat complete on a completed operation. This necessary repair read is not an invitation to redesign reporting or balance semantics.

Separate retry projection verification from local closeout. A failure after projection succeeds must remain a local projected operation, rather than being caught by the existing provider_succeeded broad projection handler and moved to reconciliation_required. Real provider/projection ambiguity continues to use the current reconciliation path. Preserve CAS/lease enforcement on completion; a completion failure leaves the original key available to resume through the normal claim path. No force completion or terminal rewind.

Review identified a specific existing retry claim behavior: a valid projected or
provider_succeeded V33 resource replay can retain another unexpired lease and
return outcome=replay. Moving the busy-outcome check alone is insufficient.
Before either branch performs local work or provider projection, require the
returned lease_owner to equal the newly acquired context lease. Otherwise return
the existing concurrent/ambiguous refusal without side effects. Completed replay
is exempt. Keep reconciliation_required adoption and true ambiguity behavior
unchanged; do not apply a blanket condition to a different recovery protocol.
Add a valid scripted V33 replay envelope for both foreign-lease states, because
the current shared fake reports busy where this real SQL path reports replay.
Test normal lease expiry with the existing clock, not forced revision/lease edits.

Prove actual persisted payer balance and one original-actor audit after same-key replay, with no second provider mutation. Cover audit and balance outages for create/retry; projected offline resumption; historical completed rows with stale/missing local facts; lost completion response after durable completion; and existing foreign scope/changed request/provider ambiguity controls. Use the production balance method for the focused fixture, not a copied balance algorithm. Keep claims about PostgreSQL isolation with the unchanged SQL contracts.

Assess adjacent tests for duplicated or misleading assertions. Existing happy-path create/retry tests should use actual balance state rather than a never-asserted counter. Consolidate overlapping success/replay coverage into the new focused groups only if the durable step, identity, old-key, consent and provider-call assertions remain. Do not remove distinct financial safety tests to hit a count target. No regression test per changed line.

Focused invoice tests precede the complete backend suite, API contracts and the exact-head release gate. No migration or generated response change is planned. Root owns all edits; an independent reviewer must approve the plan and candidate, with final review bound to the committed head. Main must stay healthy, and no hosted operation is part of this PR.

Independent plan review gave GREEN LIGHT after verifying the narrow acquired-lease
guard against the actual SQL claim chain. Implementation starts from the merged
rank-history main. No migration or hosted action is part of this step.
