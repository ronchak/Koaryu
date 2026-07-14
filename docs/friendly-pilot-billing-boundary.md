# Friendly Pilot Billing Boundary

## Release disposition

Friendly Pilot billing is **CONTRACT ONLY**. The supported production behavior is limited to:

1. Admin and Front Desk viewing billing and reconciliation state.
2. Admin and Front Desk attaching an **external-only local billing record** to a student.
3. Admin and Front Desk recording a **payer-level external payment**.
4. Admin and Front Desk reconciling an existing Stripe-linked invoice through a provider read.

All Stripe Connect setup, platform-subscription changes, provider-backed enrollment lifecycle, hosted-invoice mutation, autopay changes, refunds, voids, provider plan or payer synchronization, and exports remain outside the supported release. Instructors receive no billing access. Preview-mode actions are demonstrations only and do not change provider state.

Readiness terms used below:

- `READ-ONLY LIVE`: provider or local data can be read; no outbound financial mutation.
- `LOCAL-ONLY`: supported local database mutation with no Stripe effect.
- `FAIL-CLOSED`: live outbound Stripe mutation is blocked by the central mutation policy.
- `HIDDEN`: no ordinary Friendly Pilot UI control.
- `BROKEN`: implementation exists but does not complete the represented workflow.
- `DECORATIVE`: preview/demo behavior only.

## Authorization contract

| Capability | Admin | Front Desk | Instructor | Release disposition |
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

## Visible control inventory

| Surface or control | Handler or endpoint | Role | Side effects | Friendly Pilot disposition |
| --- | --- | --- | --- | --- |
| Billing route and nested routes | Shared server billing gate | Admin / Front Desk | None | Supported; Instructor receives a non-disclosing denied page |
| Refresh | Billing data GET set | Admin / Front Desk | Reads local state; Connect status may refresh a local projection from a provider read | Supported read |
| Tabs and review steps | Client navigation | Admin / Front Desk | None | Supported navigation |
| Overview metrics and status | Billing list/status GETs | Admin / Front Desk; platform detail Admin | Read and bounded projection repair | Supported read |
| Koaryu Core checkout | `POST /platform-billing/checkout` | Admin | Stripe customer/session, local pending metadata, audit | Non-preview control disabled; live `FAIL-CLOSED` |
| Customer portal | `POST /platform-billing/portal` | Admin | Stripe portal session and audit; missing-customer repair may create a customer | Non-preview control disabled; live `FAIL-CLOSED` |
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
| `POST /platform-billing/checkout` | Admin | Stripe customer/Checkout Session, pending metadata, audit | Hidden; live `FAIL-CLOSED` |
| `POST /platform-billing/portal` | Admin | Stripe portal session and audit; missing-customer repair may create a customer | Hidden; live `FAIL-CLOSED` |
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
- Inbound live webhooks for existing objects remain allowed; outbound live Stripe mutation remains closed.
- Events are claimed durably by Stripe event ID. Concurrent handling uses a bounded lease and retry response.
- Unmapped live Connect events are quarantined and retried rather than projected into an unknown studio.
- Projection preserves tenant/account identity, terminal states, and event ordering.
- Audit metadata contains stable references and action-relevant fields, never secrets, full card data, signed URLs, or raw webhook payloads.
- Replayed external payments do not produce duplicate actor audits. Read-only page loads do not require actor audits.

## Independent production approvals and live activation gate

Application deployment, production migration, and live Stripe activation are three independent approvals. This release does not request live Stripe activation.

`LIVE_BILLING_ENABLED` remains `false`. The mutation policy has no durable live-authorization source, and hosted configuration validation rejects enabling the flag; even setting the flag alone cannot issue a live mutation permit.

A future activation request must name each exact transition and prove in Stripe test mode:

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

The billing domain is complete for Friendly Pilot when:

- only the three named routine transitions are visible and operable;
- provider/global/exceptional controls are removed, disabled, or truthfully labeled;
- Admin and Front Desk can read billing state;
- Instructor denial occurs before any billing fetch;
- external-only and payer-only backend guards run before the billing service;
- live outbound Stripe mutation remains fail-closed;
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
- `frontend/tests/billing-pilot-policy.test.mjs`
