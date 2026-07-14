# Locked Product Policy

## Pilot objective

The likely first real customer is one friendly pilot studio.

The release is successful when that studio can use Koaryu for daily operations at a quality level where charging for Koaryu is justifiable.

This requires:

- honest supported behavior;
- reliable core workflows;
- strong authorization boundaries;
- no billing-state shortcuts;
- usable mobile flows;
- accurate product and operational documentation;
- preservation of production data.

Production demo records remain.

## Friendly Pilot Core

The implementation release should deliver:

- corrected staff authorization;
- single-studio enforcement;
- instructor billing-data isolation;
- explicit access-denied behavior;
- reproduced pilot-critical mobile fixes;
- accurate billing-state presentation;
- current role, billing, changelog, About/help, pilot, rollback, and recovery documentation.

The billing design package is required, but broad lifecycle implementation is not automatically part of Friendly Pilot Core.

## Single-studio MVP

For the supported MVP:

- One Koaryu user belongs to exactly one studio at a time.
- Multi-studio product support is deferred.
- Do not expand multi-studio infrastructure.
- Remove or bypass studio-selection UX in the supported flow.
- Reject creation or acceptance of a second active membership.
- Preserve existing production data.
- Preserve latent multi-studio schema or code where harmless.
- Do not destructively rewrite historical data to remove multi-studio capability.
- Unexpected existing multi-membership must fail closed and present a bounded remediation path.

Before proposing a uniqueness migration:

1. Inspect production compatibility read-only.
2. Report aggregate counts and conflict categories only.
3. Do not expose identities or raw membership rows.
4. Cover invitation acceptance and onboarding.
5. Explain why application enforcement alone is insufficient.
6. Prove additive, transaction-safe behavior.
7. Preserve all records.

Application-level enforcement is the default first approach.

One migration maximum.

## Staff roles

The backend is authoritative. UI behavior is secondary.

### Admin

Admin has full access.

Reserve these operations for Admin:

- permanent student deletion;
- dangerous bulk deletion;
- staff invitations and role management;
- studio deletion;
- Stripe Connect connection or disconnection;
- payout, bank, tax, and legal settings;
- refunds, voids, chargebacks, and write-offs;
- exceptional financial overrides;
- immediate destructive cancellation;
- global billing configuration;
- belt-system configuration and deletion;
- other irreversible global settings.

### Front Desk

Front Desk has broad operational access.

Allowed:

- create students;
- view and edit students;
- archive or deactivate students;
- import and manage rosters;
- manage leads;
- convert leads;
- manage schedules and recurring classes;
- take and correct attendance;
- perform routine billing administration;
- create and manage tuition enrollment through supported named transitions;
- schedule ordinary cancellation at period end;
- pause and resume where explicitly supported;
- perform ordinary non-exceptional plan changes;
- view billing and reconciliation status.

Not allowed:

- Admin-only dangerous operations;
- martial-arts promotion or demotion decisions.

### Instructor

Allowed:

- view students;
- edit existing student accounts;
- update ordinary student profile information;
- view schedules;
- take and correct attendance;
- promote students;
- demote students through an explicit auditable action;
- view belt progress and instructional context.

Not allowed:

- create students;
- archive students;
- delete students;
- import rosters;
- perform bulk roster administration;
- convert leads;
- administer schedules beyond attendance-related work;
- view or mutate billing data;
- access billing settings;
- access Stripe state;
- access payment details;
- access financial summaries;
- access tuition amounts;
- configure or delete belt systems;
- manage staff or studio settings.

Instructor billing navigation may remain visible if hiding it creates unnecessary complexity.

Every billing route and nested route must:

1. Deny access server-side.
2. Avoid billing-data prefetch before denial.
3. Display a consistent access-denied state.
4. Expose no billing counts, amounts, customer names, plan names, or metadata.

Data non-disclosure is mandatory. Navigation hiding is optional.

## Permission matrix

| Capability | Admin | Front Desk | Instructor |
| --- | --- | --- | --- |
| View/edit existing students | Yes | Yes | Yes |
| Create students | Yes | Yes | No |
| Archive students | Yes | Yes | No |
| Permanently delete students | Yes | No | No |
| Attendance | Yes | Yes | Yes |
| Promote/demote | Yes | No | Yes |
| Lead conversion | Yes | Yes | No |
| Schedule administration | Yes | Yes | Read/attendance only |
| Routine billing | Yes | Yes | No access |
| Refunds/voids/overrides | Yes | No | No |
| Stripe/payout/tax/legal settings | Yes | No | No |
| Staff/studio administration | Yes | No | No |
| Belt-system configuration/deletion | Yes | No | No |

Do not silently weaken this matrix.

## Mobile priorities

Fix only reproduced pilot-critical usability problems.

Critical routes:

- authentication;
- onboarding;
- dashboard;
- students;
- student detail and edit;
- schedule;
- recurring sessions;
- attendance;
- leads;
- billing overview and details;
- access-denied pages;
- relevant settings;
- help and About.

Verify:

- 360-by-800-class viewport;
- 390-by-844-class viewport;
- desktop reference viewport.

Look for:

- horizontal overflow;
- inoperable tables;
- modal overflow;
- hidden actions;
- small or overlapping touch targets;
- hover-only controls;
- unusable date/time inputs;
- navigation traps;
- ambiguous billing state;
- decorative controls presented as real;
- loading mistaken for empty data;
- access-denied data flashes;
- form-state loss;
- dangerous actions placed beside routine actions.

Do not perform a major redesign or design-system replacement.

## Documentation priorities

Required surfaces:

- changelog;
- README where behavior or setup changed;
- About;
- help and get-started;
- role matrix;
- single-studio limitation;
- billing capabilities and limitations;
- test-mode versus live-mode behavior;
- pilot setup and operating checklist;
- rollback;
- recovery expectations;
- support contact path;
- deferred features.

Documentation must describe what is actually live, not the roadmap.

## Recovery and monitoring posture

The owner wants to minimize downtime and data loss within the realities of a one-person-plus-AI operation.

Provisional planning targets:

- RPO: no more than 24 hours;
- RTO: no more than 4 hours.

These are not verified promises.

Inspect the current Supabase plan and native recovery capabilities read-only. Prefer native backups or PITR over custom recovery systems.

The owner is the current alert recipient. Email is preferred.

Provider-native alerts are primary. A Codex automation may provide a supplemental digest, but it is not a sole real-time monitor.

## Explicit exclusions

Out of scope unless a reproduced blocker makes one necessary:

- active multi-studio product support;
- custom permission builders;
- new third-party integrations;
- major visual redesign;
- self-service parent/customer portals;
- enterprise recovery certification;
- enterprise monitoring architecture;
- provider-adapter frameworks;
- cloud backup abstraction;
- broad data classification;
- new issue hierarchy;
- full accounting;
- unbounded billing state-machine rewrite;
- production demo-data cleanup;
- continuation of the operational-alert branch;
- continuation of the recovery-tooling branch;
- repository-wide authorization rewrite.
