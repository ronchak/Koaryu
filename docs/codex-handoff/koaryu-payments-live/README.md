# Koaryu Payments live-readiness implementation queue

Status: **review complete; implementation and launch gates remain open**

Audit snapshot: `main` at `1fe3b4631eddf0c04f600010b6dda3e5fbc8eece` on 2026-08-20.

This document is the reviewer-owned map for finishing Koaryu Payments. It does not authorize a live Stripe mutation, record a production checkpoint, grant a studio, enable a pilot, or claim that a canary has run.

Each linked execution item contains the complete standalone Codex assignment. A new Codex session should be pointed at exactly one item and told to close it. Do not implement the whole queue in one branch.

## Verdict

Koaryu Payments is not an unbuilt feature. The Connect account, customer, plan/price, setup Checkout, subscription grouping, invoice, payment, refund, dispute, webhook projection, and live-mutation interlock layers are substantial.

It is still unsafe to activate as a studio product today.

The main blockers are not missing Stripe primitives. They are permanent reconciliation evidence, workflow-level replay, payer-owned consent, ordinary cancellation semantics, operation-bounded authorization, role/capability alignment, and the deliberately hidden customer experience.

The correct path is six bounded workstreams, followed by a staging rehearsal and one attended production canary. The correct path is not to insert a `connect_payments` row and unhide every existing button.

## Execution queue

| Order | Execution item | Responsibility | Why it exists |
| --- | --- | --- | --- |
| 1/6 | [#105 Repair reconciliation and live-authorization checkpoint contract](https://github.com/ronchak/Koaryu/issues/105) | Version the reporter/checkpoint/RPC contract, move to a provider-supported rolling window with continuity evidence, and replace nonexistent webhook endpoint readback assumptions. | The fixed July 13 event window is now older than Stripe's retrievable Events history, while the Python, SQL, CLI, and verification contracts all require it. The reporter also expects a webhook-endpoint `connect` field Stripe does not return. A healthy production surface therefore cannot legitimately produce the checkpoint the live grant requires. |
| 2/6 | [PR #75 Reconcile the complete tuition billing lifecycle](https://github.com/ronchak/Koaryu/pull/75) | Rebase and close refund/dispute ordering, adjustment-before-payment projection, authoritative invoice balance, and v1 accounting semantics. | Provider events can arrive duplicated, delayed, out of order, or before the payment they adjust. The existing PR is the right owner, but it is based on old `main` and previously left refund/dispute accounting rules unresolved. |
| 3/6 | [#106 Make provider billing writes replay-safe and capture payer-owned autopay consent](https://github.com/ronchak/Koaryu/issues/106) | Add a durable workflow operation boundary, require stable request identities, reconcile ambiguous outcomes, and replace staff-attested consent with payer-owned versioned evidence. | Stripe-call idempotency is not the same as complete workflow idempotency. Local-first writes can strand ambiguous rows. The current staff confirmation can write payer terms and immediately enable autopay when a card already exists. |
| 4/6 | [#107 Replace generic enrollment mutations with named period-safe transitions](https://github.com/ronchak/Koaryu/issues/107) | Implement ordinary period-end cancellation, exact shared-family quantity behavior, revocation, and a separate Admin-only immediate cancellation. Keep undefined pause/resume/autopay-disable behavior closed. | The current cancellation primitive immediately cancels a whole subscription or changes item quantity. That is not ordinary paid-through tuition cancellation and is especially dangerous when a parent pays for multiple students. |
| 5/6 | [#108 Add operation-level launch capabilities and enforce the Payments role matrix](https://github.com/ronchak/Koaryu/issues/108) | Add exact operation allowlists to live grants, define one server-owned workflow catalog, return sanitized role-aware capabilities, and align every route with the locked Admin/Front Desk/Instructor policy. | One `connect_payments` scope currently authorizes every `connected_*` Stripe sink for the studio. A canary grant is therefore broader than it looks. The API/UI also collapse support, live readiness, and role authority into coarse booleans while most routine writes remain Admin-only. |
| 6/6 | [#109 Restore the narrow Payments UX and prove staged and live-canary readiness](https://github.com/ronchak/Koaryu/issues/109) | Restore only the supported Connect, plan, payer setup, enrollment, invoice/retry, refund, status, and period-end cancellation flows. Upgrade the exact-candidate rehearsal, product disclosures, runbook, monitoring gate, and canary validator. | The frontend correctly hides provider-backed actions today. The final work is to expose a narrow capability-driven product after the lower layers are safe, not to surface every dormant endpoint. |

## Dependency and merge order

The issue numbering is the review order, not a requirement that every branch be developed serially.

### Foundation

#105 and PR #75 may be implemented in parallel. They touch different primary concerns, but both must rebase onto current `main` and preserve the same connected-account/event identity invariants.

#105 must land before any new live checkpoint or operation-specific grant is recorded.

PR #75 must land before a launch PR relies on refund/dispute totals, authoritative balances, or terminal ordering.

### Workflow semantics

#106 and #107 may begin in parallel after their implementers read PR #75. They must coordinate on one durable billing-operation identity rather than creating competing replay frameworks.

#106 owns request lifecycle, same-key replay, ambiguous provider outcomes, payer-owned setup/consent, and operation status.

#107 owns the meaning and timing of enrollment cancellation, shared subscription quantity at the boundary, and which adjacent lifecycle controls remain unsupported.

Neither issue should restore the broad Billing UI.

### Authorization and product capability

#108 should consume the versioned authorization/checkpoint contract from #105 and the exact supported workflow names from #106 and #107.

It must land before #109. A UI built against one `connect_payments` boolean would recreate the same unsafe boundary under a better visual design.

### Launch surface

#109 is the integration and release-evidence workstream. It must rebase after #105, PR #75, #106, #107, and #108 are complete. If any dependency remains open, #109 may remain a draft but cannot be called merge-ready or launch-ready.

## Findings behind the queue

### The checkpoint gate is currently unsatisfiable

`backend/scripts/stripe_reconciliation_report.py` requires provider/local event equality beginning at `2026-07-13T00:00:00Z`. That date is also embedded in the active checkpoint and authorization SQL, operator tooling, verification SQL, and tests.

Stripe's Events API exposes a bounded recent history. A permanent one-time cutoff eventually becomes inaccessible even when Koaryu is healthy. Moving only the Python start date would not fix the database contract and would discard continuity.

The replacement must be versioned and additive. It needs a supported rolling window plus durable continuity across accepted checkpoints, not a weaker “some recent events were seen” check.

The reporter also classifies Connect webhook endpoints through `row.get("connect")`. Stripe accepts `connect` when creating an endpoint but does not return that field on the Webhook Endpoint object. The tests currently make the defect invisible by fabricating the field.

### The current studio grant is not a bounded canary grant

`stripe_mutation_scope()` maps every `connected_*` operation to `connect_payments`. The sink still performs valuable studio/account/generation/checkpoint/SHA checks, but it does not distinguish an invoice canary from customer, product, price, subscription, void, or refund access.

A future Stripe method added with a `connected_` operation name would inherit the scope unless the contract changes. The grant must persist exact canonical operations and default to none.

### Autopay consent is currently staff-created

The frontend asks a studio staff member to confirm that a payer accepted autopay terms and sends a boolean. The backend writes the acceptance timestamp before payer completion. If the payer already has a saved payment method, the same staff action can immediately enable autopay.

Studio staff may initiate a setup request. They cannot be the source of payer authorization evidence. The payer must accept versioned terms on a payer-controlled surface, and Koaryu may enable autopay only after consent plus payment-method completion converge.

### Individual Stripe idempotency keys do not make a workflow replay-safe

Plan, payer, enrollment, invoice, and autopay workflows combine local writes, multiple provider calls, projection, and audit. A lost response after provider success can leave Koaryu unable to answer whether retry means resume, reconcile, or duplicate.

The launch workflows need a durable operation row, normalized request hash, stable request key, account/generation binding, explicit reconciliation-required state, and same-result replay. An ambiguous response must never automatically issue a second provider mutation.

### Ordinary cancellation currently means immediate provider mutation

The existing detach primitive immediately cancels the subscription when the enrollment is last, or immediately resizes/deletes the shared item when others remain.

The launch product decision is narrower. Ordinary cancellation means stop billing at the verified paid-through boundary. It is reversible until then. Immediate cancellation remains a separately named Admin-only exception and never implies a refund.

For a family quantity, the effective transition must recompute the exact remaining enrollment count once. It must not touch another plan item, payer, studio, account generation, or replacement subscription.

Pause, resume, generic collection-mode changes, and disable-autopay remain unavailable unless they receive equally explicit semantics and recovery proof.

### The route matrix does not match the locked product policy

The repository already distinguishes billing Admin and routine billing staff. Most provider-backed routes nevertheless require Admin, while the locked pilot policy assigns ordinary billing work to Admin and Front Desk.

The initial supported matrix is:

- Admin and Front Desk may perform ordinary plan, payer, setup-request, enrollment, invoice/retry/reconcile, external payment, and period-end cancellation work when the workflow capability permits it.
- Admin alone owns Connect setup, plan archival, refunds, voids, disputes, immediate cancellation, sensitive exports, exceptional overrides, and operator/live-authorization actions.
- Instructor has no billing datasets or actions.
- Unsupported workflows stay unavailable even to Admin.

### The Billing UI is correctly dormant but cannot stay that way for launch

Plans and payer accounts are read-only. Enrollment creation is external/local only. Invoices are read/reconcile only. Hidden action hooks exist, but hidden code is not evidence that a workflow is supported.

The launch UI must consume server-owned capabilities and expose only the narrow v1 flow. It must report pending/reconciling states honestly, preserve a request key across retries, group family payers clearly, hide raw provider identifiers from the primary experience, and remain usable on 360×800 and 390×844 viewports.

### Provider rehearsal and operations need to match the actual product

The repository has a substantial test-mode provider rehearsal and validator. It must be upgraded to prove the final payer-owned consent, shared quantity, replay, operation grant, cancellation, refund/dispute, webhook, and 0.5% fee contracts against one exact candidate SHA.

The production sequence remains:

1. complete the exact-candidate staging rehearsal;
2. run production reconciliation read-only;
3. disposition the historical failed/unmapped event baseline privately;
4. record a fresh checkpoint for the exact deployed SHA;
5. verify the one pilot account/generation and zero ambiguous operations;
6. dry-run an exact-operation, short-lived grant;
7. perform one attended low-dollar recurring canary with unambiguous 0.5% fee cents;
8. verify provider and local projections, then explicitly refund/clean up;
9. revoke the grant immediately;
10. run post-canary read-only reconciliation.

Rollback means closing new writes and preserving reconciliation. It does not mean deleting provider objects, resetting Connect, disabling webhooks, erasing evidence, or blindly retrying an ambiguous call.

A short attended canary may use active human monitoring as a temporary compensating control. A real studio must not remain enabled until payment webhook/reconciliation alerts have a real destination, owner, acknowledgement path, and rehearsed delivery lifecycle.

## Cross-workstream invariants

Every implementation PR must preserve these rules.

- No live Stripe or production Supabase mutation in tests, CI, or implementation verification.
- Additive migrations only. Historical migrations remain immutable.
- Studio, connected account, and account generation are authoritative boundaries.
- `LIVE_BILLING_ENABLED=true` alone authorizes nothing.
- A UI capability is a hint. The route and Stripe sink re-evaluate authoritative state.
- Unknown, ambiguous, stale, mismatched, or unsupported states fail closed.
- No automatic second mutation after an ambiguous provider outcome.
- No raw provider payloads, secrets, card data, hosted URLs, or live customer evidence in git, logs, or broad audit records.
- Payment failure does not change training, attendance, or roster status.
- Refund, dispute, cancellation, void, and collection retry are separate product actions.
- The approved Koaryu Payments fee remains 50 basis points unless a later explicit pricing change says otherwise.
- A successful canary does not automatically enable an ongoing pilot.

## Definition of implementation complete

The code phase is complete only when all six execution items are merged on current `main`, each final PR reports current full-suite and targeted proof results, and #109's exact-candidate rehearsal validator passes with private staging evidence.

The repository must still default to no ongoing studio live-payment authorization.

## Definition of canary complete

The attended canary is complete only when the exact operation grant is revoked, the application fee and all provider/local objects are reconciled, the cleanup/refund outcome is known, the post-canary report is eligible, and no operation remains failed, stuck, unmapped, wrong-mode, wrong-generation, or reconciliation-required.

## Definition of pilot enabled

Pilot enablement is a separate director decision after canary completion. It requires approved product/consent language, named support ownership, active payment alerts, retention/redaction decisions, and a new bounded ongoing operation grant for the named pilot studio.

## Review limitations

This review inspected repository code, tests, migrations, documentation, open work, and current `main` through GitHub. It did not clone and execute the repository locally, access private production Stripe/Supabase data, validate current provider dashboard configuration, record a checkpoint, or move money.

The prior production verification described in repository documentation may be useful evidence, but every production fact must be re-read through the versioned read-only preflight before a canary.
