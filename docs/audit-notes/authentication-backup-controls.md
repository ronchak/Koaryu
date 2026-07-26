# Authentication and backup-control verification investigation brief

> Planning-only draft. This note changes no Supabase, authentication, backup, plan, or provider configuration. It narrows the assurance gap tracked by issue #26 using repository evidence from `main` at `0dbf7c0`. Any paid-plan or production-control change remains separately approval-gated.

## Executive summary

Koaryu has strong application-level JWT validation and meaningful encrypted logical-backup work. The remaining assurance question is whether provider-side authentication and backup controls are configured, owned, and periodically verified in a way that matches the application’s security and recovery assumptions.

This is not a claim that authentication is currently insecure or that backups do not exist. The finding is that repository code and local recovery tooling cannot prove settings such as provider backup entitlement, point-in-time recovery, retention, Auth security controls, session revocation behavior, or named operational ownership.

## What the operational bug is

Application code validates Supabase access tokens and fails closed in hosted environments. Recovery documentation notes that the active Supabase plan may not provide native daily backups or PITR. A complete production posture also depends on provider configuration that is not represented by source code alone.

Potentially relevant controls include Auth token lifetimes, password and email policies, MFA availability, leaked-password controls, session revocation behavior, backup schedules, retention, PITR, restore access, and audit visibility. The exact applicable set must be derived from the current provider and plan, not assumed from generic Supabase features.

## Why this matters

Application correctness can be undermined by provider settings. Examples include overly broad Auth policies, inability to revoke compromised sessions, no restorable provider backup, or a recovery feature that exists only on a paid tier that Koaryu has not approved.

The operational value is certainty. A named owner should know which controls exist, which are unavailable, which are compensated by Koaryu’s encrypted logical backups, and how often that evidence is rechecked.

## Current impact

No compromised account or missing backup incident was identified. The current impact is an evidence gap and potentially unproven recovery assumptions. The release ledger already treats some RPO and RTO values as provisional rather than guaranteed.

## Root cause hypothesis

Repository work focused on controls that could be implemented and verified without changing paid plans or provider settings. Provider-side Auth and backup features require authenticated dashboard inspection, plan-aware interpretation, and sometimes explicit cost approval. Those decisions were correctly deferred rather than silently enabled.

## Suggested reproducibility and verification

Perform an authenticated, read-only inventory of current production and staging provider settings. Record aggregate or configuration-level evidence without printing secrets, raw user records, or private backup contents.

Verify token and session behavior with controlled test identities in isolated staging. Confirm what happens after password reset, user disablement, sign-out, key rotation, and any supported revocation mechanism. For backups, verify the exact entitlement, retention, latest successful backup, restore procedure, and whether PITR exists on the current plan.

Compare provider controls with the logical-backup process. Identify which failure modes each covers and where neither provides protection.

## Suggested plan of action

The direction below is guidance, not a fixed control checklist.

Create a concise control inventory with owner, evidence source, verification cadence, current state, and compensating control. Separate controls that can be verified read-only from changes requiring approval. Present paid upgrades as explicit decisions with cost and benefit rather than enabling them automatically.

Where repository automation can safely detect drift without credentials leakage, add a bounded check. Keep provider-dashboard evidence in an approved durable location and link only nonsensitive summaries from the release ledger.

## Scope guard

Do not change production Auth policies, revoke user sessions, upgrade plans, enable PITR, alter backup retention, or expose user-level Auth data without the required approval. Do not claim provider features based on documentation alone.

## Evidence expected before merge

The eventual PR should document the current control state, named owner and cadence, controlled Auth behavior tests, backup entitlement and restore evidence, remaining gaps, cost decisions, and the relationship between provider backups and Koaryu’s encrypted off-site copies.

## Future-work note

This branch contains only the investigation note. No authentication or backup control has changed.