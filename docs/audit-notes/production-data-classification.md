# Production data classification and audit-trail investigation brief

> Planning-only draft. This note does not inspect raw production records, classify individual users, delete or anonymize data, or authorize any production mutation. It narrows the evidence gap tracked by issue #27. Unknown records remain preservation targets unless a later, separately approved process establishes otherwise.

## Executive summary

Koaryu’s recovery work has already produced conservative aggregate classification evidence and deliberately preserved unknown production records. The remaining operational gap is a reproducible, reviewable classification process that explains what production records represent, how decisions are made, who approves changes, and how those decisions remain auditable without exposing PII in broad outputs.

The narrow finding is not that production contains bad data. It is that some records remain unknown and the repository does not yet prove a durable decision trail for distinguishing active customers, test artifacts, historical setup records, abandoned accounts, or other categories.

## What the operational bug is

The release ledger records substantial unknown counts across Auth users, studios, subscriptions, payment accounts, and Stripe events. Conservative rules correctly avoided deleting or rewriting those records. However, unknown data affects backup size, privacy posture, operational understanding, and future migration decisions.

Without an approved classification record, future agents may infer intent from names, timestamps, or incomplete metadata and make unsafe cleanup decisions. Conversely, preserving everything forever can create unnecessary privacy and operational burden.

## Why this matters

Production data decisions must be explainable and reversible. Koaryu needs to know:

- which records belong to real current or historical users
- which are controlled synthetic or demo artifacts
- which are technically required system records
- which remain ambiguous
- what evidence supports each classification
- who is authorized to approve any resulting mutation

This is especially important where Auth, tenant, billing, and Stripe projections intersect. A record that looks inactive locally may still correspond to an external identity or financial object.

## Current impact

No improper deletion was identified. The current impact is uncertainty and operational friction. Unknown records remain intentionally preserved, which is the correct safe state, but it limits cleanup, privacy reporting, and confidence in production-data inventories.

## Root cause hypothesis

Koaryu accumulated records during development, testing, demos, onboarding attempts, and production-readiness work before a formal data-governance process existed. Later recovery work correctly refused to guess. The missing piece is a controlled classification workflow that combines application evidence, provider evidence, and human decisions.

## Suggested reproducibility and verification

Start with aggregate, secret-safe inventories. Reproduce the existing classification rules and verify counts against current production and encrypted backup manifests. For ambiguous categories, identify the minimum evidence needed to classify a record without printing its raw contents.

Cross-check relationships among Auth identities, studios, staff roles, subscriptions, payment accounts, and Stripe references. Test the rules on synthetic fixtures first. Confirm that the process is deterministic and that the same snapshot produces the same classifications.

Any proposed mutation should be separated from classification and list exact affected records or rules in an approval package stored outside broad public outputs.

## Suggested plan of action

This is guidance rather than a prescribed data model.

Define a small taxonomy, evidence hierarchy, and default treatment for uncertainty. Build a reproducible report that emits counts, opaque references where necessary, reasons, confidence, and unresolved cases without exposing raw PII. Assign a named owner and approver. Establish retention for the classification evidence itself.

Keep classification read-only. If cleanup or anonymization is later justified, create a separate PR and approval package with user impact, provider implications, backup posture, rollback, and post-action verification.

## Scope guard

Do not delete, merge, anonymize, relink, or contact production users in this PR. Do not classify records solely from names or apparent email patterns. Do not treat absence of recent activity as proof that a record is disposable.

## Evidence expected before merge

The future PR should include reproducible rules, aggregate reconciliation, synthetic test coverage, ownership, audit retention, explicit unknown counts, and a clear separation between classification and mutation authority. The release ledger should record the approved state without raw production data.

## Future-work note

This branch contains only the investigation note. No production record has been read or changed through this PR.