# Billing Boundary

## Product disposition

Koaryu Core and Koaryu Payments are separate products with separate authority.

**Koaryu Core is live in production.** An authenticated studio Admin can start the
flat-rate Koaryu subscription through Stripe Checkout and open the Stripe customer
portal. The first eligible Checkout reservation receives one 30-day trial; accepted
Checkout and subscription events consume that eligibility so a later subscription
cannot receive another trial. Production currently uses the live, active `$27 USD`
monthly price. This path is controlled by `CORE_SELF_CHECKOUT_ENABLED` and does not
grant any Koaryu Payments or tuition authority.

Koaryu Payments has five separate product facts. A workflow may be implemented without
being available to a studio. The [billing workflow catalog](billing-workflow-catalog.md)
records whether each named workflow is implemented and which staff roles may use it.
The environment switch is a separate global interlock. Live provider mutations also
require an enabled, unexpired grant for the exact studio and every exact operation.
Commercial availability is a separate product decision again. No current studio grant
is asserted here, and tuition collection must not be presented as generally available.

Preview-mode actions are demonstrations only and do not change provider state.
Koaryu Core Checkout remains separate from tuition activation.

## Authorization contract

Every staff route resolves authoritative `staff_roles` membership before service construction. Unexpected multi-membership fails closed. Instructor denial occurs before client billing code or sensitive billing fetches.

## Platform-subscription enforcement on routine requests

Routine tenant requests resolve Koaryu Core entitlement before the request proceeds. A studio whose local subscription row is already entitled and self-consistent is admitted without contacting Stripe.

When the local row is not self-consistent, the resolver may attempt one bounded Stripe repair so a studio whose projection is stale-negative is not denied in error. That retry is throttled per studio, because the repair writes the same status back for a genuinely lapsed studio and would otherwise repeat on every request. Webhook projection and the Admin-only `GET /platform-billing/status` refresh are not throttled.

The throttle is keyed on what the repair did, because the outcomes carry opposite risk. A repair that failed against an **unreachable** Stripe backs off for 60s: that is the case that ties up the single worker with provider timeouts, and retrying sooner cannot help, since Stripe confirms no payments while it is unreachable. A repair that failed against a **reachable** Stripe — a 5xx, a rate limit, a stale subscription id — is retried after 5s instead: it returned fast, so it never tied up the worker, and a payment can land through checkout while a retrieve is erroring. A repair that **succeeded** and left the studio unentitled is also rechecked after 5s: it is the only thing that notices a payment whose webhook was lost.

A failure in Koaryu's own code — a persistence write, the subscription projector, Supabase — is not a provider fault. It opens no window and is never answered from local state: it fails closed with `503`. Reporting `402 SUBSCRIPTION_REQUIRED` in that situation presented a Koaryu outage as the studio's billing problem, in a response that looks routine.

Operational consequence: if webhook delivery fails, a studio that has just paid stays denied for at most five seconds before a request re-consults Stripe — after a successful repair or a fast provider error. While Stripe is genuinely unreachable the bound is 60 seconds, during which no payment could have been confirmed in any case. The normal path does not depend on either — webhook projection updates the row within seconds — and an Admin can force reconciliation immediately from the billing page.

**Suppressing a throttled repair replays the authorization outcome recorded when the window opened, onto the row it was recorded for, and never a different one.** A recorded outcome is a statement about one row state rather than about a studio: the row is re-read on every request, and webhook projection or an Admin refresh can rewrite it mid-window, so a window whose row has changed is void and the new state is resolved on its own merits. A fault replays as that fault; a row a successful repair verified replays as that row. This is what makes throttling safe to do at all, and it is deliberately not stated as a claim about which rows reach the throttle: the repair guards inspect Stripe identifiers and period integrity while the access evaluator inspects only status, `comped` and `trial_end`, and those sets overlap without either containing the other. An earlier revision reasoned that suppression "can only leave the local row in place, which is the deny-side answer" and consequently admitted unverified `active` rows for the length of every window.

Provider faults never grant access. Local state is consulted on a fault only to deny:

| Local subscription state | Stripe reachable | Result |
| --- | --- | --- |
| Entitled and self-consistent | not contacted | Request proceeds |
| Not entitled | either | `402 SUBSCRIPTION_REQUIRED` |
| Entitled but unverifiable | no | `503 BILLING_STATUS_UNAVAILABLE`, fail-closed |
| Entitled, verified by Stripe under 5s ago | no | Request proceeds, until the window expires |
| Any state, Koaryu's own fault | n/a | `503 BILLING_STATUS_UNAVAILABLE`, fail-closed |

An entitled-looking local row is deliberately not trusted while it cannot be verified, on the first request and on every request answered from a throttle window — with one bounded exception. When a repair *succeeded* and Stripe itself confirmed the row moments earlier, that verdict is replayed for the remaining few seconds of the recheck window even if Stripe then becomes unreachable. It is a verdict Stripe gave, not a local row being trusted, and it expires within `ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS`. Serving it during a provider outage was considered and rejected: it would trade a bounded outage for unbounded unpaid access.

A field the resolver cannot read is treated as a denial, and every denial must be recoverable. `_trial_has_ended` reads an unparseable `trial_end` as an ended trial, which is the fail-closed behaviour above. That is only safe while a repair can still correct the row: the repair guards therefore treat a present-but-unreadable `trial_end` as repairable, so the studio is re-checked against Stripe rather than denied on a value nothing will ever revisit. Pessimism about a malformed field is the intended behaviour; permanence is not.

## Visible control inventory

The application derives visible billing actions from the signed-in role and the
workflow capabilities returned for that studio. The
[billing workflow catalog](billing-workflow-catalog.md) owns workflow classification,
roles, provider operations, and prerequisites. The frontend capability and route
policies enforce those decisions without exposing denial details to Instructors.
Preview controls remain local demonstrations.

## Endpoint inventory

The [billing workflow catalog](billing-workflow-catalog.md) is the maintained inventory
for mutating billing handlers and provider sinks. Endpoint authorization and tenant
resolution remain independent checks. Exact-operation live permits are defined in
[Stripe live billing rollout](stripe-live-billing-rollout.md), while webhook identity,
projection, and reconciliation rules remain in
[Stripe live billing reconciliation](stripe-live-billing-reconciliation-v3.md).
The transition contracts below retain the local and provider safety rules that callers
must follow.

## Supported transition contracts

### Local billing plan definition

Admin plan creation and `PATCH /billing/plans/{plan_id}` use
`write_billing_plan_v1`. One transaction owns the allowlisted scalar changes,
deduplicated same-studio program links, original-actor audit, and committed response
snapshot. Program omission retains links, an empty list clears them, and a supplied
list replaces them. A true no-op changes no status, timestamp, link, or audit row.
Required fields reject explicit null; omitted fields stay unchanged and nullable text
may be cleared.

New definitions and financial changes to amount, currency, interval, signup fee, or
trial days require USD. Existing non-USD records may receive an identical save or
nonfinancial maintenance without reinterpretation or backfill. Program-only changes
preserve price readiness. Provider sync, support for new currencies, and aggregate
currency policy remain separate work. The create UI exists; no shipped edit-plan UI
calls the supported Admin PATCH API.

### 1. External-only student billing attachment

| Contract field | Value |
| --- | --- |
| Source | Same-studio student and plan; optional same-studio payer; no matching pending/active assignment |
| Target | New enrollment with `status=active`, `collection_mode=external`, `billing_status=externally_paid`, and no new Stripe subscription/item |
| Actors | Admin, Front Desk |
| Inputs | Student, plan, start date; optional payer, end date, next-bill date |
| Effective time | Submitted start date |
| Provider action | None |
| Idempotency | No API key. Client permits one in-flight submit; database partial uniqueness prevents duplicate active assignments. A duplicate returns `409`, not replayed success |
| Pending state | None; the local insert exists or does not |
| Webhooks | None expected |
| Reconciliation | Refresh enrollment list; provider reconciliation does not apply |
| Failure and retry | Show the API error and do not claim provider setup. After an ambiguous response, refresh before retrying |
| Audit | `billing.student_enrollment_created` with stable student, plan, payer, and collection-mode references |
| Recovery | No provider compensation is needed; a later supported workflow must correct or end the local record |
| Live policy | Supported because it performs no Stripe mutation |

### 2. Payer-level external payment

| Contract field | Value |
| --- | --- |
| Source | Same-studio payer, positive amount, USD currency, external method, optional note |
| Target | One payment with `status=externally_recorded`, payer target, and current `processed_at` |
| Actors | Admin, Front Desk |
| Inputs | `payer_id`, amount, method, optional note, required `Idempotency-Key`; `invoice_id` forbidden |
| Effective time | Recorded immediately in local history |
| Provider action | None |
| Idempotency | Unique by studio and key; canonical request hash must match. Same key/same request returns the original payment and audit; same key/different request returns `409`. Confirmed historical non-USD requests remain replayable, but new non-USD writes are rejected |
| Pending state | Before POST, the browser stores the exact staff/studio-scoped payload and key, including the normalized note, and pins the original form until matching confirmation. Unavailable, corrupt or failing storage blocks an unprotected submission. Preview does not read or retire live attempts |
| Webhooks | None expected |
| Reconciliation | Preserve payment confirmation independently of payment-list and UTC-month-cohort refresh |
| Failure and retry | Never claim a charge or invoice settlement. Reuse the same key for the same unchanged request. Refresh failure is separate from recording failure; failed retirement preserves the unresolved attempt. Token renewal keeps the same owner, while stale or different-session settlements cannot retire another owner's attempt |
| Audit | `billing.external_payment_recorded` commits atomically with a new payment and preserves the original actor on replay; there is no historical audit backfill |
| Recovery | Preserve the record; correction/reversal is a future Admin accounting workflow |
| Live policy | Supported because it performs no Stripe mutation |

A browser rollback must preserve pending-request recovery or block new recording until
the unresolved attempt is confirmed. An older frontend does not safely understand the
new pending-attempt storage contract.

### 3. Existing-invoice reconciliation

| Contract field | Value |
| --- | --- |
| Source | Same-studio local invoice with `stripe_invoice_id` and `stripe_account_id` |
| Target | Local invoice/payment projection and payer balance match the retrieved Stripe snapshot |
| Actors | Admin, Front Desk |
| Inputs | Local invoice ID |
| Effective time | Successful provider retrieval |
| Provider action | Retrieval only; no mutation |
| Idempotency | No request key; repeated reconciliation is convergent. Client permits one in-flight action |
| Pending state | Existing local state remains visible while the request runs |
| Webhooks | Existing invoice/payment events may project the same provider state |
| Reconciliation rule | Provider snapshot is authoritative; projection guards preserve valid terminal state and ordering constraints |
| Failure and retry | Retain existing local status, show an error, and do not report success. Retry after the prior request completes |
| Audit | `billing.invoice_reconciled` after successful projection |
| Recovery | Retry the read; use broad Admin reconciliation only as a bounded support action |
| Live policy | Supported because the provider operation is read-only |

Local plan writes and external-payment writes commit their domain record and original-actor audit in one database transaction. Other local workflows may still split domain and audit writes. After an ambiguous response, operators refresh before retrying. External-payment replay is key-safe; external-enrollment uniqueness exposes an existing assignment as `409`; invoice reconciliation is convergent.

## State-truth, webhook, and audit rules

- A visible success describes the exact operation the server confirmed. It never claims
  a broader provider or commercial outcome.
- An implemented workflow appears only when the signed-in role and exact studio
  capability allow it.
- No generic enrollment `PATCH` is part of the supported lifecycle.
- No local success may be presented as a completed Stripe operation.
- Inbound live webhooks for existing objects remain allowed. Koaryu Core Checkout and
  customer portal use their separate authority. Connect and tuition mutations require
  the global interlock plus exact-studio, exact-operation permission.
- Events are claimed durably by Stripe event ID. Concurrent handling uses a bounded lease and retry response.
- Unmapped live Connect events are quarantined and retried rather than projected into an unknown studio.
- Projection preserves tenant/account identity, terminal states, and event ordering.
- Audit metadata contains stable references and action-relevant fields, never secrets, full card data, signed URLs, or raw webhook payloads.
- Replayed external payments do not produce duplicate actor audits. Read-only page loads do not require actor audits.

## Independent production approvals and live activation gate

Application deployment, production migration, and live Stripe activation are three independent approvals. On 2026-08-04, the product owner approved live Koaryu Core Checkout and Customer Portal activation. On 2026-08-13, the product owner approved production self-service Core checkout for newly registered studios. On 2026-08-14, the product owner directed the release to continue through production with Core self-checkout and signup enabled. That release authorization includes the two bounded compensating operations required to make Core checkout fail closed: expiring a newly created session that loses its database reservation, and canceling the exact subscription from a Checkout completion whose reservation was invalidated. It does not authorize generic subscription cancellation, refunds, Connect onboarding, Connect payments, tuition collection, or other Stripe mutations.

On 2026-08-16, Ronak explicitly authorized the required production migration, exact-candidate application deployment, and repository alignment for the already-live global `LIVE_BILLING_ENABLED=true` interlock. That approval creates no studio scope or reconciliation checkpoint and authorizes no provider mutation, tenant financial permission, live Connect or tuition mutation, or live-money action. Those actions require separate approval and remain fail-closed behind the enabled, unexpired exact-studio scope and exact-candidate all-clear reconciliation checkpoint requirements below.

`CORE_SELF_CHECKOUT_ENABLED` is the production-only interlock for the three user-facing Core operations plus those two exact-object compensations. It requires an exact deployed `RENDER_GIT_COMMIT`, an authenticated studio Admin at the endpoint boundary, and an explicit studio ID at the central Stripe mutation policy. A cancellation is allowed only for the subscription ID rejected by the atomic checkout-acceptance decision. An expiration is allowed only for the session ID returned by a failed publish or stored by the atomic comp invalidation; completed sessions are never expired. A paid invalid completion must first persist a durable `core_checkout_compensations` receipt so cancellation cannot erase the refund/credit work queue. The interlock never authorizes a generic `customer.*` or `subscription.*` operation. `LIVE_BILLING_ENABLED` remains `false` by default and in staging, while production intentionally sets it to `true` as the necessary global interlock for Connect and tuition mutations. The production value alone creates no studio scope, reconciliation checkpoint, provider authority, or tenant financial permission. Each operation still requires an enabled, unexpired exact-studio scope and exact-candidate all-clear reconciliation checkpoint as defined in `stripe-live-billing-rollout.md`.

Activation execution must name each exact transition and prove in Stripe test mode:

- authorization;
- double-click and retry behavior;
- idempotency;
- partial-failure handling;
- webhook idempotency and ordering;
- reconciliation;
- actor audit behavior;
- rollback and fail-close behavior.

Approval for one transition never approves another transition or the broader billing roadmap.

## Billing stopping condition

The billing domain meets the current product boundary when:

- visible controls match the signed-in role and exact studio workflow capabilities;
- provider and exceptional controls are absent or truthfully labeled when their exact
  capability is unavailable;
- Admin and Front Desk can read billing state;
- Instructor denial occurs before any billing fetch;
- external-only and payer-only backend guards run before the billing service;
- live Koaryu Payments and tuition mutations fail closed without the required
  exact-studio, exact-operation permission;
- preview actions are explicitly demo-only;
- export controls no longer promise a download;
- focused permission, idempotency, reconciliation, webhook, and live-fail-close tests pass;
- a fresh billing reviewer issues explicit `GREEN LIGHT`; and
- no production Stripe object or production record changed during analysis.

Primary proof lives in:

- `backend/tests/test_billing_endpoint_permissions.py`
- `backend/tests/test_platform_billing_permissions.py`
- `backend/tests/test_billing_payments.py`
- `backend/tests/test_billing_invoice_lifecycle.py`
- `backend/tests/test_billing_invoice_projection.py`
- `backend/tests/test_billing_webhook_endpoint_contracts.py`
- `backend/tests/test_billing_webhook_ordering_lifecycle.py`
- `backend/tests/test_stripe_mutation_policy.py`
- `frontend/tests/billing-route-access.test.mjs`
- `frontend/tests/billing-policy.test.mjs`
