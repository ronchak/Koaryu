# Authenticated tenant-safe restore validation investigation brief

> Planning-only draft. This note does not perform a restore, create a hosted target, handle production credentials, or modify any provider. It narrows the recovery-proof gap tracked by issue #23. The future agent must use the established approval, privacy, and cleanup boundaries.

## Executive summary

Koaryu has completed meaningful database restore work and aggregate verification, but the repository evidence has historically stopped short of proving that a restored environment can serve the real application safely. A complete recovery test must show that controlled users can authenticate through the application, access only the intended tenant and role surfaces, recover storage objects, and leave no temporary environment behind.

The narrow finding is that database restoration and row-count agreement are necessary but not sufficient. The application may still fail because Auth identities, JWT configuration, RLS, migrations, storage metadata, frontend/backend origins, or role policies do not align in the restored target.

## What the operational bug is

Current recovery evidence includes encrypted artifacts, database restoration, schema counts, Auth-table coverage, and storage inventory work. The remaining gap is an end-to-end authenticated application proof against a disposable restored target sourced from the approved off-site copy.

Without that proof, the recovery process can produce a database that looks structurally correct but is not usable or tenant-safe through Koaryu’s real API and browser paths.

## Why this matters

A restore that bypasses the application cannot validate:

- Supabase Auth sign-in and token verification
- frontend and backend environment alignment
- service-role and RLS behavior
- same-tenant allows and cross-tenant denials
- staff-role restrictions
- private Storage bucket recovery and signed URL behavior
- production token and session invalidation assumptions
- safe cleanup of temporary resources

These are exactly the boundaries that would matter during a real incident.

## Current impact

No failed real recovery was identified. The current impact is that Koaryu’s recovery confidence remains incomplete. RPO and RTO targets are planning assumptions rather than proven operational commitments until an application-level restore drill succeeds.

## Root cause hypothesis

Earlier drills correctly prioritized safe artifact capture, encryption, schema replay, and aggregate integrity. Application-level verification was deferred because it requires an isolated frontend, backend, Auth configuration, target-only credentials, controlled test identities, outbound sink controls, and provider cleanup. Those are materially more complex and riskier than a database-only restore.

## Suggested reproducibility and verification

Use an approved encrypted generation retrieved from the approved off-site location. Restore it into a disposable target that is neither production nor ordinary staging. Deploy exact known application SHAs with target-only environment values and blocked outbound production integrations.

Create or use controlled recovery identities without exposing credentials. Verify login, `/auth/me`, representative authorized reads, cross-tenant denial, role-specific denial, and private Storage object comparison. Confirm aggregate counts against the backup manifest. Then prove all temporary frontend, backend, database, Auth, and Storage resources are deleted.

The agent should explicitly verify that production access tokens or sessions cannot be used against the restored target unless the recovery design intentionally requires otherwise.

## Suggested plan of action

This is guidance, not a fixed runbook.

Start by defining the disposable target architecture and outbound-sink policy. Reuse the existing staging-isolation controls where appropriate, but do not point ordinary staging at production-derived data. Add a recovery-specific manifest that identifies exact application SHAs, migration state, artifact hashes, target resources, test identities, checks, and cleanup evidence without recording secrets or raw PII.

Automate only the repeatable safe parts. Keep provider creation, production-derived artifact access, and deletion confirmations explicit until the process is mature.

## Scope guard

Do not restore production data into normal staging, expose raw PII in logs or screenshots, reuse production webhook destinations, permit real email or Stripe side effects, or leave the disposable environment running after verification.

## Evidence expected before merge

The eventual PR should link exact artifact and application identities, show authenticated allow and deny results, prove storage recovery, reconcile aggregates, document elapsed recovery time, and include provider-verified cleanup. Issue #23 and the release ledger should hold the durable evidence.

## Future-work note

This branch contains only this investigation note. No restore or provider mutation has occurred.