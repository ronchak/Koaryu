# Current invoice collection facts

BB1-03 separates money outstanding from money overdue. The rule is settled: drafts, invoices due today or later, and invoices without a due date are never overdue. A positive collectible balance becomes overdue the day after its due date, using the studio's business date. Uncollectible amounts remain separate.

## Ownership

`billing_invoice_collection_facts_v1` owns this rule. It reads invoice facts without updating any invoice, payment or payer. Payer projections, Billing totals, and Dashboard attention counts consume it. Invoices without a payer remain in invoice-level totals and attention counts; they are not assigned to a family.

`recompute_billing_payer_balance_v1` retains its scoped payer lock and separate READ COMMITTED snapshot. It uses the shared calculation, preserves the existing balance sum, negative clamp and overflow failure, and stores only the legacy-compatible `current` or `past_due` label. The schema guarantees a non-null remaining balance, so the new calculation has no unreachable fallback.

Payer list/detail reads return current outstanding, overdue and uncollectible facts. Their display status may be `outstanding` or `uncollectible`; those labels do not change stored enum values. Unrelated explicit payer states remain available when no current invoice facts replace them. Successful contact writes do not acquire a new follow-up read or failure boundary. Responses without the new financial facts leave them unavailable.

Dashboard retains its existing unit, tuition issues: payer attention reasons, uncollectible invoices and overdue invoices. This is different from Billing's count of payer accounts requiring attention. Both use the same underlying overdue rule. The legacy Dashboard fallback replaces its three financial count queries with one scoped call; its role gate and other setup flags remain.

## Database and release boundary

V50 adds these read functions and updates the existing consumers. It changes no stored customer row. The only data update is a guarded release-expectation checksum reflecting the changed Dashboard definition. Historical migration files remain immutable. The new preflight checks current functions and privileges; predecessor readiness remains conditional on the complete V50 state.

The backend requires the new migration before deployment. Release all queued changes together, database first, then backend and production-target frontend. Production apply requires fresh verified backup/restore, one migration per invocation, the announce-and-pause protocol and unchanged customer-row comparisons. This plan is not evidence of a hosted apply.

There is no historical financial backfill, currency conversion, billing activation, new worker, polling loop or durable state mechanism. Mixed-currency reporting remains outside this correction.

## Acceptance

- Due yesterday/today/tomorrow, no due date, drafts, positive partial refunds, paid/void/refunded rows, zero and negative remaining balances.
- Uncollectible and mixed invoices remain distinct. Unassigned invoices remain in global totals without entering a family's totals.
- Reading the same rows on the next business date changes classification without a payment event or a stored-row rewrite.
- Billing and both Dashboard read paths consume the shared rule. Role-hidden financial data stays unavailable.
- Existing payer lock ordering, post-lock commit/rollback visibility, monetary overflow, tenant scope and payment/idempotency cases remain protected.
- A real V49 logical restore advances to V50 with retained rows intact and old-caller readiness preserved. Every current SQL contract, prior restore continuation and negative attestation check still runs.

The local tamper gate checks every declared metadata mutation against the current full preflight and independent raw facts. For each routine, the missing-function case also checks every compatibility reader and its rollback baseline. The immutable compatibility bodies forward the same current failure, so repeating that entire chain for every other mutation adds execution cost without testing a different contract. All historical positive readiness checks and all SQL contract files remain.
