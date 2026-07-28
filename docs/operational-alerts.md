# Operational Alerts

Status: **repository scaffold complete; live application delivery blocked pending
owner and destination approval**

Last read-only inventory: `2026-07-28T02:57Z`

This runbook defines Koaryu's smallest actionable alert set. Provider-native
deployment, health, and webhook notifications remain primary where they already
exist. The application catalog adds four counts-only signals that those providers
cannot express consistently. No application destination, scheduler, paid service,
or production setting was enabled by this work.

## Delivery contract

The named primary owner is **Ronak Chakraborty**. `owner-email-primary` means the
private address already associated with the provider accounts; the address is not
stored in the repository or alert payload. Historical provider messages prove
that Vercel deployment failures, Render deployment failures, Stripe webhook
delivery issues, and Supabase security or pause notices have reached that mailbox.
Mailbox read state is not proof of human acknowledgment.

The backup owner and exact backup destination are not approved. Every application
rule therefore names `approval-required-backup` and remains
`blocked-pending-destination-approval`. The code exposes a destination interface,
but the evaluator refuses non-synthetic execution while a rule is blocked, and
the only concrete adapter records synthetic messages in memory. There is no
email, Slack, SMS, webhook, or paging implementation.

An application alert envelope contains only:

- catalog/schema version, event kind, rule ID, stable fingerprint, and severity;
- environment, full deployment commit when available, and observation time;
- aggregate count, threshold, and window;
- logical destination, owner role, runbook, redaction policy, and synthetic flag.

It cannot carry tenant IDs, ticket IDs, requester addresses, user-entered
details, student data, customer/invoice IDs, request bodies, Stripe payloads,
URLs or query strings, browser context, credentials, or provider secrets.
Audit events record the lifecycle, logical destination, synthetic delivery
receipt, and a non-sensitive acknowledgment actor reference. They do not record
raw source rows.

## Application alert catalog

All rules use a stable fingerprint of catalog version, rule ID, and environment.
While an alert remains open, delivery is suppressed until its dedupe interval.
An unacknowledged alert goes to the backup after the escalation interval.
Acknowledgment suppresses repeats and escalation; resolution is delivered to
every role that previously received the alert.

| Rule | Condition and window | Severity | Dedupe | Acknowledge / escalate | Primary / backup | Runbook |
| --- | --- | --- | --- | --- | --- | --- |
| `stripe-live-webhook-failure` | At least one live failed event, processing claim older than 10 minutes, or processing row without a claim time older than 10 minutes | critical | 60 min | 15 / 15 min | Ronak via `owner-email-primary` / approval required | [Response](#stripe-live-webhook-failure) |
| `account-deletion-worker-overdue` | At least one scheduled deletion remains due for 24 hours | high | 12 hours | 60 / 120 min | Ronak via `owner-email-primary` / approval required | [Response](#account-deletion-worker-overdue) |
| `support-urgent-untriaged` | At least one open urgent ticket remains untriaged for 30 minutes | high | 120 min | 30 / 60 min | Ronak via `owner-email-primary` / approval required | [Response](#support-urgent-untriaged) |
| `billing-reconciliation-stale` | At least one invoice retry operation remains `reconciliation_required` for one hour | high | 240 min | 60 / 120 min | Ronak via `owner-email-primary` / approval required | [Response](#billing-reconciliation-stale) |

Every rule uses `counts-only-v1` redaction. The collector performs header-only
exact-count queries; the database response contains no record rows. It emits
only the server-reported count. This is a read boundary, not a live delivery or
audit-write path.

## Current signal and destination inventory

This evidence is a point-in-time read, not a promise that mutable provider
settings remain unchanged.

| Surface | Read-only evidence | Existing destination evidence | Remaining gap |
| --- | --- | --- | --- |
| Render backend | Public `/health/live` and `/health/ready` both returned `200` from production at commit `6596cc5f…`. Render supports native deploy-failure and unhealthy-service notifications. | Historical failure notifications reached the primary mailbox. | Authenticated alert-setting, recipient, and current health-notification readback was unavailable; no Render credential was present. |
| Vercel frontend | Public `/api/version` returned `200` at the same commit. The latest 20 deployments inspected were `READY`; no grouped runtime errors or Vercel alert groups were found in the inspected seven-day window. | Historical preview and production deployment-failure notifications reached the primary mailbox. | Current rule/recipient readback was not exposed by the connected CLI. |
| Supabase production/staging | Both projects reported healthy. Production aggregate counts showed no pending/stuck webhook claim, overdue deletion, urgent ticket, or stale reconciliation operation. The security advisor still warned that leaked-password protection is disabled. | Historical pause/security notices reached the primary mailbox. | A log drain is a paid add-on and is not approved; security-warning acknowledgment and backup escalation are unproven. |
| Stripe | Production aggregates contained seven older failed live webhook rows, no live failure created in the preceding 24 hours, and no processing claim stuck at inspection time. | Historical endpoint-delivery issue notices reached the primary mailbox. Stripe retries live webhook deliveries and exposes delivery status in Workbench. | Stripe CLI had no authenticated account, so current endpoint and notification configuration could not be read back. The seven existing failures need a private baseline decision before alert activation. |
| Account-deletion worker | No scheduled, overdue, or stuck request existed at inspection time. The daily Vercel cron is configured, and the backlog rule can detect an old due request. | No dedicated destination is configured. | An empty queue cannot prove the cron ran. A durable heartbeat/dead-man signal still needs an approved scheduler and destination. |
| Support triage | No open urgent, high-priority, or untriaged ticket existed at inspection time. | The daily sanitized digest is supplemental, not paging. | Live application delivery is blocked. Raw support data must never enter an alert. |
| Billing reconciliation | No retry operation was processing, stale, or awaiting reconciliation. | No dedicated destination is configured. | Live application delivery is blocked. Provider or billing identifiers must stay in the private investigation surface. |

Provider capability references:
[Render notifications](https://render.com/docs/notifications),
[Render health checks](https://render.com/docs/health-checks),
[Vercel notifications](https://vercel.com/docs/notifications),
[Stripe webhook delivery and retries](https://docs.stripe.com/webhooks),
[Stripe Workbench](https://docs.stripe.com/workbench/overview), and
[Supabase Log Drains](https://supabase.com/docs/guides/telemetry/log-drains).

## Response runbooks

### Stripe live webhook failure

1. Acknowledge within 15 minutes. Use only the counts-only envelope in any shared
   coordination channel.
2. In the private owner/provider surface, inspect Stripe Workbench delivery
   status and Koaryu's durable event state. Do not copy payloads, customer data,
   invoice data, endpoint secrets, or identifiers into the alert.
3. Distinguish provider delivery failure, unmapped Connect account, signature or
   mode rejection, claim timeout, and application processing failure. Follow
   [Billing Boundary](billing-boundary.md); do not enable unsupported live
   mutation paths.
4. Repair mapping/configuration first. Replay only the bounded affected event
   through the provider-supported path, then confirm the aggregate count clears.
5. If unacknowledged after 15 minutes, escalate to the approved backup. Keep the
   incident open until both provider delivery and durable processing are healthy.

### Account-deletion worker overdue

1. Acknowledge within 60 minutes. Confirm the aggregate backlog and hosted cron
   deployment privately without selecting account or requester fields.
2. Check the worker's deployment/configuration and existing structured failure
   logs. Do not paste user IDs or request rows into a notification.
3. After cause correction and explicit operator approval, run the existing
   account-deletion worker using the documented hosted configuration. This is a
   destructive workflow; do not run it merely to test alerting.
4. Confirm the overdue count clears. Escalate after 120 minutes if unacknowledged.

### Support urgent untriaged

1. Acknowledge within 30 minutes.
2. Use only the sanitized `support_triage_digest` workflow in
   [Support Triage](support-triage.md) for summaries. Open the restricted internal
   queue only when an authorized operator needs the ticket.
3. Assign or transition the ticket through the transactional triage action.
   Never post requester email, details, page URL, query, browser context, or
   student content into an alert or broad channel.
4. Confirm the count clears. Escalate after 60 minutes if unacknowledged.

### Billing reconciliation stale

1. Acknowledge within 60 minutes and inspect the retry operation only in the
   private Admin/operator surface.
2. Refresh before retrying an ambiguous result. Follow
   [Billing Boundary](billing-boundary.md); routine recovery is the read-based
   reconciliation of an existing Stripe-linked invoice.
3. Do not paste invoice, payer, customer, amount, or payment data into an alert.
4. Confirm the operation leaves `reconciliation_required`. Escalate after
   120 minutes if unacknowledged.

## Synthetic rehearsal and audit evidence

Run from `backend/`:

```bash
venv/bin/python scripts/operational_alerts.py synthetic
```

The command is deterministic and record-only. It performs no network request,
loads no environment secrets, and sends no message. It exercises all four rules
through trigger, dedupe, backup escalation, acknowledgment suppression, and
resolution. The expected summary reports 16 recorded deliveries, 32 audit
events, and all lifecycle/redaction checks as `true`.

The optional `JsonlAlertAuditTrail` is for local rehearsal evidence only. It is
not a durable production state store. A live adapter must atomically persist
alert state and audit events so restarts do not bypass dedupe or escalation.

## Approval packet for live activation

No live activation should occur until the owner records all of these decisions:

1. **Backup ownership:** name the human backup and their response authority.
2. **Destinations:** approve the exact private primary and backup destinations,
   plus a transport that supports delivery receipts. Do not infer personal
   addresses from provider accounts or configure a broad channel.
3. **Cost:** choose a no-new-cost provider-native path or approve a priced
   service. Supabase Log Drains are paid and therefore out of scope; verify
   current pricing immediately before any purchase.
4. **Durability and scheduling:** approve where open-alert state, acknowledgment,
   escalation, and append-only audit events live, and which existing scheduler
   invokes the collector. In-memory state is synthetic-only.
5. **Baseline:** privately classify or explicitly accept the seven existing
   failed live Stripe rows before enabling `stripe-live-webhook-failure`, so the
   first notification is actionable rather than unexplained backlog.
6. **Dead-man coverage:** decide whether to add a durable worker heartbeat and an
   external liveness monitor. Backlog rules cannot detect an empty-queue cron
   failure or a total outage of the system running the evaluator.
7. **Staging proof:** after configuration approval, send one synthetic staging
   alert to the exact primary and backup, record receipt/acknowledgment/escalation
   timestamps, then resolve it. Do not use production data or production pages.

Until those approvals and a staging delivery proof exist, provider-native alerts
remain the production path and the application catalog remains deliberately
inactive.
