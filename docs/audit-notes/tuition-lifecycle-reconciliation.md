# Tuition lifecycle reconciliation investigation brief

> Planning-only draft. This note does not enable live billing, create or modify Stripe objects, initiate payments, refund money, or change production billing records. It narrows the assurance gap tracked by issue #28. All financial and live-provider boundaries remain closed unless separately approved.

## Executive summary

Koaryu contains substantial billing, webhook, projection, idempotency, and reconciliation logic. The currently supported production surface is intentionally narrow. Before broader tuition billing can be considered production-grade, the complete lifecycle must be proven across local database state, Stripe test-mode objects, webhook ordering, retries, reports, and user-visible status.

The narrow finding is that code-level components exist, but the repository does not yet establish one end-to-end accounting truth for enrollment through invoice, payment, failure, refund-like scenarios, cancellation, and reconciliation. This is an assurance and product-semantics gap rather than evidence that a specific current supported payment is wrong.

## What the suspected bug is

Billing state is distributed across payers, plans, enrollments, subscriptions, invoices, payments, refunds, disputes, webhook events, and reporting projections. Local and provider state are eventually consistent. Different transitions can arrive by direct action, webhook, retry worker, or reconciliation request.

Without a verified lifecycle matrix, plausible edge cases remain difficult to reason about:

- duplicate or reordered events
- lost provider responses followed by retry
- payment success after local timeout
- partial or full refund projection
- invoice and payer balance agreement
- subscription cancellation and enrollment status
- externally recorded payments mixed with provider payments
- historical or malformed records

The repository has many targeted tests, so the implementing agent should identify what remains unproven rather than rebuilding solved behavior.

## Why this matters

Financial correctness is asymmetric. A minor UI defect is annoying. A duplicated charge, missing credit, incorrect balance, or misleading invoice state damages trust and may create legal or accounting consequences.

A complete lifecycle proof also defines product semantics. The system must decide which source is authoritative at each transition, how stale states are presented, and what operators may safely do when local and provider records disagree.

## Current impact

No real-money defect was verified during the review. Live outbound billing remains closed, which substantially limits current exposure. The present impact is that broader tuition billing cannot honestly be called production-ready, and some existing support or reconciliation behavior may depend on assumptions that have not been exercised as one complete flow.

## Root cause hypothesis

Billing was built in layers around specific workflows and incidents. Individual paths received strong idempotency and projection tests, but the overall state machine spans many modules and external events. Product decisions such as adjustment semantics, cancellation timing, and source-of-truth rules were intentionally deferred rather than guessed.

## Suggested reproducibility and verification

Document the existing lifecycle from code, schemas, migrations, UI, and current product policy before changing anything. Build a transition matrix covering database rows, provider objects, expected webhooks, audit records, user-visible state, and report totals.

Exercise the matrix in isolated staging with Stripe test mode only. Include initial enrollment, invoice creation, successful payment, delayed webhook, duplicate delivery, failure, retry, external payment, cancellation, and Stripe-supported refund or dispute test scenarios where appropriate. Reconcile provider and local totals after every phase.

Use synthetic tenants and remove test objects afterward. No live key, real customer, or real payment belongs in this work.

## Suggested plan of action

The following is guidance, not a mandated architecture.

First produce the lifecycle and authority model. Then close only verified gaps with the smallest changes. Prefer named, idempotent transitions and database-side atomicity where multiple local rows must agree. Preserve webhook ordering controls and explicit operator reconciliation.

Separate product decisions from technical corrections. When behavior is ambiguous, present options with accounting implications rather than encoding an assumption. Keep the currently supported Contract Only surface unchanged until the broader lifecycle receives explicit approval.

## Scope guard

Do not enable `LIVE_BILLING_ENABLED`, connect new live studios, perform real charges or refunds, rewrite historical production billing data, or broaden visible controls as part of investigation. Avoid a wholesale billing rewrite unless evidence proves the current model cannot be made coherent.

## Evidence expected before merge

The eventual PR should include the transition matrix, test-mode end-to-end evidence, idempotency and ordering results, reconciled database/provider/report totals, tenant and role checks, cleanup proof, known historical exceptions, and explicit product decisions. Issue #28 and the release ledger should hold durable evidence.

## Future-work note

This branch contains only the investigation note. No billing implementation or provider state has changed.