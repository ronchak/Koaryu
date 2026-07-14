# Current Verified State

## Status of this document

This file records the last verified state from the completed MVP release. Remote and provider state can change, so reverify it read-only before relying on it.

Do not repeat completed mutations merely to reconfirm them.

## Repository

Repository:

/Users/ronakchak/Desktop/Koaryu Local Repo

The root checkout is not an implementation base.

Last observed root state:

- branch: codex/production-remediation-wave0
- HEAD: b78cb9863e226d17dc242259cf7099e62c6ccfd5
- unrelated modification: supabase/.temp/cli-latest

Preserve supabase/.temp/cli-latest exactly.

Do not reset, clean, update, or repurpose the root checkout.

Create a fresh worktree from current remote main. Suggested location:

/private/tmp/koaryu-friendly-pilot-readiness

Suggested branch:

codex/friendly-pilot-readiness

Many historical worktrees exist. Do not prune or clean them as part of this release.

## Last verified Git state

Remote main:

7a223623cc0f123cb67aaec885f7e45905c0d06e

PR #56:

- title: Enforce MVP staff permissions and billing transitions
- state: merged
- PR head: 931ed2fb732e51b84a53258d994bc4cc4f6d3231
- merge commit: 7a223623cc0f123cb67aaec885f7e45905c0d06e

The PR head and merge commit had the same tree:

b4cc5d54df0d627ae4ceaf3709311b58e69192af

The deployed application used the exact PR-head candidate, 931ed2f.

## Production frontend

- URL: https://koaryu.app
- Vercel deployment ID: dpl_BFtwtN4oLGtV8Jfxt1DxowNdQTG6
- last verified deployment SHA: 931ed2fb732e51b84a53258d994bc4cc4f6d3231
- last verified state: READY
- target: production

The frontend /api/version route returned a null commit SHA because the deployment was performed through the CLI. Vercel provider metadata correctly identified the exact SHA.

Treat the route behavior as deferred observability hardening unless it blocks exact-candidate verification.

## Production backend

- URL: https://koaryu.onrender.com
- Render service: srv-d7mogk1kh4rs73aq6hqg
- last verified /health/ready state: ready
- last verified environment: production
- last verified SHA: 931ed2fb732e51b84a53258d994bc4cc4f6d3231
- production auto-deploy: disabled

## Stripe production state

Live outbound Stripe mutation remains intentionally fail-closed.

During the previous release:

1. The first Render attempt failed closed because Stripe mode did not agree with the installed credential types.
2. No traffic switched to the failed deployment.
3. No Stripe API mutation occurred.
4. Production was corrected to STRIPE_MODE=live.
5. The optional wrong-mode restricted key was removed.
6. The existing live secret key remained.
7. Live billing authorization remained disabled.
8. The exact candidate was redeployed successfully.
9. Health, logs, and authenticated read-only pages passed.
10. No production Stripe object was changed.

Do not reintroduce test Stripe credentials into production.

Do not enable live mutation as part of an ordinary application deployment.

## Staging

Last known isolated staging resources:

- Supabase project: nxgsektqsgrtyfhawxbc
- Render service: srv-d98g4kutrd3s73ek0elg
- Vercel alias: koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app

Reverify these identities before use.

Previous disposable staging studios and Auth identities were removed. Staff-admin-orphan database guard triggers were restored and verified enabled.

Use Stripe test mode only for staging provider verification.

## Current product surface

Production currently supports:

- authentication and onboarding;
- students and roster;
- leads and named conversion;
- scheduling and recurring sessions;
- attendance;
- billing pages;
- authoritative staff-role checks;
- explicit multi-studio selection for multi-membership behavior;
- named lifecycle-sensitive routes;
- generic billing enrollment PATCH without lifecycle status;
- generic lead updates without direct enrollment;
- live Stripe fail-closed behavior;
- rollback documentation.

The new release intentionally changes the current instructor and tenancy policy.

## Protected resolved regressions

Do not reopen these without reproducing them on current main:

- PR #12: recurring schedule visibility
- PR #39: attendance correctness
- PR #40: dataset and loading readiness

## Backup and recovery

Five encrypted backup artifacts exist locally at:

/Users/ronakchak/Koaryu Backups/production-20260710T070020Z

They were copied to:

/Users/openclaw/Koaryu Backups/production-20260710T070020Z

Completed verification:

- exactly five encrypted artifacts;
- local originals preserved;
- filename equality;
- byte-size equality;
- permission equality;
- SHA-256 equality;
- remote readback into a locked temporary directory;
- readback SHA-256 equality;
- temporary readback directory removed;
- no plaintext copied;
- no recovery key copied;
- no decrypted content inspected.

Remaining human step:

- Copy the recovery key to the intended physical flash drive.

Never copy that key through Codex, Git, logs, email, or provider configuration.

## Rollback

Rollback information is in:

docs/release-ledger.md

Previously recorded production SHA:

692f13a4c7543a937c6fcabd257e05b9ab0b1210

PR #56 contained no database migration.

## GitHub disposition

Completed:

- PR #56 merged
- PR #54 closed without merging
- PR #54 branch codex/recovery-tooling retained
- issue #19 closed
- issue #25 closed
- issue #31 closed
- issue #34 closed

Future work left open without release-candidate:

- #22: off-site encrypted-backup recovery
- #23: authenticated tenant-safe restore validation
- #26: authentication and backup-control verification
- #27: production-data classification and audit trail
- #28: tuition lifecycle reconciliation
- #30: operational alert ownership and delivery

Do not create a replacement release-gate hierarchy.

## Historical worktrees

Treat these as evidence only:

- /private/tmp/koaryu-tenant-permission-matrix
- /private/tmp/koaryu-recovery-tooling
- /private/tmp/koaryu-operational-alert-foundation
- /private/tmp/koaryu-mvp-candidate

Do not continue the over-scoped tenant, recovery, or alerting frameworks wholesale.

The prior candidate worktree is historical reference only and is not the base for the next release.
