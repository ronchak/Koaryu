# Billing workflow catalog

`backend/app/services/billing_workflow_catalog.py` is the application owner for
billing mutation classification. It maps every mutating `/billing` handler and the
internal enrollment due worker to one workflow. It also classifies every decorated
`connected_*` Stripe sink.

Each workflow records its exact staff roles, Stripe operations, object prerequisites,
live-grant scope, and stable denial code. The three classifications mean:

- `supported`: a named application workflow owns the mutation and its replay model.
- `internal_only`: reconciliation, worker, or operator behavior that the ordinary UI
  must not advertise.
- `unsupported`: a retained HTTP boundary that fails closed until a named workflow
  replaces it.

The catalog does not replace endpoint authorization. FastAPI still resolves the
current staff membership, and every live Stripe call still obtains an atomic database
permit for the exact operation. The frontend receives only workflow ID, enabled state,
and a stable denial code. It does not receive object identifiers, authorization rows,
recovery proofs, or operator evidence.

`enrollment.cancel.period_end.schedule` has an additional runtime prerequisite:
`BILLING_TRANSITION_SCHEDULER_ENABLED` must be true for that environment. The public
route also enforces the same interlock and returns 503 while it is false. Production
enables `BILLING_TRANSITION_SCHEDULER_ENABLED` and runs due transitions with the
in-process [billing-transition timer](render-backend-deployment.md#billing-transition-timer).
The staging manifest also declares the flag true; its five-minute Render Cron Job
stays suspended outside a deliberate proof. Before deploying a timer-capable build
to staging, disable its hosted flag as described in
[Render backend configuration](services.md#render--backend). Read the effective flag
value from the provider before acting. Revocation stays
available so an existing scheduled intent can still be withdrawn if the worker is
disabled.

V58 derives supported Connect operations from one exact database policy catalog.
`studio_live_billing_supported_operations_v58` supplies service-only capability hints;
each Stripe mutation still obtains a current atomic permit. Historical pilot grant rows
do not control GA capabilities. Branding remains internal-only, customer default payment
method mutation stays unsupported, and exact subscription schedule operations are included.
An existing account's dashboard capability is checked independently of initial-link recovery
and KYC. Onboarding links do not require charges to be enabled; payment workflows do.

Payer create and update are local database workflows. They never create or update a
Stripe customer implicitly; `payer.sync` is the only named customer mutation owner and
requires its own caller key, resource version, tenant, account, and generation proof.
Invoice payment webhooks record the payment's method on the payment evidence only; they
never replace the payer's consent-bound default payment method.

Catalog tests compare the live FastAPI router and decorated Stripe methods to the
catalog. A new mutation route or connected sink therefore fails CI until it receives an
explicit owner and classification.

The internal `enrollment.cancel.period_end.execute` workflow owns both the final
subscription-item mutation and release of the exact durable Subscription Schedule after
the transition becomes due. Its catalog entry must therefore retain
`connected_subscription_schedule.release` alongside the item delete/update operations.
