# Execution Phases

## Phase 0 — Read-only reconciliation and scope lock

Do not edit before the Phase 0 manager gate.

Run up to four independent read-only lanes concurrently.

Each lane returns:

- evidence ID;
- reproduced fact;
- acceptance criterion;
- classification;
- evidence source;
- smallest action;
- confidence;
- files or systems implicated;
- estimated diff size.

### Lane 1 — Authorization and single-studio

Inspect:

- authoritative role dependencies;
- student endpoints and services;
- onboarding;
- staff invitations;
- membership creation and acceptance;
- RLS;
- multi-studio selectors;
- instructor billing access;
- Front Desk billing restrictions.

Return:

- current versus required permission matrix;
- instructor create/archive/delete paths;
- instructor billing-data paths;
- Front Desk conflicts;
- multi-studio entry points;
- minimum enforcement surface;
- whether a migration is necessary;
- aggregate-only production membership cardinality;
- estimated files and diff.

Do not edit.

### Lane 2 — Billing inventory

Audit tuition billing only.

Return the control and transition inventory required by 05_BILLING_BOUNDARY.md.

Do not audit unrelated Stripe products.

Do not edit.

### Lane 3 — Mobile and access denial

Audit critical routes at:

- 360-pixel-class width;
- 390-pixel-class width;
- desktop.

Return only reproduced issues with:

- route;
- viewport;
- reproduction;
- impact;
- smallest correction.

Inspect instructor billing access for sensitive prefetch or disclosure.

Do not edit.

### Lane 4 — Documentation, recovery, and operations

Inspect:

- changelog;
- README;
- About/help/get-started;
- permission docs;
- billing docs;
- pilot docs;
- rollback;
- recovery;
- Supabase native backup/PITR;
- existing provider email alerts.

Return:

- accurate existing content;
- required drift corrections;
- achievable recovery evidence;
- bounded operational gaps;
- smallest documentation package.

Do not build monitoring or recovery infrastructure.

Do not edit.

## Phase 0 manager gate

After the lanes report:

1. Capture all findings.
2. Shut down the analysis agents.
3. Publish the classified execution ledger.
4. Lock Friendly Pilot Core.
5. Select the billing disposition:
   - CONTRACT ONLY;
   - NARROW TEST-MODE SLICE;
   - SEPARATE BILLING RELEASE.
6. Resolve any required financial product decision before editing.
7. Decide whether a migration is necessary.
8. Lock file ownership.
9. Record baseline HEAD and tree SHA.
10. Record the release budget.
11. Update the durable checkpoint.
12. State the exact implementation cut-line.

## Phase 1 — Core safety

Implement as one dependency chain:

1. Permission-matrix corrections.
2. Single-studio application enforcement.
3. Invitation and onboarding enforcement.
4. Instructor billing-data isolation.
5. Server and UI access-denied contract.
6. Explicit auditable demotion behavior if missing.
7. Focused tests.

Prefer application-level single-studio enforcement.

Add a migration only if aggregate evidence proves it safe and application enforcement cannot reliably preserve the invariant.

Acceptance criteria:

- Roles come from authoritative staff_roles.
- Instructor can edit existing students.
- Instructor cannot create, archive, or delete students.
- Instructor can take attendance.
- Instructor can promote.
- Instructor can explicitly and auditably demote.
- Instructor receives no billing data.
- Front Desk receives broad routine billing access.
- Admin-only dangerous actions remain Admin-only.
- Denial occurs before service-role-backed mutation.
- Denial creates no business mutation or misleading audit entry.
- Foreign and missing identifiers do not disclose tenant existence.
- Second membership creation and acceptance fail.
- Existing single-studio behavior remains normal.
- Unexpected multi-membership fails closed.
- Production data is preserved.
- No repository-wide authorization rewrite.

Verification:

- focused backend authorization tests;
- focused frontend permission tests;
- route inventory if small;
- focused SQL/RLS checks if needed;
- API type check if contracts changed;
- targeted lint and typecheck.

Review:

- Spawn the authorization/data-boundary reviewer.
- Permit one correction pass.
- Require explicit GREEN LIGHT.
- Close the reviewer.
- Update the checkpoint.

## Phase 2 — Billing boundary and design package

Produce:

- billing control inventory;
- transition contract;
- authorization table;
- idempotency expectations;
- webhook/reconciliation expectations;
- audit expectations;
- readiness classifications.

Then follow the locked billing disposition.

### CONTRACT ONLY

Allowed:

- correct misleading UI;
- correct status labels;
- correct documentation;
- preserve or improve fail-closed behavior;
- fix authorization or state-correctness blockers;
- test existing guarantees.

Not allowed:

- broad lifecycle implementation;
- live mutation activation.

### NARROW TEST-MODE SLICE

Implement only explicitly locked transitions already shown to be substantially complete.

Each included transition requires:

- named route;
- explicit authorization;
- idempotency;
- double-click safety;
- retry safety;
- honest local state;
- webhook reconciliation;
- audit behavior;
- Stripe test-mode proof;
- Instructor denial;
- Front Desk/Admin split;
- live fail-closed behavior.

### SEPARATE BILLING RELEASE

Allowed:

- billing isolation;
- correctness blockers;
- inventory;
- transition contract;
- accurate UI and docs;
- bounded test-harness improvements.

Do not add lifecycle implementation.

Review:

- Spawn the billing reviewer.
- Permit one correction pass.
- Require explicit GREEN LIGHT.
- Close the reviewer.
- Update the checkpoint.

## Phase 3 — Pilot mobile UX and documentation

Fix only reproduced pilot-critical issues and drift produced by Phases 1 and 2.

Mobile acceptance:

- critical routes usable at 360 and 390 pixels;
- desktop remains intact;
- no material horizontal overflow;
- modals operable;
- touch targets usable;
- tables understandable;
- destructive actions distinguishable;
- billing labels honest;
- no access-denied data flash;
- no major redesign.

Documentation acceptance:

- role matrix accurate;
- single-studio limitation documented;
- billing disposition documented;
- test/live distinction accurate;
- live mutation status explicit;
- pilot setup documented;
- changelog updated;
- About/help/get-started updated;
- rollback current;
- recovery target honest;
- provider-native alert ownership documented;
- flash-drive step explicit;
- billing roadmap distinguished from live capability.

Review:

- Spawn the pilot UX/docs reviewer.
- Permit one correction pass.
- Require explicit GREEN LIGHT.
- Close the reviewer.
- Update the checkpoint.

Do not reopen authorization or billing architecture unless this phase reproduces a concrete safety defect.

## Phase 4 — Candidate freeze

Before freeze:

1. Inspect the complete diff.
2. Reject unrelated changes.
3. Confirm the budget.
4. Confirm one branch and one PR.
5. Confirm migration count.
6. Run targeted checks.
7. Require a clean worktree.
8. Commit all candidate content.

Freeze:

- record candidate commit SHA;
- record candidate tree SHA;
- record clean status;
- record diff stat;
- record migration hashes;
- record rollback state;
- record billing disposition.

Any subsequent candidate-file change creates a new candidate.

The change invalidates:

- final-review verdict;
- exact-head CI evidence;
- staging deployment;
- staging smoke evidence.

Rerun affected gates against the new SHA.

## Phase 5 — Final review and exact-head CI

Spawn a fresh independent final reviewer.

Review:

- cross-system authorization;
- single-studio enforcement;
- invitations and onboarding;
- billing isolation;
- compliance with billing disposition;
- idempotency and reconciliation if a slice exists;
- mobile usability;
- documentation accuracy;
- migration compatibility;
- runtime assumptions;
- rollback;
- data preservation;
- live Stripe fail-closed behavior.

Permit one final correction pass.

If corrected:

1. Create a new commit.
2. Record the new SHA and tree.
3. Re-run the same final reviewer.
4. Require GREEN LIGHT.
5. Freeze again.

If still blocked, stop and report.

After GREEN LIGHT:

- run one full exact-head CI cycle;
- targeted checks before freeze do not count against the limit;
- allow one CI rerun only if candidate content changes;
- open or update the single PR without changing content;
- record CI evidence by SHA;
- update the checkpoint.

## Phase 6 — Isolated staging

Deploy the frozen exact SHA to isolated staging.

Verify only:

- Friendly Pilot Core;
- behavior included by the billing disposition;
- protected regressions;
- fail-closed guarantees.

Use disposable staging data only.

After verification:

1. Remove disposable Auth identities.
2. Remove disposable business records.
3. Verify cleanup.
4. Record compact evidence.
5. Update the checkpoint.

Any code correction returns to Phase 4 with a new candidate.

## Phase 7 — Approval package

Present:

- candidate SHA and tree;
- PR and CI;
- reviewer verdict;
- staging evidence;
- migration status and hash;
- schema compatibility;
- application rollback;
- database rollback/recovery;
- live Stripe status;
- billing disposition;
- deferred risks;
- data-preservation statement.

Request approvals independently:

1. APPLICATION DEPLOYMENT APPROVAL
2. PRODUCTION MIGRATION APPROVAL
3. LIVE STRIPE ACTIVATION APPROVAL

None implies either of the others.

## Phase 8 — Production

After explicit application approval:

1. Deploy the exact frozen candidate.
2. Apply an exact migration only if separately approved.
3. Do not enable live Stripe mutation unless separately approved.
4. Verify Render SHA.
5. Verify Vercel provider SHA.
6. Verify schema state.
7. Run read-only and non-financial smoke.
8. Check immediate logs once.
9. Check email alerts once.
10. Preserve demo data, Auth identities, and Stripe objects.
11. Update the checkpoint.
12. Stop.

## Candidate budget

- one root manager;
- up to four read-only Phase 0 lanes;
- one active implementation stream;
- three domain reviewers;
- one fresh final reviewer;
- one implementation branch;
- one implementation PR;
- one migration maximum;
- approximately 3,500 net new lines;
- approximately 45 materially changed files;
- one normal correction pass per domain;
- one final correction pass;
- one full exact-head CI cycle after freeze;
- one CI rerun only after candidate changes;
- one staging evidence pass;
- one production deployment.

If scope cannot fit, reduce billing to CONTRACT ONLY or SEPARATE BILLING RELEASE before implementation.
