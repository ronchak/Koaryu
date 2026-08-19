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

**Koaryu Payments remains CONTRACT ONLY.** The supported production behavior is
limited to:

1. Admin and Front Desk viewing billing and reconciliation state.
2. Admin and Front Desk attaching an **external-only local billing record** to a student.
3. Admin and Front Desk recording a **payer-level external payment**.
4. Admin and Front Desk reconciling an existing Stripe-linked invoice through a provider read.

Stripe Connect setup, provider-backed enrollment lifecycle, hosted-invoice mutation,
autopay changes, refunds, voids, provider plan or payer synchronization, and exports
are currently unsupported. Instructors receive no billing access. Preview-mode
actions are demonstrations only and do not change provider state.

The current public Terms page still describes Stripe Connect, autopay, and refunds as
available Koaryu Payments behavior. That public contract conflicts with this operating
boundary and must be corrected before Koaryu Payments is marketed or sold. Until then,
pilot and demo outreach must describe Koaryu Payments as unavailable and must not
promise tuition collection.

Readiness terms used below:

- `READ-ONLY LIVE`: provider or local data can be read; no outbound financial mutation.
- `LOCAL-ONLY`: supported local database mutation with no Stripe effect.
- `FAIL-CLOSED`: live outbound Stripe mutation is blocked by the central mutation policy.
- `HIDDEN`: no ordinary Koaryu UI control.
- `BROKEN`: implementation exists but does not complete the represented workflow.
- `DECORATIVE`: preview/demo behavior only.

## Authorization contract

| Capability | Admin | Front Desk | Instructor | Product disposition |
| --- | --- | --- | --- | --- |
| View billing summaries, plans, payers, enrollments, invoices, and payments | Yes | Yes | No | `READ-ONLY LIVE` |
| Attach an external-only billing record to a student | Yes | Yes | No | Supported routine, `LOCAL-ONLY` |
| Record a payer-level external payment | Yes | Yes | No | Supported routine, `LOCAL-ONLY` |
| Reconcile an existing Stripe-linked invoice | Yes | Yes | No | Supported routine, `READ-ONLY LIVE` |
| View Koaryu Core subscription detail or email usage through platform endpoints | Yes | No | No | Admin-only read |
| Stripe Connect setup, reset, sync, or dashboard link | Backend Admin only | No | No | Admin-only and hidden |
| Plan, payer, autopay, enrollment-lifecycle, invoice-lifecycle, refund, or export writes | Backend Admin only | No | No | Admin-only and hidden/unsupported |
| Stripe webhooks | Provider signature only | Provider signature only | Provider signature only | Hidden system surface |

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

| Surface or control | Handler or endpoint | Role | Side effects | Product disposition |
| --- | --- | --- | --- | --- |
| Billing route and nested routes | Shared server billing gate | Admin / Front Desk | None | Supported; Instructor receives a non-disclosing denied page |
| Refresh | Billing data GET set | Admin / Front Desk | Reads local state; Connect status may refresh a local projection from a provider read | Supported read |
| Tabs and review steps | Client navigation | Admin / Front Desk | None | Supported navigation |
| Overview metrics and status | Billing list/status GETs | Admin / Front Desk; platform detail Admin | Read and bounded projection repair | Supported read |
| Koaryu Core checkout | `POST /platform-billing/checkout` | Admin | Stripe customer/session, local pending metadata, audit | Live when the production-only Core capability is enabled; first eligible checkout receives one 30-day trial |
| Customer portal | `POST /platform-billing/portal` | Admin | Stripe portal session and audit; missing-customer repair may create a customer | Live when the Core capability is enabled and the studio has a Stripe customer |
| Connect payments | `POST /billing/connect/onboarding-link` | Admin | May create Connect account/link, update local account row, audit | Non-preview control disabled; live `FAIL-CLOSED` |
| Stripe dashboard | `POST /billing/connect/dashboard-link` | Admin | Creates Stripe login link and audit | Non-preview control disabled; live `FAIL-CLOSED` |
| Reconnect Stripe | `POST /billing/connect/reset` | Admin | Locally clears the account association and audits | Removed from UI; hidden dangerous action |
| Tuition plan list | `GET /billing/plans` | Admin / Front Desk | Local read | Supported read |
| Create or sync plan | Plan mutation endpoints | Admin | Local writes; may create or update Stripe product/price; audit | Removed from UI; hidden, live `FAIL-CLOSED` |
| Family payer list | `GET /billing/payers` | Admin / Front Desk | Local read | Supported read |
| Create or sync payer | Payer mutation endpoints | Admin | Local write; may create/update Stripe customer; audit | Removed from UI; hidden, live `FAIL-CLOSED` |
| Autopay setup or disable | Payer autopay endpoints | Admin | Stripe setup/session or subscription rewiring plus local writes | Removed from UI; hidden, live `FAIL-CLOSED` |
| Attach external student billing | `POST /billing/enrollments` | Admin / Front Desk | Local enrollment, balance recomputation, audit; no Stripe call | Supported routine, `LOCAL-ONLY` |
| Enrollment list and provider references | `GET /billing/enrollments` | Admin / Front Desk | Read | Supported read |
| Enrollment mode, pause, resume, cancel | Enrollment mutation endpoints | Admin | May detach, rewire, or activate provider subscription state plus local writes | Controls removed; hidden/unsupported |
| Failed-payment queue and invoice list | Invoice and payer GETs | Admin / Front Desk | Read | Supported read |
| Hosted-invoice link | Existing `hosted_invoice_url` | Admin / Front Desk | Opens an existing provider-hosted page | Supported read-only link |
| Create, finalize, retry, or void invoice | Invoice mutation endpoints | Admin | Stripe invoice/payment mutation, local projection, audit | Controls removed; hidden, live `FAIL-CLOSED` |
| Reconcile invoice | `POST /billing/invoices/{id}/reconcile` | Admin / Front Desk | Stripe GET, local projection, balance recomputation, audit | Supported routine, `READ-ONLY LIVE` |
| Payment list and monthly cohort | Payment GETs | Admin / Front Desk | Read | Supported read |
| Record external payment | `POST /billing/payments/external` | Admin / Front Desk | Local payer-level payment and audit; no Stripe call | Supported routine, `LOCAL-ONLY` |
| Billing CSV controls | `POST /billing/exports` | Admin | Creates an export job row and audit; no producer completes it | Removed; endpoint hidden and `BROKEN` |
| Preview actions | Client preview branches | Preview role | Demo messages/state only | `DECORATIVE`; no provider effect |

## Endpoint inventory

### Platform and Connect

| Endpoint | Role | Effects | Disposition |
| --- | --- | --- | --- |
| `GET /platform-billing/status` | Admin | Reads and may repair local platform-subscription projection | Admin-only read |
| `GET /platform-billing/email-usage` | Admin | Local usage read | Admin-only read |
| `POST /platform-billing/checkout` | Admin | Stripe customer/Checkout Session, pending metadata, audit | Live, production-only, Admin- and capability-gated |
| `POST /platform-billing/portal` | Admin | Stripe portal session and audit; missing-customer repair may create a customer | Live, production-only, Admin-, capability-, and customer-gated |
| `GET /billing/connect/status` | Admin / Front Desk | Local read; may retrieve Stripe account and refresh projection | Supported read |
| `POST /billing/connect/onboarding-link` | Admin | Stripe account/link creation, local account projection, audit | Hidden; live `FAIL-CLOSED` |
| `POST /billing/connect/sync` | Admin | Stripe account read and local projection | Hidden Admin-only reconciliation |
| `POST /billing/connect/reset` | Admin | Local unlink/reset and audit | Hidden Admin-only dangerous action |
| `POST /billing/connect/dashboard-link` | Admin | Stripe login-link creation and audit | Hidden; live `FAIL-CLOSED` |
| `GET /billing/system/status` | Admin | Configuration, account, and webhook-health read | Hidden Admin-only read |
| `POST /billing/reconcile` | Admin | Broad reconciliation; payer and some paid-object projections can update a provider customer's default payment method | Hidden; mutation-capable branches are live `FAIL-CLOSED` |

### Plans and payers

| Endpoint | Role | Effects | Disposition |
| --- | --- | --- | --- |
| `GET /billing/plans` | Admin / Front Desk | Local read | Supported read |
| `POST /billing/plans` | Admin | Local insert; may create Stripe product/price; audit | Hidden/unsupported |
| `PATCH /billing/plans/{plan_id}` | Admin | Local update; may replace provider price/product data; audit | Hidden/unsupported |
| `POST /billing/plans/{plan_id}/archive` | Admin | Local archive and audit | Hidden Admin-only |
| `POST /billing/plans/{plan_id}/sync` | Admin | Stripe product/price mutation, local projection, audit | Hidden; live `FAIL-CLOSED` |
| `GET /billing/payers` | Admin / Front Desk | Local read | Supported read |
| `POST /billing/payers` | Admin | Local insert; may create Stripe customer; audit | Hidden/unsupported |
| `GET /billing/payers/{payer_id}` | Admin / Front Desk | Local read | Supported read |
| `PATCH /billing/payers/{payer_id}` | Admin | Local update; may update Stripe customer; audit | Hidden/unsupported |
| `POST /billing/payers/{payer_id}/sync` | Admin | Stripe customer read/create/update, local projection, audit | Hidden; live `FAIL-CLOSED` |
| `POST /billing/payers/{payer_id}/autopay/setup-link` | Admin | Terms timestamp, Stripe setup flow, local status, audit | Hidden; live `FAIL-CLOSED` |
| `POST /billing/payers/{payer_id}/autopay/disable` | Admin | May rewire provider subscriptions and local state; audit | Hidden; unresolved semantics |

### Subscriptions and enrollments

| Endpoint | Role | Effects | Disposition |
| --- | --- | --- | --- |
| `GET /billing/subscriptions` | Admin / Front Desk | Local read | Supported read |
| `GET /billing/enrollments` | Admin / Front Desk | Local read | Supported read |
| `GET /students/{student_id}/billing` | Admin / Front Desk | Tenant-scoped local read | Supported read |
| `POST /billing/enrollments` | Admin / Front Desk | External-only local enrollment, balance recomputation, audit | Supported routine |
| `POST /students/{student_id}/billing/enrollments` | Admin / Front Desk | Same external-only transition, student-scoped | Supported routine |
| `PATCH /billing/enrollments/{enrollment_id}` | Admin | May detach or activate provider lifecycle and update local state | Hidden/unsupported |
| `POST /billing/enrollments/{enrollment_id}/pause` | Admin | Provider detachment plus local status and audit | Hidden/unsupported |
| `POST /billing/enrollments/{enrollment_id}/resume` | Admin | May activate provider subscription plus local status | Hidden/unsupported |
| `POST /billing/enrollments/{enrollment_id}/cancel` | Admin | Current implementation detaches provider state immediately | Hidden/unsupported; not an ordinary period-end cancellation |

Both enrollment-create routes return `409` before service execution unless `collection_mode` is exactly `external`.

### Invoices, payments, and exports

| Endpoint | Role | Effects | Disposition |
| --- | --- | --- | --- |
| `GET /billing/invoices` | Admin / Front Desk | Local read | Supported read |
| `POST /billing/invoices` | Admin | Creates local and Stripe invoice/items; may finalize/send; audit | Hidden/unsupported |
| `POST /billing/invoices/{invoice_id}/finalize` | Admin | Finalizes and may email Stripe invoice; local projection | Hidden; live `FAIL-CLOSED` |
| `POST /billing/invoices/{invoice_id}/retry` | Admin | Stripe payment attempt with durable retry operation | Hidden/unsupported |
| `POST /billing/invoices/{invoice_id}/void` | Admin | Stripe or local void, balance recomputation, audit | Hidden exceptional action |
| `POST /billing/invoices/{invoice_id}/reconcile` | Admin / Front Desk | Stripe retrieval only, local projection/balance, audit | Supported routine |
| `GET /billing/payments` | Admin / Front Desk | Local read | Supported read |
| `GET /billing/payments/current-month-cohort` | Admin / Front Desk | Local aggregate read | Supported read |
| `POST /billing/payments/external` | Admin / Front Desk | Payer-only local payment, balance recomputation, audit | Supported routine |
| `POST /billing/payments/{payment_id}/refund` | Admin | Stripe refund, local projection, audit | Hidden; live `FAIL-CLOSED` |
| `POST /billing/exports` | Admin | Queues local job and audit only | Hidden; `BROKEN` without worker |
| `GET /billing/exports/{export_id}` | Admin | Reads queued job | Hidden read |

The external-payment route rejects a missing `payer_id` or any `invoice_id` with `409` before service execution.

### Webhooks

| Endpoint | Authentication | Effects | Disposition |
| --- | --- | --- | --- |
| `POST /webhooks/stripe/platform` | Stripe platform signature | Claims event and projects platform state | Hidden system endpoint |
| `POST /webhooks/stripe/connect` | Stripe Connect signature | Claims and projects account/billing state; an autopay checkout event can update a provider customer's default payment method | Hidden system endpoint; the provider write is live `FAIL-CLOSED` |

Webhook routes read the raw request body, enforce the request-size limit, verify the Stripe signature, and reject configured-mode/livemode mismatch.

## Supported transition contracts

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
| Source | Same-studio payer, positive amount, currency, external method, optional note |
| Target | One payment with `status=externally_recorded`, payer target, and current `processed_at` |
| Actors | Admin, Front Desk |
| Inputs | `payer_id`, amount, method, optional note, required `Idempotency-Key`; `invoice_id` forbidden |
| Effective time | Recorded immediately in local history |
| Provider action | None |
| Idempotency | Unique by studio and key; canonical request hash must match. Same key/same request returns the existing payment; same key/different request returns `409` |
| Pending state | None |
| Webhooks | None expected |
| Reconciliation | Refresh payment list and UTC-month cohort |
| Failure and retry | Never claim a charge or invoice settlement. Reuse the same key for the same unchanged request |
| Audit | `billing.external_payment_recorded` only when the row is first created |
| Recovery | Preserve the record; correction/reversal is a future Admin accounting workflow |
| Live policy | Supported because it performs no Stripe mutation |

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

The domain write and audit insert are not one database transaction. After an ambiguous response, operators refresh before retrying. External-payment replay is key-safe; external-enrollment uniqueness exposes an existing assignment as `409`; invoice reconciliation is convergent.

## State-truth, webhook, and audit rules

- A visible success describes only the completed local or read-based transition.
- Hidden endpoint implementations do not make their transitions supported. Some may perform local writes before a blocked live provider call.
- No generic enrollment `PATCH` is part of the supported lifecycle.
- No local success may be presented as a completed Stripe operation.
- Inbound live webhooks for existing objects remain allowed. Koaryu Core Checkout,
  customer portal, and their exact-object compensation paths are the bounded live
  exception; Koaryu Payments and tuition mutations remain closed.
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

- only the three named routine transitions are visible and operable;
- provider/global/exceptional controls are removed, disabled, or truthfully labeled;
- Admin and Front Desk can read billing state;
- Instructor denial occurs before any billing fetch;
- external-only and payer-only backend guards run before the billing service;
- live Koaryu Payments and tuition mutation remains fail-closed;
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
