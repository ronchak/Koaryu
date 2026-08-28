# Koaryu Payments live implementation plan

Status: local implementation and verification complete; exact-head review and staging proof in progress

Planning baseline: `main` at `1a9db595f8faf03e3b681b5cac91470c6ab4934c`

This document owns the route from the current Contract Only billing boundary to one
attended production canary and, after a separate decision, a bounded studio pilot. It
does not authorize production Stripe or Supabase writes, a reconciliation checkpoint,
a studio grant, or money movement.

## Current position

Koaryu already has Stripe Connect account handling, plans and prices, payer and
subscription records, invoices, payments, refunds, disputes, webhook projection, and a
central live-mutation interlock. The remaining work is about correctness and authority.
The product is not ready to activate by inserting a `connect_payments` grant and showing
the dormant controls.

Koaryu Core is already live through its separate Checkout and portal path. Koaryu
Payments remains Contract Only. Admin and Front Desk may read billing data, attach an
external-only local enrollment, record a payer-level external payment, and reconcile an
existing Stripe-linked invoice. Provider-backed tuition writes remain unavailable.

Current `main` contains 117 migrations and expects `release-db-attestation-v24`. The
repository's latest recorded hosted-state inspection says staging and production were
also at migration 117, head `20260824190500`, V24 on 2026-08-24. Re-read live state before
any deployment or database action.

## Implementation status on 2026-08-26

Workstreams 1 and 2 are implemented together in the isolated branch
`codex/payments-adjustment-convergence`, based on planning SHA
`1a9db595f8faf03e3b681b5cac91470c6ab4934c`. The candidate has two ordered additive
migrations:

1. `20260826030234_live_billing_reconciliation_v3.sql` advances the release to
   118 migrations and V25.
2. `20260826030249_payments_adjustment_convergence.sql` advances the combined release to
   119 migrations and V26.

The current local evidence is:

- all 119 migrations and 38 Supabase contracts pass on ephemeral PostgreSQL 17;
- the same suite proves canonical V26 and a PostgreSQL 17 V25 dump/restore followed by
  migration 119, with separately pinned canonical and restored catalog states;
- rollout tests pass 56 of 56;
- the full backend passes 1,137 tests and 5,074 subtests;
- generated API contracts, frontend TypeScript, ESLint, 682 non-browser assertions, and
  the production build pass;
- three embedded Chrome checks remain unverified because the local Chrome process exits
  with `SIGABRT` before page creation;
- `git diff --check` passes;
- the verified work is preserved in local commits `6525905` and `c97c565`; no branch has
  been pushed, and no hosted write, checkpoint, grant, deployment, or provider mutation
  has occurred.

The implementation preserves historical payment and adjustment identity through Connect
reconnects, marks ambiguous pre-migration generations for reconciliation, proves
parent/child identity serialization in both lock directions, keeps invoice receivables
independent of refunds and disputes, and records missing dispute status as unknown until
an authoritative event resolves it.

Workstreams 1 through 5 are implemented in isolated local checkpoints. Workstream 6,
single-branch integration, independent review, and staging proof remain open. The
repository continues to default to no ongoing studio payment authorization until the
exact integrated head completes those gates.

Workstream 3 now has a verified first vertical slice on local branch
`codex/payments-replay-consent-v27`:

- migration `20260826051527_billing_provider_operations_and_payer_consent.sql` advances
  the combined candidate to 120 migrations and V27;
- service-only operation, payer setup request, and versioned payer consent records own
  caller-key replay, ambiguous provider outcomes, recovery authorization, consent
  acceptance, local projection, revocation, and Session expiry closure;
- Stripe Checkout collects payer-owned terms acceptance in setup mode;
- the staff-authored `terms_accepted` assertion is removed;
- the setup workflow performs one coordinated Checkout mutation and stores no hosted URL,
  raw token, payment details, or provider payload;
- the exact combined branch passes 1,157 backend tests, API generation, frontend checks,
  production build, 120 migrations, 39 SQL contracts, both restore paths, payer-setup
  concurrency, and 61 rollout tests.
- the slice is preserved in local commits `d180915` and `81158ac`; neither commit has
  been pushed.

This is not the full workstream 3 completion gate. The durable operation boundary still
must own payer synchronization, plan synchronization, provider enrollment, invoice
creation and retry, refund creation, and every other workflow declared supported for
launch. Multi-call workflows also need durable per-step provider state before they can
recover honestly from a partial success.

The next single-call slice is preserved in local commit `cd0f712` on
`codex/payments-single-call-replay`:

- `payer.sync` and `payment.refund` now require a bounded caller key and use the V27
  parent operation as their sole replay owner;
- resolved refund amount and payer create/update mode are stored as bounded parent
  summaries before the provider call, with no duplicate receipt in payer or payment
  metadata;
- same-key replays do not issue another provider mutation, changed desired input returns
  `409`, and provider-success/local-projection failure becomes reconciliation-required;
- payer setup and sync keys persist across browser reload within exact user, studio,
  workflow, and payer scope, without storing access tokens;
- final focused evidence is 53 backend tests plus 45 subtests, 165 adjacent backend tests
  plus 83 subtests, 9 frontend model tests, TypeScript, targeted ESLint, and
  `git diff --check`.

This commit is not yet integrated with the V28 per-step schema and has not been pushed.

Replay-safe plan synchronization is preserved as local commit `de027d5` on the same
branch:

- plan create/update are local-only and expose an honest pending state instead of hiding
  provider calls;
- explicit `plan.sync` uses one V27 parent for a product-only update and an immutable V28
  product-plus-price plan when two provider mutations are required;
- product/price identity, account generation, partial success, local projection, old-key
  replay, and browser reload key retention are covered;
- exact parent/local provider identity is rechecked on completed and projected replay, so
  drift fails without another Stripe call;
- final evidence is 27 focused backend tests plus 38 subtests, 189 adjacent backend tests
  plus 93 subtests, 12 frontend model tests, Python compilation, TypeScript, targeted
  ESLint, API generation, and `git diff --check`.

This commit also remains local and unpushed until it is integrated with the V28 schema.

The V28 per-step ledger is preserved in local commit `3df67c0` on
`codex/payments-operation-steps-v28`:

- an immutable two-to-32-step plan is registered before the first provider call;
- every step owns exact request, provider-operation, Stripe-key, account, generation,
  lease, attempt, provider-result, and proof-backed recovery evidence;
- predecessor ordering and parent-to-step lock order prevent a later call from running
  before an earlier provider result is known;
- a parent cannot reach provider-succeeded until every registered step has exact success
  evidence, and partial or ambiguous outcomes move it to reconciliation;
- canonical and V26-to-V27-to-V28 restored chains produce the same V9 semantic manifest;
- resource replay and different-key adoption require the exact original actor, preventing
  one staff member from continuing an operation attributed to another;
- migration 121, both restore chains, every concurrency and attestation-negative check,
  all 40 SQL contracts, 11 readiness tests, and all 61 rollout tests pass;
- final pinned observations are V28 semantic
  `0:1de704b805b929154bf88e1727838d0d95c1c3da16246c3d48c3bdafafcb5931`,
  V28 operational
  `0:e8802a0d7f2f7eb77d416d8c95af1cc10686425ef48a6852406cbd01d9059b4d`,
  and canonical/restored V9
  `5641619e5c03ccf472b87226fd633f366b382a44e227adf581ca1b5c900ccfd1`.

The 2026-08-26 approval authorizes the V28 release-trust-anchor repins, the diagnostic
label updates, and explicit fail-closed restore assertions. Those changes are now an
active implementation gate. V28 is complete only after the canonical and restored chains
produce identical final observations and the full 121-migration/40-contract suite passes
with every expected digest pinned from that exact state.

Replay-safe invoice creation and retry are implemented but not committed on
`codex/payments-single-call-replay`:

- `invoice.create` requires an exact synchronized payer generation and registers one V28
  invoice-create step plus one ordered step per normalized line item before Stripe;
- `invoice.retry` uses a V27 parent plus V28 resource ownership and caller-key aliases, so
  different browser keys for the same invoice adopt one canonical operation;
- ambiguous retries never age into an automatic second pay. They remain blocked until an
  Admin supplies proof through the recovery RPC, whose revision and lease-owner compare
  and swap admits one recovery winner;
- the old invoice-create helper, retry table/alias execution path, automatic 24-hour
  expiry, and automatic expired-lease acquisition are removed from active code;
- focused invoice-operation tests pass 21 of 21. After migrating the four legacy
  assertions to proof-bound recovery and resource-alias behavior, the full backend passes
  1,209 tests plus 5,104 subtests;
- frontend invoice create/retry keys persist across reload in exact user/studio/resource
  scope, with 14 focused tests, TypeScript, targeted ESLint, and 700 non-browser frontend
  tests passing. Three Chrome-backed tests remain blocked by the local Chrome launch
  environment.

The invoice create/retry slice is preserved in local commit `299b622` and remains
unpushed. Its required V28 schema is now preserved and fully verified in `3df67c0`; the
two checkpoints have not yet been assembled on the final integration branch.

Replay-safe invoice closeout is preserved in local commit `d403dcf`:

- `invoice.finalize` requires a caller key and exact current invoice, payer, account, and
  generation readback; automatic invoices use one V27 mutation, while hosted invoices
  register a complete V28 finalize-then-send step plan before the first mutation;
- a partial finalize/send outcome becomes reconciliation-required and cannot repeat
  either provider call without proof;
- `invoice.void` uses one actor-bound invoice resource and V27 parent, and an ambiguous
  provider success can converge by readback without another void call;
- hosted-send errors retain a sanitized support reference without logging provider
  request details or secret-shaped text;
- the full backend passes 1,231 tests, focused frontend key tests pass 15 of 15, and
  TypeScript, targeted ESLint, API contract generation, Python compilation, and diff
  checks pass.

This application checkpoint still needs the additive post-V29 schema extension that adds
`invoice.finalize` and `invoice.void` to the exact provider-operation/resource catalog.

The V30 migration
`20260826155911_payments_workflow_catalog_and_replay_repairs.sql` is preserved in local
commit `199340b` after the explicit release-authority approval. It:

- adds exact read-by-key replay for projected enrollment transitions;
- adds distinct proof-bound reconciliation owners for whole-due readback and item-due
  pre-provider drift;
- adds `invoice.finalize` to the provider-operation type contract and distinct
  `invoice_finalize`/`invoice_void` resource ownership;
- adds a service-only invoice-closeout claim RPC with exact Admin, tenant, payer, account,
  generation, resource, actor, hash, and alias checks;
- persists canonical, nonempty, sorted, duplicate-free per-grant Stripe operation
  allowlists and makes exact operation membership part of every atomic live permit;
- retains the historical grant signature only as an attested disable-only wrapper, so
  it cannot reintroduce an operation-unbounded enable path;
- advances release readiness to 123/V30 and proves both the canonical migration chain
  and a PostgreSQL 17 V29 dump/restore followed by V30;
- passes all 123 migrations, both restore paths, every negative and concurrency gate,
  all 42 SQL contracts, and all 61 rollout-tool tests;
- pins replay-repair manifest
  `0:bf7208ee6b49620e3ef146812c6e69fa8bc73058086d6d7df12c91ec41888f55`,
  V30 operational contract
  `0:7d3b98ad5301ac1eb04eb1131f16f58158e37c3d4c7e01afbe427d46294ccd2a`,
  V30 operational manifest
  `1449e613ab87fea18e9f7678f96215d528b80b5d0c44c5da0f29323bdc392198`,
  and predecessor V10 manifest
  `689cf757117638efbf23579f77a2ba10638d710350e7dfd18d99f061503ef27b`.

The additive V31 candidate
`20260826185651_payment_refund_payer_sync_resource_ownership.sql` closes the
latest-head review findings without changing the historical V26 through V30 restore
anchors. It:

- gives `payment.refund`, `payer.sync`, and `plan.sync` one row-locked resource owner,
  with immutable caller-desired hashes separated from database-derived resource versions;
- derives plan ownership from the locked plan fields instead of trusting the caller hash,
  and proves both product and price step projections before a changed plan can replace a
  completed owner;
- serializes `invoice.finalize`, `invoice.void`, and `invoice.retry` through one
  invoice-level mutation owner while retaining operation-specific aliases for exact
  historical replay;
- keeps payer create/update local-only so the named `payer.sync` owner is the sole
  customer mutation path, and backfills linked payer generations only when their stored
  account is the studio's exact current Connect account;
- adopts a missing legacy invoice generation only when the invoice, payer, customer, and
  current Connect account match exactly. Present, malformed, stale, external, or
  conflicting identity evidence remains untouched and fail-closed;
- adopts missing legacy plan-price and provider-backed subscription generations only
  when their locked Stripe identities match the studio's exact current Connect account
  generation. Stale, conflicting, or explicitly populated generations remain untouched;
- collapses same-version concurrent keys, replays an old alias after later state changes,
  and permits a new owner only after the authoritative resource version advances and the
  prior provider projection is proved;
- rejects a new refund key with an explicit settling conflict while the prior refund is
  pending, while exact-key replay remains available and failed/canceled refunds may start
  a new owner after projection proof;
- rejects unsupported refund reasons at the request boundary before any durable owner or
  Stripe mutation can be claimed;
- atomically revokes completed payer consent and setup evidence before disabling
  autopay, rejects usable pending setup and active subscription states, and prevents a
  later webhook replay from re-enabling the payer;
- keeps an enabled payer's active consent authoritative while a replacement setup is in
  flight, and atomically closes a policy-blocked no-object setup without stranding its
  request, consent, or provider operation;
- requires a fresh automatic invoice retry to hold current consent for the exact payer,
  account generation, invoice payment method, and SetupIntent through the provider-pay
  boundary. Manual retries, completed replay, and reconciliation-only reads stay separate;
- keeps invoice/payment webhooks from rewriting the payer's consent-bound default
  payment method; only the payer-owned setup projection may establish that field;
- derives live Connect Payments scope readiness from the dedicated capability sentinel,
  then enables each workflow only when its exact required Stripe operations are granted;
- treats recorded external payments as local accounting evidence only. They never mark a
  connected Stripe invoice paid out of band or issue another provider mutation;
- caps invoice creation at 31 line items so the registered parent plus item steps remain
  within the database's 32-step provider plan bound, and records `voided_at` for a local
  invoice void;
- retains a 30-minute local setup-operation deadline while requiring at least 30 minutes
  of Stripe Session lifetime at mutation time;
- reclaims expired due-work leases with the already-bound provider operation instead of
  creating a second mutation owner;
- keeps whole-subscription period-end work retryable through the bounded provider
  transition grace, then either converges from the original operation or fails closed
  into reconciliation without creating a second mutation owner;
- completes whole-subscription due work from intent-bound identity when a cancellation
  webhook reaches local projection first, without issuing a second provider mutation;
- returns each active scheduled period-end intent and revision through a narrow
  service-role RPC so reload preserves the exact revoke target;
- schedules shared-item period-end removal through one exact two-step Stripe Subscription
  Schedule plan, retains both the item and schedule IDs plus the parent lease, and proves
  the same provider-backed state progression through projection and completion;
- preserves local-only revoke for legacy schedules that never created a provider schedule,
  while a provider-backed revoke locks and proves the completed create/update plan before
  releasing it;
- completes provider-scheduled shared-item work through a group-first, current-account
  generation-bound CAS that rotates every surviving item family together and binds exact
  replay to the canonical old-to-new item mapping;
- normalizes only legacy `partially_refunded` and `refunded` invoice rows from immutable
  gross-payment evidence, recomputes affected payer receivables, and proves payment,
  refund, dispute, and provider-operation rows are byte-for-byte untouched;
- advances the exact release state through schedule V25 to 126/V31 and adds independent V24-to-V25 and
  V30-to-V31 PostgreSQL 17 restore assertions;
- pins resource ownership
  `0:dff56b2572ace65f3d68f0b6e378604c2757356cf3d5057ca186343a76c12426`,
  the V31 operational contract
  `0:7a2fb92bc9aee799df0a64228788e08d4d63e2df0a7e0fb255216d8716a9413d`,
  the V31 operational manifest
  `441d38fe480a784c240e27467565b61d4477cece606da32737391d6d86c2eb3f`,
  and expectation state
  `1:afbce12f6f62d8cc55e4caf44d625915bb72f6a1d9cd9fb02f412103fcc154eb`.

Latest local candidate evidence before publication:

- backend: all 1,360 tests passed;
- frontend: all 728 tests passed outside the sandbox, including the three
  Chromium-backed print-geometry tests;
- frontend TypeScript, full ESLint, and the production build with safe
  placeholder build-time configuration passed;
- API contract generation, 52 environment tests, and the explicit nine-check staging
  isolation guard passed;
- the rollout tool passed all 63 tests and the aggregate release-workflow gate
  passed all 125 tests;
- all 126 migrations, every inherited and new restore path, every negative attestation,
  every concurrency suite, and all 44 SQL contracts passed on ephemeral PostgreSQL 17;
- a disposable Supabase provider-image reset applied all 126 migrations with the same
  V31 trust anchors and canonical
  `functions=103:ff9c817084afa9d6651532503e87fe4c5fc04c82356e00012670526662bf6188:0`
  catalog state, the release UI atomic contract passed, and database lint reported no
  errors;
- `git diff --check` passed.

Before the exact-head staging phase, no live grant, provider mutation, hosted write, or
deployment had occurred.

Issue #108 is preserved in local application commit `9cac6b0`:

- one immutable backend catalog owns every mutating billing route and internal due
  worker, with exact role, Stripe operation, prerequisite, live scope, classification,
  and denial metadata;
- every decorated `connected_*` Stripe sink is classified, and the customer default
  payment-method mutation is explicitly unsupported;
- Admin and Front Desk receive only sanitized workflow capability triples while
  Instructor receives none, and backend authorization remains authoritative;
- the operator CLI and application store require the exact V30 operation-array writer;
- the exact lane passes 1,267 backend tests plus 5,107 subtests, all 715 frontend tests,
  generated API contracts, TypeScript, targeted ESLint, and diff checks.

Recurring enrollment activation is preserved in local commit `9350f2b` on the
application branch:

- the explicit activation action requires an exact recurring plan price, payer customer,
  payer consent/payment method where applicable, account generation, enrollment resource
  owner, and caller key;
- create-subscription, add-item, and update-shared-quantity each issue exactly one stable-key
  provider mutation under the existing quantity lock;
- generic provider update, pause, resume, cancellation, rewire, paid-in-full auto-invoice,
  and active-subscription autopay-disable behavior fail closed pending their named
  workflows;
- the old implicit activation, detach/cancel, and paid-in-full provider-mutation methods
  are removed from the lifecycle, manager, and private facade;
- resource replay and adoption are actor-bound, provider readback cannot label an
  incomplete or past-due subscription current, and balance recomputation is recoverable
  before operation completion;
- 14 focused activation tests pass; the full backend passes 1,224 tests plus 5,104
  subtests after migrating the legacy assertions to named workflow contracts;
- frontend activation-key persistence has four focused tests; TypeScript, targeted ESLint,
  API generation, Python compilation, and diff checks pass. The full frontend reaches 704
  non-browser passes plus the same three local Chrome-launch failures.

The 2026-08-26 approval authorizes Front Desk recurring activation and replacement of the
six legacy implicit cancellation, rewire, and paid-in-full auto-invoice assertions with
named period-end, separate-invoice, and unsupported-generic-workflow contracts. The #107
database state machine is preserved in local commit `da68027` after V28 commit `3df67c0`:

- migration `20260826102840_enrollment_period_safe_transitions.sql` advances the release
  to 122 migrations and V29;
- service-only immutable intents and aliases bind schedule, revoke, due execution, and
  Admin immediate cancellation to exact payer, subscription, item, account, generation,
  period boundary, quantity, actor, request, reason, and provider evidence;
- whole-subscription period-end scheduling performs one native provider mutation and uses
  readback-only due completion; item transitions perform exactly one due mutation;
- due claims and revocation serialize across sessions, ambiguous work requires proof-bound
  recovery, and generic pause, resume, rewire, and active-subscription autopay disable
  remain unsupported;
- 122 migrations, both restore paths, every inherited and V29 negative attestation, all
  concurrency suites, 41 SQL contracts, and all 61 rollout tests pass;
- final pinned V29 observations are transition
  `0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60`,
  operational contract
  `0:acb02796bef50ae55a9201315769fec5702de102fb251747f57d6a46cba71407`,
  and operational manifest
  `cf3ce387638a39bb70488a2bfd2c1e3b419df373d3f00dc28a4d371864e76abb`.

The #107 application and bounded worker are preserved in local commit `35936e0`:

- named caller-keyed schedule, revoke, Admin immediate-cancel, item-due, and whole-due
  services consume the V29 intents and V27 provider operations;
- read-by-key replay runs before mutable enrollment checks, and pre-provider item drift
  plus ambiguous whole-due readback have distinct V30 reconciliation owners;
- whole due performs no second provider mutation, while item due deletes the unused item
  or writes the exact remaining quantity after authoritative readback;
- the protected internal worker endpoint requires its own backend-only secret; V31 keeps
  period-end scheduling fail-closed unless the repository-declared five-minute staging
  Render Cron Job is active, while production remains disabled pending approval;
- the full backend passes 1,240 tests plus 5,104 subtests; the full non-browser frontend
  passes 711 tests; focused transitions pass 30; API generation, TypeScript, targeted
  ESLint, and diff checks pass.

## Pull-request disposition

| Item | Current role | Disposition |
| --- | --- | --- |
| PR #133 | Integrated migration/readiness dependency | Its complete four-commit schedule-window change is integrated into PR #134 before the seven Payments migrations. Keep #133 unmerged and close it as superseded after the combined head is pushed and verified. |
| PR #111 | Reconciliation and checkpoint v3 | Closed without merge on 2026-08-25. Its corrected intent is implemented and reverified from current `main` in local commits `6525905` and `c97c565`; the old PR head remains historical evidence only. |
| PR #75 | Refund and dispute convergence | Closed without merge on 2026-08-25. Its valid accounting intent is implemented and reverified from current `main` in local commit `c97c565`; the old PR head remains historical evidence only. |
| PR #110 | Reviewer-owned migration plan | Closed without merge on 2026-08-25. This document supersedes it as the active delivery plan. |
| Issue #106 | Replay-safe provider writes and payer-owned consent | Implement as an ordered workstream in the single Payments release branch and PR. |
| Issue #107 | Period-end enrollment cancellation | Implement after #106's durable operation identity in the same release branch and PR. |
| Issue #108 | Exact operation grants and role-aware capabilities | Implement after reconciliation, replay, and transition contracts exist, in the same release branch and PR. |
| Issue #109 | Narrow UI, staging proof, and canary runbook | Final workstream in the same release branch and PR after every lower-layer dependency is integrated. |

There are no remaining open Payments feature PRs. PR #133 no longer owns a competing
migration tail because its complete change is part of this candidate. Green checks on
the separate #133 head and the closed #75 and #111 heads are historical evidence only;
the combined PR #134 head is the sole release candidate.

### Integration decision before publication

The dependency was resolved without merging #133: all four commits from its exact head
were cherry-picked into the existing PR #134 branch, then the Payments public preflight
chain was shifted to V6 through V12 and every catalog, expectation, restore, and rollout
anchor was regenerated. The combined 126-migration head is the only publishable sequence.

## Product contract for the first live release

Admin and Front Desk may perform ordinary plan, payer, setup-request, enrollment,
invoice, retry, reconciliation, external-payment, and period-end cancellation work when
the workflow capability permits it.

Admin alone owns Connect setup, plan archival, refunds, voids, disputes, immediate
cancellation, sensitive exports, exceptional overrides, and live-authorization work.

Instructor receives no billing data or payment actions.

The first release must preserve these rules:

- Payment failure does not change training, attendance, roster, or membership status.
- Refund, dispute, retry, void, cancellation, and collection are separate actions.
- Stripe invoice `amount_remaining_cents` remains the invoice receivable.
- Refunds and disputes change payment and net-collected reporting without reopening the
  original invoice or automatically charging the payer again.
- Recurring autopay requires payer-owned, versioned consent plus successful payment-method
  readback. A staff assertion or an existing card is insufficient.
- Ordinary cancellation means stop billing at the verified paid-through boundary.
- The Koaryu Payments fee remains 50 basis points.
- Pause, resume, generic active-enrollment edits, broad autopay disable, and unsupported
  provider mutations stay unavailable, including to Admin.

## Workstream 1: reconciliation and checkpoint v3

Owner: replacement for PR #111 and issue #105.

Build from current `main`. Add a new migration after `20260824190500`; do not reuse the
old unmerged release count and attestation pins.

Required behavior:

- Use one centralized provider-event window wholly inside Stripe's retained Events
  history. Reject an explicitly requested older start instead of truncating it.
- Keep exact provider/local event equality inside the accessible window.
- Represent first-v3 bootstrap separately from later predecessor-overlap continuity.
- Require a valid predecessor, minimum overlap, and non-regressing local-ingest watermark
  after bootstrap.
- Prove platform and Connect webhook topology using fields Stripe returns plus independent
  delivery evidence. Do not read a nonexistent response-side `connect` property.
- Bind checkpoint evidence to Stripe mode, exact candidate SHA, report digest, account,
  Connect generation, event watermark, endpoint state, and expiry.
- Leave v2 rows readable for audit but prevent v2 checkpoints from authorizing new live
  grants.
- Disable old broad grants during migration. Create no replacement grant.
- Advance release readiness and the guarded rollout tool from the current 117/V24 state
  while preserving every existing recovery classification.

Verification:

- Frozen-time tests beyond August 2026.
- Provider-retention overflow and explicit-old-start denial.
- Bootstrap, overlap, missing predecessor, expired predecessor, broken overlap, and
  regressed-watermark cases.
- Provider-only, local-only, failed, nonterminal, unmapped, wrong-mode, wrong-generation,
  stale-SHA, stale-delivery, and topology-drift denial.
- Realistic Stripe Webhook Endpoint fixtures without a fabricated `connect` field.
- Operator tests proving that only an eligible schema-v3 production report can record a
  v3 checkpoint.
- Full local migration replay and all Supabase verification SQL.

Non-goals include operation-level grants, customer UI, a production checkpoint, studio
authorization, Stripe configuration changes, and money movement.

## Workstream 2: refund and dispute convergence

Owner: replacement for PR #75.

Build from current `main`. The current application already contains much of the old PR's
adjustment-linking code, so audit behavior before copying anything.

Required behavior:

- Match every adjustment using studio, connected account, Connect generation where
  available, and provider identifiers. Ambiguous matches stay reconciliation-required.
- Preserve refunds and disputes that arrive before payment projection, then link them
  when the exact payment appears.
- Use provider event timestamps and deterministic same-second terminal precedence.
- Keep duplicate, delayed, and out-of-order events monotonic.
- Make repeated and concurrent projection converge to one logical adjustment and stable
  totals.
- Count only provider-confirmed succeeded refunds in financial totals.
- Track active, won, lost, warning, and unknown dispute states without claiming a
  terminal result early.
- Keep gross paid, refunded, disputed, net collected, refundable remaining, and invoice
  receivable separate in schemas, responses, reports, and UI labels.
- Keep invoice receivable and payer past-due status unchanged by a refund or dispute
  alone. Recovery collection requires a separate supported invoice workflow.
- Store only bounded sanitized audit and error metadata.

Verification:

- Refund before payment, payment before refund, duplicate refund, delayed nonterminal
  refund, same-second ordering, partial and full refund, multiple partial refunds, failed
  refund, and over-refund protection.
- Dispute before payment, active to won, active to lost, delayed active after terminal,
  duplicate dispute, warning/inquiry, and unknown state.
- Refund and dispute on the same charge without double subtraction.
- Exact cross-tenant and cross-account collision rejection.
- Concurrent and repeated projection with stable totals.
- Invoice receivable and payer past-due state unchanged after refund or dispute.
- Honest audit wording and exclusion of raw provider payloads and secret-shaped data.
- A corrected fake-only `verify:tuition-lifecycle` command plus full backend and frontend
  suites.

Non-goals include automatic recollection, revenue recognition, external-payment edits,
invoice-target external settlement, cancellation timing, and customer controls.

## Workstream 3: replay safety and payer-owned consent

Owner: issue #106.

Add one durable billing-operation model shared by every later payment workflow. It must
bind one request key and normalized payload to one studio, actor, operation, account,
generation, lifecycle state, sanitized result, and reconciliation status.

Required behavior:

- Same key and payload resumes or returns the original result.
- Same key with another payload returns a stable `409`.
- An unknown provider outcome never causes an automatic second mutation.
- Completed results replay without another Stripe request.
- Provider success followed by projection failure becomes reconciliation-required and
  can converge later.
- Every public provider mutation requires one bounded `Idempotency-Key`.
- The frontend retains the key across timeout, rerender, refresh, and explicit retry.
- A payer-controlled short-lived setup link records versioned consent and payment-method
  completion. Staff may initiate the request but cannot create the consent evidence.
- Expired, completed, revoked, cross-payer, cross-studio, wrong-account, and
  wrong-generation links fail closed.

Cover payer sync, plan sync, payer setup, provider enrollment, invoice creation, payment
retry, refunds, and every other workflow declared supported for launch.

### Workstream 3 implementation cut

Keep local drafting separate from provider mutation. Creating or editing a payer or plan
must finish as a local write and leave an honest draft or sync-required state. The named,
keyed `payer.sync` and `plan.sync` actions own Stripe customer, product, and price writes.
This removes the current implicit Stripe calls from payer/plan create and update instead
of trying to make an ordinary form submission hide a provider workflow.

Use the V27 parent operation alone when a workflow has exactly one provider mutation.
Use the V28 child-step ledger when one logical request can issue two or more provider
mutations. Register the complete immutable step plan before the first provider call;
never append a newly discovered step after execution begins.

| Workflow | Provider plan | Completion rule |
| --- | --- | --- |
| `payer.sync` | One customer create or update | Customer identity and expanded default-payment-method fields are projected, then the parent completes. |
| `payer.setup` | One setup Checkout Session | The request returns the original short-lived URL, but recurring consent completes only from verified payer-controlled Checkout completion and payment-method readback. |
| `plan.sync` | Product create/update, followed by price create only when the exact immutable price does not already exist | Each required mutation has its own durable step. The locked plan fields define resource version, and both local product and price projections must match the completed step evidence before replacement. |
| `enrollment.activate` | Require synchronized plan and payer first; then create a subscription, add an item, or change one shared-item quantity | Bind the exact payer, plan, subscription, item, expected quantity, account, and generation before the provider call. Paid-in-full enrollment delegates to the keyed invoice workflow instead of nesting an untracked invoice flow. |
| `invoice.create` | Create one invoice, then one immutable item step per normalized line item | Step count and line-item hashes are frozen before the invoice call. The first release supports at most 31 line items, and projection completes only after every item has a provider ID and authoritative invoice readback converges. |
| `invoice.finalize` | Finalize once, followed by send only for an exact `send_invoice` readback | Register the complete V28 step plan before finalization; partial finalize/send success is reconciliation-required and never repeats a provider call without proof. |
| `invoice.retry` | One invoice-pay mutation | The operation keeps its own exact-key aliases but shares one invoice-level mutation owner with finalize and void, so no competing nonterminal invoice mutation can reach Stripe. |
| `payment.refund` | One refund mutation | Eligibility and exact account generation are verified before the provider call; provider success and local adjustment projection must both converge before completion. |
| `invoice.void` and any supported immediate cancellation | One provider mutation each | Keep Admin-only policy separate from replay mechanics, require a bounded key, and bind the exact resource. Invoice void shares the same invoice-level owner as finalize and retry. |

The child-step state is provider evidence, not a generic workflow engine. Local validation,
authorization, projection, audit, and response assembly remain in the owning billing
service. A parent reaches provider-succeeded only when every registered provider step has
exact success evidence. A partial or ambiguous step moves the parent to reconciliation
and blocks later steps until an explicit proof-backed recovery decision.

The frontend must persist an outstanding key across a page reload, scoped to the exact
user, studio, workflow, and object. Clear it only after a known terminal result; retain it
after timeout, lost response, `5xx`, or reconciliation-required state. A deliberate new
action receives a new key. Do not store access tokens, hosted URLs, payer data, or provider
payloads in browser persistence.

## Workstream 4: period-safe enrollment transitions

Owner: issue #107.

Use workstream 3's operation identity rather than creating another replay system.

Required behavior:

- Add named schedule-period-end, revoke-scheduled, and Admin immediate-cancel actions.
- Keep an enrollment active through its verified paid-through boundary.
- Store a durable transition bound to enrollment, payer, subscription, item, studio,
  account, generation, expected boundary, actor, and request key.
- At execution, reduce a shared item to the exact remaining count, delete only an unused
  item when other items remain, or end the whole subscription when nothing billable
  remains.
- Use native `cancel_at_period_end` only when it exactly represents whole-subscription
  intent.
- Use an atomic lease and bounded worker for future item-level mutations.
- Re-read provider state immediately before mutation and fail to reconciliation on drift.
- Keep immediate cancellation separate, Admin-only, reasoned, replay-safe, and unrelated
  to refunds.
- Keep pause, resume, generic active-enrollment updates, and autopay disable closed.

## Workstream 5: operation grants and workflow capabilities

Owner: issue #108.

Required behavior:

- Persist exact canonical Stripe operation allowlists with each live grant.
- Treat null, missing, empty, wildcard, prefix, duplicate, and unknown operations as
  denied.
- Bind the operation set to the existing studio, account, generation, checkpoint, SHA,
  expiry, and revision checks.
- Keep the final one-call authorization check immediately before every Stripe mutation.
- Define one small server-owned workflow catalog containing support status, permitted
  roles, exact Stripe operations, required object facts, live-grant requirement, and
  stable denial reason.
- Return sanitized role-aware workflow capabilities to Admin and Front Desk. Return no
  billing capabilities or data to Instructor.
- Map every billing mutation route to exactly one catalog workflow.
- Make every `connected_*` Stripe sink supported, internal-only, or explicitly
  unsupported. Leave none unclassified.

A one-operation canary grant must prove that every other connected Stripe mutation stays
blocked.

## Workstream 6: launch UI and release proof

Owner: issue #109.

Local implementation is complete on the single integration branch:

- the Billing UI renders plan sync, payer sync and payer-owned setup, recurring
  activation, named period-end and Admin immediate cancellation, and invoice
  finalize/retry/void only when the server returns the exact workflow capability;
- raw provider object identifiers were removed from the primary plan, payer, enrollment,
  and invoice tables;
- persisted caller keys remain scoped to user, studio, workflow, and resource; ambiguous
  outcomes retain the key, while confirmed success or a terminal 409 rotates it so the
  backend's corrected-request path is reachable;
- the Stripe rehearsal worksheet and validator are schema v3 and structurally require
  the complete launch flow, exact 50-basis-point arithmetic, same-key ambiguous recovery,
  distinct webhook surfaces, and zero unsafe terminal counts;
- `docs/koaryu-payments-staging-and-rollback.md` owns exact staging order, rollback, and
  the unexecuted production packet.

Rebase after workstreams 1 through 5 merge. The UI must consume server capabilities and
still expect routes to fail closed when state changes after render.

Expose only the supported Connect, plan, payer setup, enrollment, invoice, retry,
reconciliation, refund, status, and period-end cancellation workflows. Preserve the
original request key during uncertain outcomes. Show pending and reconciliation-required
states honestly. Keep raw Stripe identifiers out of the primary UI.

Verify Admin, Front Desk, and Instructor behavior plus keyboard use and 360 by 800 and
390 by 844 layouts. Preview mode must make no provider mutation.

Update pricing, onboarding, Terms, payer-consent, refund, cancellation, and fee copy so
the public contract matches the code. Final commercial and consent language still needs
director approval before production use.

## Dependency and merge order

The complete PR #133 schedule-read change precedes Payments in this candidate. Its
schedule V25 state at migration 119 is an accepted rollout origin; the guarded packet
then selects exactly the seven Payments migrations through V31. Do not merge or deploy
the old #133 branch separately.

Workstreams 1 and 2 were developed together in isolated worktrees. Integrate them only
after rebasing onto the authoritative base, rebuilding their additive release tail, and
rerunning the current proof on the exact new head.

Workstreams 3 and 4 may be designed together after reading the final workstream 2
contract. Merge workstream 3's operation model first, then make workstream 4 consume it.

Workstream 5 consumes the v3 authorization contract and the exact workflow names from
workstreams 3 and 4. Workstream 6 integrates only after every lower dependency is present.

The isolated worktrees are implementation checkpoints, not publication branches. Combine
all six completed packets into one clean `codex/` release branch and open exactly one
Payments pull request against `main`. Keep that PR unmerged. Push every correction and
review-loop change to the same branch and PR; do not create competing Payments PRs.

## Repository verification gate

Every final payment candidate must pass:

- Full backend tests.
- Full frontend tests, lint, and production build.
- `npm run check:api-types`.
- `npm run check:supabase-contracts-local`.
- The corrected tuition lifecycle proof.
- Replay and consent proof from workstream 3.
- Period-transition and worker proof from workstream 4.
- Operation-grant and capability proof from workstream 5.
- Updated Stripe provider-rehearsal template and validator checks.
- Deterministic performance regression gate.
- Static and secret analysis.
- `git diff --check` and final diff inspection for temporary workflows, generated noise,
  secrets, provider payloads, hosted URLs, and completed canary evidence.

Tests and CI must use fakes, local PostgreSQL, and Stripe test fixtures only. They must
not contact production Stripe or production Supabase.

## Staging proof

Use one exact candidate SHA, one staging studio, one connected test account, and one
account generation. Verify the deployed staging frontend and backend report that exact
SHA and Stripe test mode.

The private rehearsal must cover:

1. Connect onboarding and readiness.
2. Exact operation authorization and role-aware capabilities.
3. Plan and price convergence.
4. Payer and customer convergence.
5. Payer-owned consent and duplicate completion replay.
6. Two students sharing one payer, plan, subscription item, and quantity two.
7. One supported invoice-link flow.
8. One successful automatic payment with exact 50-basis-point fee evidence.
9. A failed-payment and supported retry.
10. Period-end schedule, revocation, and shared-family transition proof.
11. Refund and dispute convergence.
12. Separate platform and Connect webhook delivery plus local processed readback.
13. Same-key recovery after an ambiguous response with no second mutation.
14. Zero failed, stuck, unmapped, wrong-mode, wrong-generation, or
    reconciliation-required rows at completion.

Keep completed evidence private and sanitized. Commit only the template and validator.

## Production cutover and attended canary

Before any production write, re-read live PR, deployment, database, restore, Stripe, and
alert state. A written plan is not current operational evidence.

Cutover order is database, backend, frontend:

1. Produce a fresh production dump outside the repository and restore it into a
   disposable PostgreSQL 17 instance. Compare row counts and preserve its private hash.
2. Apply the final additive migrations through the guarded rollout tool after explicit
   confirmation. Do not run direct contract or ad hoc SQL against production.
3. Deploy the exact backend SHA manually and verify `/health/ready`.
4. Create a production-target Vercel deployment from the merged git SHA. Never promote a
   staging preview build because its public variables point to staging and Stripe test
   mode.
5. Verify the frontend and backend use the exact reviewed SHA and production resources.
6. Complete the exact-candidate staging rehearsal.
7. Run production reconciliation read-only and privately disposition every relevant
   historical failure or unmapped event.
8. Record one fresh schema-v3 checkpoint bound to the exact deployed SHA.
9. Verify one named pilot account and generation, plus zero ambiguous operations.
10. Dry-run one short-lived exact-operation grant and prove every non-canary sink remains
    denied.
11. Establish active webhook and reconciliation monitoring.
12. Run one attended low-dollar recurring payment with payer-owned consent and an amount
    whose 0.5 percent fee produces unambiguous cents.
13. Verify provider and local payer, enrollment, subscription, quantity, invoice,
    payment, fee, event, and operation state.
14. Issue one explicit refund and verify its provider and local projection.
15. Choose period-end or immediate cleanup explicitly. Cancellation does not imply a
    refund.
16. Revoke the operation grant immediately.
17. Run post-canary read-only reconciliation and prove that no non-canary mutation was
    authorized or observed.

Stop on any amount or fee mismatch, wrong account or generation, duplicate object,
unexpected mutation, missing webhook delivery, failed projection, stale SHA or
checkpoint, or reconciliation-required operation.

Rollback closes new writes. Revoke the grant and disable the product workflow while
preserving provider objects, webhook ingestion, event evidence, and reconciliation. Do
not delete evidence, reset Connect, disable webhooks, or blindly retry an ambiguous call.

## Completion gates

Implementation complete for this delivery means all six workstreams are integrated into
the single unmerged Payments PR, its exact head passes required CI and both independent
latest-head reviews, and the exact same SHA passes the staging rehearsal validator and
browser checks. The repository and staging environment still default to no ongoing
studio authorization.

Canary complete means the grant is revoked, payment economics and projections reconcile,
refund and cleanup have known outcomes, post-canary reconciliation is eligible, and no
operation remains ambiguous.

Pilot enabled is a separate decision. It requires approved commercial and consent copy,
named support ownership, active receipt-bearing payment alerts, an acknowledgement and
escalation path, rehearsed support procedures, retention and redaction rules, and a new
bounded ongoing grant for the named studio.

A successful canary does not enable a pilot automatically.

## Final delivery directive

Apply this section only after every existing Payments implementation workstream is
complete and the exact assembled local candidate is green.

### One branch and one pull request

Assemble all Koaryu Payments work on one clean `codex/` branch and open one pull request
against `main`. Do not merge it. The PR must contain every completed Payments workstream,
all migrations and generated contracts, tests and verification scripts, staging and
rollback documentation, an explicit supported/unsupported workflow matrix, and exact
local and staging evidence.

Push every correction to that same branch and PR. Do not open a competing Payments PR.

### Exact-head independent review loop

Before staging deployment, obtain two independent reviews of the exact PR head:

1. Comment `@codex review` on the PR to request GitHub Codex review.
2. In a clean checkout of the exact PR head, run Claude Code with the exact Opus 5 model
   in skeptical, read-only mode. Its review must cover duplicate or ambiguous charges,
   idempotency and replay, refund/dispute accounting, payer consent, tenant and Connect
   generation isolation, authorization and staff roles, migration safety, concurrency
   and webhook ordering, and staging/production rollout safety. Claude must post its
   findings directly to the PR as a review or PR comments.

Do not silently substitute another Claude model. If Opus 5 is unavailable, stop at that
boundary and report the blocker. If GitHub Codex is temporarily unavailable, run an
independent local Codex review of the exact head, post its findings to the PR, and record
that the GitHub reviewer was unavailable.

Treat payment correctness, duplicate mutation risk, authorization, tenancy, consent,
reconciliation, migration, data loss, and deployment-safety findings as blocking. After
either reviewer finds a blocker:

1. Fix the root cause and add or strengthen the proving test.
2. Push the correction to the same PR.
3. Resolve the review thread with evidence.
4. Request fresh Codex and exact Claude Opus 5 reviews of the new head.
5. Repeat until both reviewers have inspected the latest head and report no blocker.

Answered comments are not review completion. Required CI must also be green on the exact
reviewed head.

### Staging-only release proof

Only after the review loop is clean:

1. Apply the exact PR migrations to staging Supabase.
2. Deploy the same PR-head SHA to staging Render and Vercel.
3. Verify frontend, backend, database readiness, and Stripe test mode all agree on that
   environment and exact SHA.
4. Change only the Stripe test-mode objects and webhooks required by the rehearsal.
5. Run the complete staging provider rehearsal.
6. Test the deployed product in a browser on desktop, 390 by 844, and 360 by 800.
7. Fix every staging/browser defect, push it to the same PR, repeat both reviews whenever
   payment behavior changes, and redeploy the exact new head.
8. Leave the final staging deployment running for personal review.

Do not touch production, Stripe live mode, production webhooks, production Supabase,
production Render, production Vercel, or real money.

### Required stopping state

Stop only when all of the following are true:

- the single Payments PR is open, current, and unmerged;
- required CI is green;
- GitHub Codex and Claude Code Opus 5 have no unresolved blocking findings on the latest
  head;
- staging runs that exact reviewed SHA;
- Stripe test-mode flows and both webhook surfaces pass;
- desktop, 390 by 844, and 360 by 800 browser testing pass;
- no operation is duplicated, stuck, failed, unmapped, wrong-generation, or
  reconciliation-required;
- the staging URL remains available for personal inspection;
- the production deployment packet is complete but unexecuted.

The final handoff must provide the PR URL, staging URL, exact SHA, both review results,
required-CI status, staging test results, login instructions, a short click-through
checklist, remaining non-blocking limitations, and the exact production steps awaiting
approval.
