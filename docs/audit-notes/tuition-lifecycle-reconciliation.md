# Tuition lifecycle reconciliation evidence

> Evidence date: 2026-07-27. This proof uses local provider fakes only. It does not enable live billing, create or modify Stripe objects, charge or refund money, change webhook endpoint configuration, or rewrite production billing data.

## Disposition

Koaryu remains **CONTRACT ONLY** under `docs/billing-boundary.md`.

The supported production surface remains:

1. Admin and Front Desk read billing state.
2. Admin and Front Desk attach an external-only local billing record to a student.
3. Admin and Front Desk record a payer-level external payment.
4. Admin and Front Desk reconcile an existing Stripe-linked invoice through a provider read.

Provider-backed enrollment, invoice mutation, payment retry, cancellation, refund, dispute response, and export actions remain hidden or unavailable in live UI. Inbound signed webhooks may continue to project existing provider state. Live outbound mutations remain fail-closed.

This investigation closed three technical projection gaps without broadening that product boundary:

- refund rows affect paid totals only after Stripe reports `status=succeeded`; pending, failed, canceled, and delayed nonterminal updates do not reduce the receivable;
- won disputes and inquiry/warning states no longer leave a payment disputed, while active or lost chargebacks continue to reverse the payment projection;
- the UI `Open Balance` now uses authoritative `amount_remaining_cents` for every balance-bearing invoice state used by the backend.

## Source and authority map

| Surface | Stored state | Authoritative input | Writer | Recovery and convergence | User-visible contract |
| --- | --- | --- | --- | --- | --- |
| External enrollment | `student_billing_enrollments` | Validated local request plus same-studio student/plan/payer rows | Service-role backend | Partial unique index prevents a second pending/active assignment; refresh reveals the committed row after an ambiguous response | Local attachment only; never reports Stripe setup |
| Provider enrollment/subscription | Enrollment plus `billing_subscriptions` and Stripe references | Stripe subscription and item snapshots | Hidden Admin route and signed Connect webhooks | Deterministic Stripe idempotency keys, pending metadata, quantity-sync RPC lease, webhook/reconciliation projection | Hidden live; preview is decorative |
| Invoice | `billing_invoices` and `billing_invoice_items` | Stripe snapshot for linked invoices; local request for unlinked draft construction | Hidden Admin routes, signed webhooks, read reconciliation | Request hash/key for create; Stripe event watermarks; read reconciliation | Existing invoice read and reconcile only |
| Payment | `billing_payments` | Stripe PaymentIntent/charge state, or an explicit local external-payment request | Signed webhook projector or local external-payment route | Unique provider references, event ordering guards, payer-level request key/hash | Payment history and bounded UTC-month cohort |
| Refund | `billing_refunds` plus cumulative successful amount on payment | Stripe Refund status | Hidden Admin route and signed Connect events | Upsert by provider refund ID; terminal-status regression guard; late payment projection back-links an earlier refund by account and charge; recompute from all succeeded refund rows | No live refund control; projected status is visible indirectly through payment/invoice totals |
| Dispute | `billing_disputes` plus derived payment/invoice/payer state | Stripe Dispute status | Signed Connect events | Upsert by provider dispute ID; terminal-status regression guard; recompute across every dispute for the payment | No dispute-response control; affected payer balance is visible |
| Webhook claim | `stripe_events` | Signed Stripe event ID, account, mode, type, and payload | Webhook worker RPCs | Atomic claim/lease and compare-and-set finish; processed duplicates do not project twice; stale work can be reclaimed | Hidden system trace |
| Payer balance | `billing_payers.balance_cents` and `billing_status` | Sum of `amount_remaining_cents` for draft, open, uncollectible, and partially-refunded invoices | Backend recomputation after relevant projection | Deterministic recomputation | Failed-payment queue and family balance |
| Payment cohort | Computed, not stored | Payments processed in the selected UTC month, net of cumulative succeeded refunds | Read service | Full paginated query, independent of the 200-row payment list | Explicitly not cash movement or period-net revenue |
| Overview open balance | Computed, not stored | The same balance-bearing invoice states and `amount_remaining_cents` used by backend balance recomputation | Frontend page model | Refresh from current invoice list | Labeled `Open Balance` |
| Actor audit | `audit_logs` | Accepted local action or completed provider-read action | Service-role backend | External-payment replay suppresses duplicate audit; other domain write/audit pairs are not one transaction | Hidden operations evidence |

Provider fields are authoritative when a Stripe-linked object is reconciled. Local state is authoritative for external-only attachments and payer-level external payments because those operations intentionally have no provider object. A visible success never upgrades a local-only operation into a provider success.

## Transition matrix

| Transition | Source to target | Role and tenant boundary | Idempotency and atomicity | Webhook, retry, and ordering behavior | Audit and visible state | Current disposition |
| --- | --- | --- | --- | --- | --- | --- |
| External enrollment | No active matching assignment to `active/external/externally_paid` enrollment | Admin or Front Desk; authoritative `staff_roles`; student, plan, and optional payer must share studio | Database uniqueness is authoritative. Duplicate returns `409`, not replayed success. Enrollment and actor audit are separate writes | No provider event | One `billing.student_enrollment_created` after insert; UI says external-only | Supported `LOCAL-ONLY` |
| Provider enrollment | Pending local enrollment to Stripe subscription/item and active local projection | Admin only route; same-studio references; Instructor denied before service | Deterministic provider keys; quantity RPC lease; pending attach metadata precedes provider mutation. Multi-row local/provider operation is not one transaction | Signed subscription/invoice events and explicit reconciliation converge | Actor audit after service completion; live control hidden | Test-mode implementation only; live `FAIL-CLOSED` |
| Invoice create/finalize | Valid payer/items to local invoice/items and Stripe draft/open invoice | Admin only; item student/enrollment/plan references checked before claim | Create key plus canonical request hash; provider calls use derived keys. Local invoice/items/provider/audit are not one transaction | Invoice webhooks and read reconciliation repair projection | Hidden live; preview does not mutate provider | Unsupported live |
| Payment failure | Open invoice/payment attempt to failed payment, error, open invoice, past-due payer | Provider signature; Connect account and local studio identities must agree | Provider intent identity plus event watermark; repeated projection converges | A stale or same-second lower-precedence failure cannot regress a succeeded payment | Failed payer is visible; system event is retained in `stripe_events` | Inbound projection supported |
| Payment success | Processing/failed/open to succeeded payment, paid invoice, zero remaining balance, current payer | Provider signature and account/studio identity | Provider identity and event ordering guard; invoice/payer writes are convergent but not one transaction | Delayed older invoice or intent events cannot regress terminal state | Payment and paid invoice visible; no actor audit for provider event | Inbound projection supported |
| Invoice retry | Open linked invoice to paid, definitive failure, or reconciliation-required operation | Admin only hidden route | Durable operation/alias rows, one active invoice operation, lease compare-and-set, caller and Stripe idempotency keys; successful replay emits one audit | Ambiguous timeout preserves operation and key; later request reconciles before another charge attempt | UI retains key across reload on ambiguous 5xx; live retry control hidden | Test-mode implementation only; live `FAIL-CLOSED` |
| Duplicate webhook | Unseen event to processed; processed duplicate to `already_processed` | Valid signature, configured mode, and mapped Connect account | Atomic claim by Stripe event ID/account; compare-and-set finish | Fresh concurrent duplicate returns retryable `503`; stale lease is reclaimable | Hidden system trace; no second projection | Supported system behavior |
| Delayed or out-of-order webhook | Older invoice/payment/subscription/refund/dispute state after newer state, or adjustment before its payment | Provider signature and trusted account/studio mapping | Invoice/payment/subscription use event-created guards. Refund/dispute preserve effective terminal outcomes and recompute totals from provider rows | Terminal invoice/refund/dispute outcomes do not regress; late payment projection back-links earlier refunds/disputes by account and charge; unknown dispute status fails toward balance reversal | Current local truth remains visible | Supported system behavior |
| Payer-level external payment | Valid payer to one `externally_recorded` payment | Admin or Front Desk; payer must share studio; invoice target is rejected at HTTP boundary | Required studio-scoped key and canonical request hash; database unique constraint handles races; replay returns existing row and does not duplicate actor audit | No provider event and no invoice settlement | Appears in payment history and UTC-month external total | Supported `LOCAL-ONLY` |
| Cancellation | Active provider enrollment to immediate detach/canceled local state | Admin only hidden route | Pending detach metadata precedes provider call; provider keys/quantity lease limit duplicate mutation. Not one transaction | Subscription deletion webhook detaches linked enrollments; reconciliation can repair provider snapshot | No ordinary live control | Unsupported; current implementation is immediate, not period-end |
| Refund request and projection | Succeeded payment to pending/failed/canceled/succeeded refund projection | Admin only hidden route for request; signed provider events for projection | Caller-derived Stripe key. Refund rows upsert by provider ID. Only succeeded rows affect totals; duplicate or delayed pending rows are neutral | `refund.created`, `refund.updated`, `refund.failed`, `charge.refund.updated`, and `charge.refunded` are understood by the projector | Pending request audit does not claim completion; succeeded request uses completed audit | Unsupported outbound; inbound projection supported |
| Dispute projection | Succeeded payment to active/lost reversal, or back to succeeded/refunded after won outcome | Signed provider event; account/studio identity must agree | Provider dispute ID upsert; terminal outcome guard; all disputes for the payment are considered | Inquiry/warning and won states are non-reversing; needs-response, under-review, lost, and unknown states reverse; delayed active event cannot regress won | Payer balance and invoice state update; system event retained | Inbound projection supported |
| Existing-invoice reconcile | Any linked local projection to current provider snapshot | Admin or Front Desk; same-studio local invoice | Repeated provider read is convergent. Invoice/payment/payer/audit writes are not one transaction | Used after missed/delayed webhooks; event guards preserve terminal state | Reconcile action exposes pending/error honestly | Supported `READ-ONLY LIVE` |

## Reconciled accounting invariants

The fake-only lifecycle proof asserts these invariants:

- `amount_paid_cents + amount_remaining_cents = amount_due_cents` for open, paid, partially-refunded, and disputed examples, except a fully refunded invoice intentionally closes with zero paid and zero remaining.
- Payer balance is the sum of nonnegative invoice remainder for `draft`, `open`, `uncollectible`, and `partially_refunded` invoices.
- A pending, failed, canceled, or requires-action refund does not reduce payment or invoice totals.
- A succeeded refund contributes once even when the provider event is duplicated.
- A partial succeeded refund currently reopens the refunded amount as invoice remainder; a full refund closes the invoice as `refunded`.
- An active or lost chargeback removes that payment from invoice paid totals. A won dispute restores the payment, subject to succeeded refunds.
- Inquiry/warning dispute states are recorded but do not reverse payment totals.
- When multiple disputes exist for one charge, any balance-reversing dispute keeps the payment disputed.
- The frontend `Open Balance` reads `amount_remaining_cents`; it does not infer a different amount from due minus paid.
- The UTC-month payment cohort includes succeeded, fully refunded, and externally recorded payments, subtracts cumulative succeeded refunds, and excludes failed or disputed payments.

The payment cohort remains a cohort metric, not a general ledger. Refund event date, dispute loss date, fees, credits, and external-payment correction dates are not represented well enough to claim cash-basis or accrual revenue.

## Tenant, role, and data boundaries

- Every staff billing route resolves current `staff_roles` membership before constructing the billing service.
- Admin and Front Desk may use only the three routine contract operations. Hidden provider/global writes remain Admin-only.
- Instructor access is denied before billing client code or sensitive fetches.
- Unexpected multi-studio or multi-role membership fails closed.
- Service queries scope local objects by `studio_id`; provider projection additionally requires the connected account and local studio identities to agree.
- Cross-studio invoice item references are rejected before an invoice idempotency claim.
- RLS permits Admin and Front Desk reads of billing tables and denies direct client writes. Backend writes use the service role after route authorization.
- `stripe_events` and invoice retry-operation tables deny ordinary client access.
- No service-role or Stripe secret is present in this evidence.

## Executable isolated proof

Run:

```bash
npm run verify:tuition-lifecycle
```

The command requires Python 3.11 backend development dependencies. By default it uses `backend/venv/bin/python`; set `KOARYU_BACKEND_PYTHON` to another compatible environment when a worktree shares a prepared runtime.

The command uses provider and database fakes only and covers:

- enrollment activation, pending attach/detach state, quantity locking, and cancellation;
- invoice creation/finalization, request hashing, retry leases, response loss, replay, and reconciliation;
- payment success/failure and invoice/payer recomputation;
- pending, failed, succeeded, duplicate, and delayed refund projection;
- inquiry, active, won, lost, duplicate, and delayed dispute projection;
- webhook signature boundary, event claim, duplicate delivery, stale reclaim, lost lease, and ordering guards;
- external-payment idempotency, races, target restrictions, overpayment guards, audits, and cohort totals;
- Admin, Front Desk, Instructor, multi-membership, tenant, and schema boundaries;
- live-mutation fail-closed policy;
- frontend role policy, retry-key persistence, cohort totals, and open-balance state.

Primary test evidence:

- `backend/tests/test_billing_autopay_lifecycle.py`
- `backend/tests/test_billing_endpoint_permissions.py`
- `backend/tests/test_billing_invoice_lifecycle.py`
- `backend/tests/test_billing_payment_intent_lifecycle.py`
- `backend/tests/test_billing_payments.py`
- `backend/tests/test_billing_subscription_projection_lifecycle.py`
- `backend/tests/test_billing_webhook_ordering_lifecycle.py`
- `backend/tests/test_stripe_mutation_policy.py`
- `backend/tests/test_webhook_service.py`
- `frontend/tests/billing-invoice-action-model.test.mjs`
- `frontend/tests/billing-page-model.test.mjs`
- `frontend/tests/billing-policy.test.mjs`
- `frontend/tests/billing-route-access.test.mjs`
- `supabase/verification/billing_external_payment_overpay_guard.sql`
- `supabase/verification/billing_invoice_item_refs_contract.sql`
- `supabase/verification/billing_invoice_retry_operations.sql`
- `supabase/verification/stripe_event_worker_claim_controls.sql`
- `supabase/verification/worker_claim_rpc_contract.sql`

## Proven non-atomic boundaries

The investigation does not claim transactionality where none exists:

- supported external enrollment inserts the domain row, recomputes balance, and inserts audit in separate calls;
- supported external payment inserts idempotently, recomputes derived state, and inserts audit in separate calls;
- read reconciliation updates invoice/payment/payer state and audit in separate calls;
- webhook claim and finish are atomic RPC boundaries, but the projection between them can update several rows;
- provider mutation and local projection cannot share a database transaction.

These paths recover by idempotent replay, uniqueness, durable provider identity, event re-delivery, and deterministic recomputation. A failure after a domain write but before its actor audit can still leave an audit gap. Converting the supported local routines to database RPCs is a separate hardening decision because it changes their persistence contract.

## Decisions still required before broader billing

| Decision | Current behavior | Accounting or customer consequence | Recommended safe default |
| --- | --- | --- | --- |
| Ordinary cancellation timing | Hidden implementation detaches immediately | Immediate cancellation can stop service and provider billing before period end | Keep hidden; define period-end cancellation as a new named transition |
| Partial refund receivable | Successful partial refund reopens the refunded amount on the invoice | Family appears to owe the amount that was returned | Do not expose refunds until product/accounting explicitly approves reopen versus credit/void behavior |
| Lost dispute collection | Lost/active dispute reopens invoice and payer balance | Staff may pursue the family after a chargeback | Keep projection visible but add no automated collection action until policy is approved |
| Inquiry/warning handling | Recorded without reversing payment | Staff can retain provider evidence without falsely showing a chargeback balance | Keep as the provider-faithful default |
| Refund webhook configuration | Projector understands refund lifecycle events; existing runbook endpoint list must be updated explicitly in Stripe | Without the added event subscriptions, a pending refund can remain pending locally until read reconciliation | Require test-mode delivery proof before changing any live webhook endpoint |
| Refund request replay audit | Stripe mutation is idempotent, but repeated hidden requests can still create repeated actor audit rows | Audit volume can overstate operator attempts, though money remains provider-idempotent | Keep refund action hidden; require a durable local refund-operation claim before activation |
| External-payment correction | Payer-level external payment is append-only; no reversal workflow | Mistakes require support handling and cannot be silently edited | Keep append-only; design an Admin-only compensating entry with reason and audit |
| Invoice-target external payment | Service implementation exists, but supported HTTP routes reject invoice targets | Routine external payment never claims to settle a Stripe or local invoice | Preserve payer-level-only scope until settlement semantics are separately approved |
| Revenue reporting | Current metric is payment-cohort net of cumulative refunds; disputes are excluded | It is not cash movement, period-net revenue, or a ledger | Preserve disclosure; build a dated ledger before financial reporting claims |

## Stripe and Supabase reference checks

- Stripe Refund status is one of pending, requires-action, succeeded, failed, or canceled. Only succeeded is treated as an effective refund in local totals: <https://docs.stripe.com/api/refunds/object>.
- Stripe dispute outcomes include inquiry/warning states plus won and lost; Stripe test mode credits won disputes and does not credit lost disputes: <https://docs.stripe.com/api/disputes/object> and <https://docs.stripe.com/testing>.
- Supabase migrations remain repository-tracked and local commands must name `--local` explicitly: <https://supabase.com/docs/guides/local-development/cli-workflows>.
- Existing billing tables remain RLS-enabled with manager read policies and service-role backend writes: <https://supabase.com/docs/guides/database/postgres/row-level-security>.

## Evidence boundary

No Stripe test object was required because the discovered gaps were deterministic projection and presentation defects reproducible with fakes. Therefore there is no provider-object cleanup step and no claim of end-to-end Stripe delivery evidence.

A future broader billing release still requires an explicitly approved isolated Stripe test-mode rehearsal for the exact named transitions, including webhook endpoint subscriptions, provider object cleanup, and reconciled provider/local/report snapshots. It must not reuse this fake-only proof as authorization for live activation.
