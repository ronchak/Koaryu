# Operational alert ownership and delivery evidence

Status: **safe repository scope implemented; live activation approval-blocked**

Issue: [#30](https://github.com/ronchak/Koaryu/issues/30)

Evidence timestamp: `2026-07-28T02:57Z`

## Outcome

The branch now contains an executable, privacy-safe alert contract instead of a
planning-only note:

- [Operational Alerts](../operational-alerts.md) is the catalog, provider
  inventory, response runbook, redaction boundary, rehearsal guide, and approval
  packet.
- `backend/app/services/operational_alerts.py` defines four aggregate rules,
  deterministic deduplication, primary/backup escalation, acknowledgment,
  resolution, destination and state interfaces, and structured audit events.
- `backend/scripts/operational_alerts.py synthetic` rehearses the complete
  lifecycle through a record-only destination. `snapshot` is an explicitly
  guarded, read-only aggregate inspection command that sends and persists
  nothing.
- `backend/tests/test_operational_alerts.py` pins catalog completeness,
  counts-only collection, sensitive-field exclusion, dedupe, escalation,
  acknowledgment, resolution, and JSONL rehearsal audit behavior.

No external destination, scheduled invocation, production alert, provider
setting, secret, paid feature, or database row was created or changed.

## Point-in-time findings

- Render production liveness and readiness returned `200`. Vercel production
  version returned `200` at the same application commit. The inspected Vercel
  deployments were ready and the inspected seven-day error/alert aggregates
  were empty.
- Both Supabase projects reported healthy. Production had no pending or stuck
  Stripe claim, overdue account deletion, urgent support ticket, or stale
  invoice retry operation. The Supabase security advisor still reports leaked
  password protection disabled.
- Production contained seven older failed live Stripe event rows, with no newly
  failed live event in the inspected preceding 24 hours. Current Stripe endpoint
  configuration could not be read because no authenticated Stripe CLI session
  was available.
- Historical provider email proves that deployment, webhook-delivery, pause, and
  security notices have reached the primary owner's mailbox. Recipient settings,
  acknowledgment, and backup escalation remain unproven.
- Render alert settings could not be read without an authenticated provider
  session. Vercel's connected CLI exposed deployment/error evidence but not the
  current notification-recipient configuration.

Only aggregate counts, timestamps, health status, project/deployment state, and
sanitized failure classifications were inspected. No support requester data,
tenant/customer record, raw Stripe payload, secret, query string, student
content, or billing amount was copied into this evidence.

## Deliberate activation block

Primary ownership is named as Ronak Chakraborty and the logical primary
destination is the existing private owner mailbox. A backup human, exact backup
destination, cost decision, durable alert-state/audit store, scheduler, and
external dead-man monitor have not been approved. The seven pre-existing failed
live Stripe rows also need a private baseline decision.

Those choices are enumerated as a precise approval packet in
[Operational Alerts](../operational-alerts.md#approval-packet-for-live-activation).
The application rules remain `blocked-pending-destination-approval`; the only
shipped destination is synthetic and cannot perform a network write.
