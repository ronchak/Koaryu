# Payment facts verification

Base: `4af5c13625b1bfc45998e4a3bb8746deba12004e`, after PR #154.

The payment projector previously stamped each successful observation with the current time. A distinct later success could move the same payment into another UTC month. Truthy defaults also replaced a stored zero fee and a zero received amount. Broad reconciliation treated an authorization awaiting capture as successful collection. The Reports fee card displayed a duplicate payment total rather than actual fees.

The correction preserves established payment timestamps. Invoice payment time or successful event time initializes a missing value; absent those facts, first-observed success time is the explicit fallback. Existing timestamps are not restated. An unset value is assigned with an `IS NULL` condition. If that represented update affects no row, the code rereads the same payment and retries at most once with its current state and event guards. It never retries a provider call or exception, recreates a deleted row, or writes an older timestamp back from a stale read.

Zero received amounts and zero configured fees remain zero. Later lower-status observations preserve already collected amounts and adjustments. Broad reconciliation returns a conflict for an uncaptured authorization before writing payment, invoice or audit rows. Its existing Connect status read can still refresh the account projection. The duplicate fee card, its threaded property and its obsolete assertion are removed; Stripe and external totals retain availability and UTC adjustment disclosures.

## Evidence

- Baseline payment-intent, invoice lifecycle, Connect account, webhook ordering and payment suites: 131 passed, 56 subtests passed.
- New timestamp/cohort, explicit-zero received and zero-fee cases failed before the correction. The corrected uncaptured-authorization test was also checked against the original reconciliation class loaded in memory; it failed specifically because the expected exception was not raised. This control made no repository change.
- Focused seven-suite run passed 396 tests and 74 subtests. Command: `cd backend && venv/bin/python -m pytest tests/test_billing_payment_intent_lifecycle.py tests/test_billing_invoice_lifecycle.py tests/test_billing_connect_accounts.py tests/test_billing_webhook_ordering_lifecycle.py tests/test_billing_payments.py tests/test_billing_enrollment_activation.py tests/test_billing_invoice_operations.py -q`.
- Frontend billing-page model: nine tests passed. Lint passed for both changed billing components and the controller/model.
- Broader `cd backend && venv/bin/python -m pytest tests/test_billing*.py tests/test_webhook_service.py tests/test_stripe_mutation_policy.py -q`: 820 passed, 300 subtests passed.
- `npm run check:api-types` passed. Frontend production build passed after exporting `.env.example`, using the same setup as CI. The required exact-head release gate remains mandatory.
- Independent review inspected the complete diff, surrounding state/adjustment code, installed PostgREST return behavior and the tests, and received `GREEN LIGHT`.

The tests exercise both success-source orders, June/July cohort membership, eventless replay, first-observed fallback, a competing timestamp initializer and newer event watermark, real refund/dispute projection followed by lower-status observations, a zero payment against a positive invoice, and independent fee/default/rounding values. A 12,900-cent amount at 50 basis points still rounds to 64 cents under the existing rule.

Test setup replaces provider transport and database responses. The race fixture re-evaluates update filters after the competing change; it proves the application query contract, not a live PostgreSQL interleaving. PostgreSQL's [Read Committed behavior](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED) supplies the conditional-update guarantee. Stripe distinguishes [received amount and capture status](https://docs.stripe.com/api/payment_intents/object), [event time](https://docs.stripe.com/api/events/object) and [invoice payment time](https://docs.stripe.com/api/invoices/object). No hosted request, provider mutation, SQL execution or migration was used for this verification.

## Scope and test reduction

BB1-01/BT3-01 cover payment timestamp and cohort stability; BB1-04/BT2-05 cover explicit fee defaults; BB2-05 covers uncaptured refusal and received amount; FC1-05 is resolved by removing the unsupported fee figure. These entries remain pending until merge.

The touched payment-intent suite now imports only its required fixture types and imports ordinary dependencies directly. Two fee fakes reuse the production pure calculation with independent numerical assertions, removing competing formulas. The only deleted frontend assertion protected the removed duplicate value; the actual Stripe/external totals remain tested. Existing ordering, identity, refund, dispute and permission tests are retained.

This does not repair every payment/adjustment race, invoice audit closeout, client retry receipt, invoice paid-at value or historical record. Delinquency and shared-family allocation remain separate decisions. No public schema or database release is required. Reverting requires no data rollback but restores the identified defects. Production deployment remains separate from merge.
