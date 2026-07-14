# Koaryu Friendly Pilot Handoff

## Purpose

This attachment set transfers the current Koaryu production state, the owner’s locked product decisions, and the operating plan for the next bounded release.

The next session must read every attachment completely before taking action. The files are separated by concern so stable facts, product policy, agent procedure, billing semantics, and release evidence do not compete for attention in one oversized prompt.

## Overarching goal

Ship one reliable single-studio Friendly Pilot Core release suitable for daily use by one friendly pilot studio.

The release should improve:

- staff authorization;
- single-studio enforcement;
- instructor billing-data isolation;
- pilot-critical mobile usability;
- billing truthfulness and design readiness;
- changelog, About/help, pilot, recovery, and operational documentation.

The release must preserve production data and keep live outbound Stripe mutation fail-closed unless it receives a separate explicit approval.

It is not a complete tuition-state-machine release, multi-studio release, enterprise recovery project, monitoring-platform project, or broad production-certification program.

## Attachment map

1. 01_CURRENT_STATE.md
   - Verified repository, GitHub, deployment, staging, Stripe, backup, rollback, and historical-worktree state.
   - Treat recorded remote facts as a baseline that must be reverified.

2. 02_PRODUCT_POLICY.md
   - Canonical product objective, single-studio rule, staff-permission matrix, mobile priorities, documentation priorities, recovery posture, and explicit exclusions.
   - This is the canonical source for what the product should do.

3. 03_AGENT_OPERATING_PROTOCOL.md
   - Manager authority, subagent rules, durable checkpointing, compaction recovery, evidence register, finding classification, reviewer standards, and correction limits.
   - This is the canonical source for how the agent team operates.

4. 04_EXECUTION_PHASES.md
   - Phase ordering from reconciliation through production, lane responsibilities, manager gates, candidate freeze, and approval sequencing.
   - This is the canonical source for the execution loop.

5. 05_BILLING_BOUNDARY.md
   - Long-term billing direction, mandatory scope cut-line, billing inventory requirements, conservative semantic defaults, narrow-slice criteria, and live-activation gate.
   - This is the canonical source for billing scope and safety.

6. 06_VERIFICATION_AND_RELEASE.md
   - Verification commands, candidate identity rules, staging matrix, production gates, rollback evidence, stopping conditions, and final report format.
   - This is the canonical source for release evidence.

7. 07_BRIDGE_NOTES.md
   - Short continuity notes about owner intent, previous reasoning, unresolved human decisions, and the next safe action.
   - Read this last, then begin Phase 0.

## Instruction precedence

Apply instructions in this order:

1. System and developer instructions in the new session.
2. The owner’s direct instructions in the new session.
3. The repository root and nearest package AGENTS.md files.
4. Locked product policy in 02_PRODUCT_POLICY.md.
5. Agent procedure in 03_AGENT_OPERATING_PROTOCOL.md.
6. Execution phases in 04_EXECUTION_PHASES.md.
7. Billing rules in 05_BILLING_BOUNDARY.md.
8. Verification and release rules in 06_VERIFICATION_AND_RELEASE.md.
9. Historical facts and bridge notes.

If two attachments appear to conflict, stop and resolve the conflict using the more specific canonical file. Do not silently choose the broader interpretation.

## Required first response

After reading all attachments and the repository AGENTS.md files, the next manager should:

1. State the overarching goal in one paragraph.
2. List the locked Friendly Pilot Core scope.
3. State that billing has an explicit Phase 0 disposition gate.
4. State which external actions require separate approval.
5. Create a fresh worktree from verified remote main.
6. Initialize the durable checkpoint.
7. Publish the Phase 0 read-only plan.

Do not edit product code before Phase 0 reconciliation and manager scope lock are complete.
