# Agent Operating Protocol

## Manager authority

Only the root manager may:

- communicate with the user;
- use Telegram;
- create or move shared branches;
- integrate commits;
- push;
- open, update, close, or merge PRs;
- change GitHub issues;
- change Render, Vercel, Supabase, Stripe, Gmail, staging, or production;
- apply shared-environment migrations;
- deploy;
- approve phase progression;
- issue the final release decision.

Subagents may inspect external systems read-only only when explicitly assigned.

Subagents may not:

- spawn subagents;
- push;
- open or merge PRs;
- deploy;
- change provider settings;
- apply migrations;
- send messages;
- modify issues;
- mutate staging or production;
- invent a new workstream.

After a subagent completes:

1. Capture its findings.
2. Resolve any needed clarification.
3. Close or terminate it.
4. Do not leave stale agents active across phases.

## Concurrency

Parallelize only independent read-only investigation.

Keep one implementation stream active at a time.

Use no more than four Phase 0 analysis lanes. Fewer is better when a lane has no necessary work.

Do not assign two agents to edit the same file or closely coupled interface concurrently.

## Durable checkpoint

Create a non-secret, non-committed checkpoint outside the repository:

/private/tmp/koaryu-friendly-pilot-checkpoint.md

Update it after every major gate.

Record:

- objective;
- locked and deferred scope;
- worktree and branch;
- HEAD and tree SHA;
- dirty state;
- phase statuses;
- active agents and assignments;
- reviewer identities and verdicts;
- accepted/rejected findings;
- unresolved decisions;
- migration status;
- tests and results;
- frozen candidate identity;
- staging identities and evidence;
- external mutations performed;
- approvals received or required;
- last verified provider state;
- next safe action;
- blockers;
- remaining correction budget.

Never record secrets, tokens, passwords, keys, signed URLs, raw PII, or production record contents.

## Interruption recovery

After compaction, interruption, resumed execution, timeout, or long provider wait:

1. Read the checkpoint.
2. Verify git status.
3. Verify HEAD and tree SHA.
4. Verify active agents.
5. Check whether an intended mutation completed.
6. Reconcile any in-flight provider state read-only.
7. Resume from the recorded next safe action.

Never repeat a mutation because conversational memory is incomplete.

## Evidence register

Maintain evidence entries in the checkpoint with identifiers such as:

- AUTH-01
- TENANCY-01
- BILLING-01
- MOBILE-01
- DOCS-01
- CI-01
- STAGING-01

Each entry contains:

- reproduced fact;
- acceptance criterion;
- classification;
- evidence source;
- smallest correction;
- status;
- candidate SHA to which it applies.

Prefer compact evidence references over pasting complete logs repeatedly.

## Finding classification

Every finding is exactly one of:

- RELEASE BLOCKER
- SELF-CAUSED
- DEFERRED HARDENING
- NOT REPRODUCED

Only RELEASE BLOCKER and SELF-CAUSED findings may produce changes.

A finding is not blocking merely because:

- a general architecture exists;
- an old issue mentions it;
- enterprise software would do more;
- more tests are possible;
- a reviewer prefers another pattern;
- multi-studio infrastructure exists;
- UI suggests a future feature;
- a roadmap billing transition is absent;
- additional observability would help.

## Reviewer blocking standard

A reviewer may block only with:

- exact file and line where possible;
- reproducible failure;
- violated acceptance criterion;
- concrete tenant, user, financial, security, data-loss, or pilot-usability impact;
- smallest acceptable correction.

Non-blocking:

- style preferences;
- alternative architectures;
- speculative edge cases;
- enterprise requirements;
- broad tests without a reproduced gap;
- new integrations;
- future observability;
- multi-studio support;
- billing roadmap outside the locked disposition.

## Reviewer lifecycle

Use one read-only domain reviewer after each implementation domain:

1. authorization and data boundary;
2. billing boundary and contract;
3. pilot UX and documentation.

Use a fresh independent reviewer for final convergence.

Reuse the same domain reviewer for its correction and re-review.

Close each domain reviewer after its explicit GREEN LIGHT.

Treat the gate as closed unless the reviewer explicitly says GREEN LIGHT with no unresolved blockers.

## Correction budget

Per domain:

- one normal correction pass;
- re-review by the same reviewer;
- if still blocked, stop and report or split the release.

Final convergence:

- one final correction pass;
- re-review by the same final reviewer;
- if still blocked, stop and report.

Do not silently begin a third pass.

If reviewer replacement is unavoidable, give the replacement the full critique and correction history.

## Scope control

Before editing, lock:

- Friendly Pilot Core;
- billing disposition;
- file ownership;
- migration need;
- candidate budget;
- decisions requiring the user.

Do not allow a reviewer or agent to add a new workstream.

If the work exceeds the release budget, reduce billing to CONTRACT ONLY or move it to a separate release before implementation.

## External mutation queue

Maintain an explicit queue of proposed external mutations.

For each record:

- target;
- exact action;
- reason;
- reversibility;
- approval required;
- evidence required beforehand;
- status.

No subagent may execute the queue.

Application deployment, production migration, and live Stripe activation are three separate approvals. None implies either of the others.
