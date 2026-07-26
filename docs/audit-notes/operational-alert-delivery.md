# Operational alert ownership and delivery investigation brief

> Planning-only draft. This note does not configure alerts, purchase monitoring, send test pages, or change production logging. It narrows the operational gap tracked by issue #30. The future agent should verify available provider capabilities, costs, privacy constraints, and actual failure modes before choosing an implementation.

## Executive summary

Koaryu has strong release checks and several health, audit, retry, and status surfaces. The repository does not yet prove that important production failures reach a named human through a reliable alert channel with deduplication, escalation, acknowledgment, and a rehearsed response process.

This is separate from adding logs. Logs are evidence that can be searched. Alerts are an operational decision about which conditions require attention, who owns them, how quickly they should respond, and what happens if the primary owner does not acknowledge them.

## What the operational bug is

Potentially important signals exist across Render, Vercel, Supabase, Stripe webhooks, account-deletion workers, support triage, billing reconciliation, database failures, and application exceptions. The repository contains runbooks and release evidence, but no complete end-to-end proof that selected conditions trigger a notification to a named primary and backup owner.

Without a defined policy, alerts may be absent, excessively noisy, delivered to an unmonitored destination, or contain sensitive tenant and billing data.

## Why this matters

Small production systems often fail quietly. A webhook can remain failed, a scheduled worker can stop, a deployment can be unhealthy, or a database dependency can degrade while users are the first people to notice.

Effective alerting reduces detection time and makes ownership explicit. Poor alerting does the opposite. Noise trains operators to ignore messages, while oversharing can place PII or provider identifiers into broad channels.

## Current impact

No missed incident was verified. The current impact is an unproven operational response path. Koaryu may already benefit from provider emails or dashboard notifications, but the repository does not establish their completeness, recipients, escalation, or rehearsal.

## Root cause hypothesis

Engineering effort prioritized preventing defects, exact release verification, and safe failure behavior before adding operational paging. Selecting alert destinations and paid monitoring can require owner and cost decisions. The product also lacked a centralized safe exception event, making alert design harder without risking sensitive content.

## Suggested reproducibility and verification

Inventory available signals and current destinations without exposing secrets. Identify the small set of conditions that are actionable and time-sensitive. Examples may include sustained backend unavailability, repeated readiness failure, failed Stripe webhook processing beyond a threshold, scheduled deletion-worker failure, unresolved billing reconciliation failures, or a burst of uncaught exceptions.

For each candidate, determine whether the signal already exists, its false-positive rate, the data it contains, and the operator action. Trigger synthetic test conditions in staging and prove delivery to the intended primary and backup owners. Rehearse acknowledge, escalate, resolve, and close behavior with timestamps.

## Suggested plan of action

This is guidance rather than a required monitoring vendor or threshold set.

Define an alert catalog with condition, threshold, evaluation window, deduplication rule, severity, destination, primary owner, backup owner, response runbook, and sensitive-data policy. Start with a very small number of high-signal alerts. Prefer existing provider capabilities where they are sufficient and cost-effective.

Connect the global exception-observability work through a safe aggregate signal rather than paging on every isolated `500`. Record test-delivery evidence and review thresholds after real usage. Document what remains dashboard-only or best-effort.

## Scope guard

Do not send production PII, request bodies, credentials, full URLs with query strings, student details, or raw billing payloads to broad alert channels. Do not purchase or enable paid services without approval. Do not create alerts without a named response action.

## Evidence expected before merge

The eventual PR should include the alert catalog, owners, thresholds, redaction rules, staging delivery proof, acknowledgment and escalation rehearsal, cost, failure behavior, and release-ledger evidence. Issue #30 should link the durable acceptance record.

## Future-work note

This branch contains only the investigation note. No alert or monitoring configuration has changed.