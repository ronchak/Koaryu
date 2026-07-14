# Billing Boundary and Activation Design

## Long-term destination

Koaryu should eventually support complete tuition lifecycle control without requiring routine Stripe Dashboard work.

The roadmap includes:

- enrollment and activation;
- trials;
- cancellation at period end;
- immediate cancellation;
- pause and resume;
- plan changes;
- proration;
- billing-anchor behavior;
- full and partial refunds;
- failed-payment handling;
- past-due recovery;
- reconciliation;
- accounting-relevant audit history.

This roadmap is not the automatically supported set for Friendly Pilot Core.

Visible frontend controls may be:

- fully functional;
- test-only;
- read-only;
- local-only;
- fail-closed;
- decorative;
- broken.

Never infer readiness from visible UI.

## Mandatory Phase 0 disposition

Before billing implementation, choose exactly one:

### CONTRACT ONLY

Default.

Deliver:

- complete control inventory;
- transition contract;
- authorization map;
- readiness classification;
- correction of misleading UI/docs;
- authorization and state-correctness blockers;
- tests of existing guarantees.

Do not add broad lifecycle behavior.

### NARROW TEST-MODE SLICE

Choose only when all are true:

- existing implementation is substantially complete;
- semantics are unambiguous;
- authorization is clear;
- idempotency exists or is a small correction;
- webhook reconciliation exists or is a small correction;
- work fits the release budget;
- no additional migration beyond the release limit;
- Friendly Pilot Core is not threatened.

Implement only the named transitions locked at the Phase 0 gate.

### SEPARATE BILLING RELEASE

Choose when:

- multiple semantics remain unresolved;
- a broad state-machine redesign is required;
- more than a narrow slice is missing;
- reliable provider behavior cannot fit the budget;
- billing would dominate the pilot release.

Friendly Pilot Core still includes instructor billing isolation and honest UI/docs.

## Control inventory

For every billing control, record:

- page and control;
- intended user action;
- frontend handler;
- backend route;
- authorization;
- local database effect;
- Stripe effect;
- idempotency behavior;
- webhook/reconciliation behavior;
- audit behavior;
- existing tests;
- current readiness;
- smallest action required.

Readiness values:

- WORKING TEST MODE
- READ-ONLY LIVE
- FAIL-CLOSED
- LOCAL-ONLY
- DECORATIVE
- BROKEN
- NOT REPRODUCED

## Transition contract

For each transition considered for implementation, define before coding:

- source states;
- target state;
- actor roles;
- required inputs;
- effective time;
- Stripe API action;
- idempotency key scope;
- local pending state;
- webhook events expected;
- reconciliation rule;
- timeout/failure presentation;
- retry behavior;
- duplicate-event behavior;
- out-of-order-event behavior;
- audit event;
- compensation or recovery action;
- test-mode proof;
- live-mode policy.

Do not begin implementing an unresolved transition.

## Conservative defaults

Use these unless a concrete product/provider constraint requires a decision:

- Ordinary cancellation occurs at period end.
- Immediate cancellation is Admin-only.
- Ordinary plan changes take effect at next renewal.
- Immediate prorated changes are Admin-only.
- Refunds are Admin-only.
- Refunds require amount, reason, confirmation, idempotency, and audit.
- Failed-payment state comes from provider/webhook reconciliation.
- Trials are explicit lifecycle operations.
- Pause/resume semantics must be defined explicitly.
- Local success is not persisted before durable provider or reconciliation state.
- Ambiguous production behavior fails closed.

## Required decision format

When user input is necessary, present a compact table containing:

- option;
- customer-visible behavior;
- Stripe behavior;
- accounting consequence;
- recovery behavior;
- recommended safe default.

Ask only when the choice materially changes financial behavior.

Do not ask broad questions that could have been converted into concrete options.

## Authorization

Admin:

- all supported transitions;
- exceptional and irreversible financial actions;
- refunds and overrides;
- Stripe Connect and global billing settings.

Front Desk:

- ordinary supported enrollment lifecycle;
- ordinary period-end cancellation;
- ordinary pause/resume if included;
- ordinary non-exceptional plan change;
- billing and reconciliation visibility.

Instructor:

- no billing data;
- no billing mutation;
- access denied before any sensitive fetch.

## Minimum safety for a narrow slice

Every included provider mutation requires:

- named route;
- server authorization;
- idempotency;
- double-click protection;
- retry safety;
- honest pending/failure state;
- webhook idempotency;
- reconciliation;
- audit behavior;
- Stripe test-mode proof;
- live-mode fail-closed proof without live mutation.

No generic PATCH may accept lifecycle status.

No UI may report completion when only a local request was accepted.

## Live activation gate

Live activation is separate from application deployment.

Do not enable live outbound mutations until:

- exact transitions are named;
- each passes in test mode;
- authorization is proven;
- idempotency is proven;
- retry behavior is proven;
- partial failure is proven;
- webhook reconciliation is proven;
- audit behavior is proven;
- rollback/fail-close behavior is documented;
- the user explicitly approves those exact transitions.

Approval for one transition does not approve future transitions.

If live activation is not explicitly approved, LIVE_BILLING_ENABLED or its successor remains closed.
