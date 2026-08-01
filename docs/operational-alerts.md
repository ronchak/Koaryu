# Operational Alerts Phase A

Status: **inactive recording foundation; no operational assurance**

Phase A establishes durable, counts-only alert episodes and delivery evidence. It does not send an email, Slack message, SMS, page, or webhook. It has no approved scheduler, primary address, backup human, external dead-man monitor, acknowledgment loop, or response-time assurance. `OPERATIONAL_ALERTS_ENABLED` must remain `false` in production until those activation dependencies are approved and implemented.

## Four-rule catalog

| Rule | Counts-only condition | Severity | Logical destination |
| --- | --- | --- | --- |
| `stripe-live-webhook-failure` | Live failed events older than 10 minutes, or processing events whose claim is older than 10 minutes | critical | `primary-owner` |
| `account-deletion-worker-overdue` | Scheduled deletion requests overdue by 24 hours | high | `primary-owner` |
| `support-urgent-untriaged` | Open urgent tickets untriaged for 30 minutes | high | `primary-owner` |
| `billing-reconciliation-stale` | Invoice retry operations in `reconciliation_required` for one hour | high | `primary-owner` |

Every rule uses `counts-only-v1`. Source inspection happens inside `operational_alert_metric_counts()` and returns only rule ID, aggregate count, and database observation time. The evaluator does not use PostgREST `HEAD`, range headers, client count metadata, or source-row selects anywhere in the alert path.

The envelope and durable audit may contain only the rule ID, environment, severity, full commit SHA, aggregate count, threshold/window, timestamps, logical destination ID, delivery/episode/attempt IDs, idempotency key, bounded error code, and receipt. They must never contain tenant, ticket, requester, student, customer, invoice, event, account, or user identifiers; Stripe payloads; ticket text; email addresses; URLs/query strings; browser context; credentials; or secrets.

## Durable delivery contract

One unresolved episode is keyed by `(environment, rule_id)`. Opening an episode creates one primary logical outbox item. Repeated positive evaluations update and deduplicate that episode. A clear observation closes it and cancels an unsent pending item. Phase A deliberately has no acknowledgment, escalation, reminder, backup delivery, or resolution-notification state.

Before any adapter invocation, `claim_operational_alert_delivery` leases the outbox row and inserts an immutable attempt with a caller-generated UUID idempotency key. The uniqueness contract is `(environment, rule_id, episode_id, attempt_key)`. A retry of the same claim returns the already persisted attempt. The adapter receives that key and must treat it idempotently.

Only `complete_operational_alert_delivery` may mark an outbox item `sent`. In one database transaction it first inserts an immutable successful outcome containing a nonblank receipt, then marks the outbox sent. A constraint trigger rejects sent state without its matching durable receipt. Failures append a bounded failure outcome/audit event and requeue the item. Attempts, outcomes, and audit events reject updates and deletes.

The only concrete adapter is `RecordingAlertDestination`. It performs no network I/O, deduplicates by attempt key, and returns a synthetic receipt. The guarded internal evaluator and Vercel proxy both reject production and are inactive by default. No Vercel cron entry is present, so merging this code cannot schedule evaluation.

Evaluator and deletion-worker heartbeats are durable primitives, not dead-man coverage. Detecting a missing evaluator heartbeat requires an independent scheduler and monitor; the evaluator cannot reliably page on its own failure.

## Response runbooks

### Stripe live webhook failure

1. Privately inspect Stripe Workbench delivery status and Koaryu's durable event state. Keep payloads, customer/invoice data, endpoint secrets, account IDs, and event IDs out of coordination channels.
2. Classify provider delivery failure, unmapped Connect account, signature/mode rejection, claim timeout, or application processing failure.
3. Follow [Billing Boundary](billing-boundary.md). Repair configuration or mapping before a bounded provider-supported replay; do not enable unsupported live billing mutations.
4. Confirm the aggregate failure count returns to the approved baseline. Seven older failed live rows existed at the July 31 inventory and require a private baseline decision before activation.

### Account-deletion worker overdue

1. Privately inspect scheduler/deployment state and the aggregate overdue count without selecting account or requester fields for the alert.
2. Check existing structured worker failures. Do not put request IDs or user IDs in a notification.
3. Run the deletion worker only after cause correction and explicit operator approval; it is destructive and must not be invoked merely to exercise alerting.
4. Confirm both the overdue count and deletion-worker heartbeat recover.

### Support urgent untriaged

1. Use only the sanitized `support_triage_digest` workflow from [Support Triage](support-triage.md) for summaries.
2. Open restricted ticket data only in the approved private operator surface.
3. Triage the ticket transactionally. Never copy requester email, details, page URL/query, browser context, or student content into an alert.
4. Confirm the aggregate count clears.

### Billing reconciliation stale

1. Inspect the retry operation only in the private operator surface.
2. Refresh state before retrying an ambiguous result and follow [Billing Boundary](billing-boundary.md).
3. Do not place invoice, customer, payer, amount, or payment data into an alert.
4. Confirm the operation leaves `reconciliation_required` and the aggregate clears.

## Activation dependencies

The director/client must decide and record all of the following before this can provide operational assurance:

1. The real private primary destination and transport, with a delivery-receipt contract and cost approval.
2. A named backup human, their authority, private backup destination, and cost approval.
3. Acknowledgment, escalation, and resolution semantics and their durable implementation (not present in Phase A).
4. The scheduler cadence and owner, plus a separate external dead-man monitor for evaluator and deletion-worker heartbeats.
5. The privacy retention period for episodes, attempts, outcomes, audit events, heartbeats, and any destination receipts.
6. A private baseline/disposition for the seven existing failed live Stripe events.
7. A staging rehearsal proving primary and backup receipt, acknowledgment, escalation, resolution, dead-man behavior, and owner handoff before production activation.

Do not install a log drain, Speed Insights, or another retained/paid telemetry destination until destination, sampling, retention, privacy, and cost are approved.
