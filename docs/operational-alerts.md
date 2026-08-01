# Operational Alerts

Status: **operationally activatable but disabled; no operational assurance until the human/provider gates below are complete**

The repository contains durable, counts-only episodes, a receipt-bearing HTTPS primary/backup transport, acknowledgement/escalation/resolution lifecycle, a five-minute evaluator schedule, and exact-allowlisted evaluator/deletion-worker dead-man check-ins. Production remains `OPERATIONAL_ALERTS_ENABLED=false`; no real destination, owner, token, or dead-man value is committed. The schedule returns `204` and performs no backend or provider call while disabled.

## Four-rule catalog

| Rule | Counts-only condition | Severity | Primary / backup | Escalate if unacknowledged |
| --- | --- | --- | --- |
| `stripe-live-webhook-failure` | Live failed events older than 10 minutes, or processing events whose claim is older than 10 minutes | critical | `primary-owner` / `backup-owner` | 15 minutes |
| `account-deletion-worker-overdue` | Scheduled deletion requests overdue by 24 hours | high | `primary-owner` / `backup-owner` | 120 minutes |
| `support-urgent-untriaged` | Open urgent tickets untriaged for 30 minutes | high | `primary-owner` / `backup-owner` | 60 minutes |
| `billing-reconciliation-stale` | Invoice retry operations in `reconciliation_required` for one hour | high | `primary-owner` / `backup-owner` | 120 minutes |

Every rule uses `counts-only-v1`. Source inspection happens inside `operational_alert_metric_counts()` and returns only rule ID, aggregate count, and database observation time. The evaluator does not use PostgREST `HEAD`, range headers, client count metadata, or source-row selects anywhere in the alert path.

The envelope and durable audit may contain only the rule ID, environment, severity, full commit SHA, aggregate count, threshold/window, timestamps, logical destination ID, delivery/episode/attempt IDs, idempotency key, bounded error code, and receipt. They must never contain tenant, ticket, requester, student, customer, invoice, event, account, or user identifiers; Stripe payloads; ticket text; email addresses; URLs/query strings; browser context; credentials; or secrets.

## Durable delivery contract

One unresolved episode is keyed by `(environment, rule_id)`. Opening creates a primary `triggered` outbox item. An overdue unacknowledged episode creates one backup `escalated` item. A clear observation closes the episode, cancels pending trigger/escalation sends, and creates `resolved` items only for roles whose prior delivery has a durable successful receipt. Outbox dedupe is `(episode_id, event_kind, destination_role)`.

Before any adapter invocation, `claim_operational_alert_delivery` leases the outbox row and inserts an immutable attempt with a caller-generated UUID idempotency key. The uniqueness contract is `(environment, rule_id, episode_id, attempt_key)`. A retry of the same claim returns the already persisted attempt. The adapter receives that key and must treat it idempotently.

Only `complete_operational_alert_delivery` may mark an outbox item `sent`. In one database transaction it first inserts an immutable successful outcome containing a nonblank receipt, then marks the outbox sent. A constraint trigger rejects sent state without its matching durable receipt. Failures append a bounded failure outcome/audit event and requeue the item. Attempts, outcomes, and audit events reject updates and deletes.

Enabled internal evaluation constructs only `HttpsAlertDestination`; the recording adapter remains test-only. The synchronous evaluator runs off the ASGI event loop and owns one nonblocking process lock until the worker itself exits. An overlap receives a retryable conflict response; caller disconnect or cancellation never releases the active worker's lock early. The complete batch has one 16-second deadline beginning before thread-pool dispatch, with a reserved durable-cleanup window. Evaluator PostgREST calls run through an isolated cancellable async client under the absolute remaining deadline, so a slow response cannot leave the synchronous worker running past that budget. If the drain cannot explicitly prove empty before that window, the evaluator fails closed and does not record a heartbeat. Newly claimed attempts use a 30-second lease so a terminated worker becomes retryable promptly.

Each role must have an exact public HTTPS URL, a separately configured exact provider-host allowlist entry, its SHA-256 URL fingerprint, and a distinct bearer secret. Before either send attempt, the transport resolves the hostname once, rejects the entire answer set unless every A/AAAA address is public, and connects only to that frozen numeric set while retaining the original hostname for Host, TLS SNI, and certificate validation. It has no proxy, redirect, ordinary-client, or second-resolution fallback. The batch's remaining deadline covers DNS, connect/TLS, send, response headers, and bounded body reads; a watchdog closes a connection at the deadline, and retries never reset it. Transient ambiguity retries reuse the same idempotency key and pinned answers, and only a 2xx `application/json` body containing exactly one bounded `receipt_id` succeeds. URLs, headers, bodies, tokens, and exception strings are not logged or persisted.

Acknowledgement uses `POST /api/v1/internal/operational-alerts/{episode_id}/acknowledge`. Separate primary/backup acknowledgement secrets derive the role and logical actor; callers cannot submit actor identity. For example, an approved primary operator may use a private shell without echoing the secret:

```bash
curl --fail-with-body --request POST \
  --header "X-Internal-Secret: $OPERATIONAL_ALERT_PRIMARY_ACK_SECRET" \
  "https://koaryu.onrender.com/api/v1/internal/operational-alerts/$EPISODE_ID/acknowledge"
```

Evaluator and deletion-worker heartbeats increment a durable sequence. Before either worker call begins, its dead-man URL, exact provider-host allowlist entry, fingerprint, control-free bearer secret, environment, and full deployed SHA are validated. The frontend uses the same resolve-once/public-answer/frozen-lookup rule and a direct Node HTTPS connection with the original Host/SNI identity; it never falls back to `fetch`, a proxy, a redirect, or a second resolver. The evaluator records and forwards a success heartbeat only after the bounded outbox drain proves empty with zero failures and consistent claimed/delivered counts. A successful worker run sends its sequence to the dead-man endpoint; the sequence forms the stable check-in idempotency key. Check-ins require the same bounded strict receipt shape. This becomes dead-man coverage only after an independent provider, grace period, recipients, and billing are configured and rehearsed.

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

1. Name the primary and backup humans, document their authority/coverage windows, and approve the four escalation intervals above.
2. Select and fund a receipt-bearing HTTPS receiver that honors `Idempotency-Key`; privately install two exact URLs, their exact provider-host allowlist values, computed SHA-256 fingerprints, distinct bearer secrets, and distinct acknowledgement secrets on Render.
3. Confirm the Vercel plan supports the committed five-minute cron, install matching worker/cron secrets, and keep the switch false until rehearsal.
4. Select and fund an independent dead-man provider; decide grace periods and primary/backup recipients; privately install the two exact URLs/provider-host allowlist values/fingerprints/bearer secrets on Vercel.
5. Approve retention for episodes, attempts, outcomes, audit events, heartbeats, and destination receipts.
6. Privately disposition the seven existing failed live Stripe events so the production baseline is understood.
7. Deploy one exact SHA to staging and rehearse trigger, retry/idempotency, receipt, primary acknowledgement, backup escalation, both resolution deliveries, missed evaluator/deletion check-ins, and handoff. Reverify the SHA, then obtain explicit production-enable approval.

Do not install a log drain, Speed Insights, or another retained/paid telemetry destination until destination, sampling, retention, privacy, and cost are approved.
