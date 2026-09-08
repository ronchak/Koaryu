# Koaryu remediation program

Owner: the coordinating remediation task. Started September 7, 2026.

The goal is reliable daily operations and clearer ownership while preserving Koaryu's existing architecture, tenant boundaries, financial safeguards and release controls. This is a rolling program of independently reviewed PRs. It is not a commitment to implement every audit recommendation.

The [finding ledger](docs/remediation/ledger.json) accounts for all 278 retained observations. Test gaps and repeated manifestations travel with their production root cause. A finding is closed only with a reason and evidence, or an explicit deliberate deferral. A partially repaired finding remains pending and records what remains.

## Initial normalization

Remote `main`, fetched before planning, is `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, the audited commit. The worktree was clean. All 1,129 audited file hashes match, including four binary icons. There are no intervening implementation changes that make an audit finding obsolete. That does not turn a recommendation into a defect or remove the audit's exposure caveats.

The coordinator read the executive review, all 4,973 lines of the findings catalogue, the cross-system analysis and coverage report. Current root/package instructions, both README files, services, cutover, verification, billing and operator guidance were read. Three capable reviewers independently rechecked the integrity, billing and release clusters. The environment's total thread limit required reuse of the audit's reviewer threads. Their reports were read and reconciled by the coordinator. Findings remain static until the named behavioral verification is run.

The original audit is retained outside this public repository under the owner's September 7 review directory. The ledger preserves IDs, short descriptions and source paths without copying private operator evidence. Its catalogue digest binds the imported inventory. Source paths are starting points, not permanently valid line references.

## Root-cause map

These 16 working clusters are analysis boundaries, not 16 promised PRs. A cluster may need more than one safe change; related clusters may collapse after a merge.

| Cluster | Shared problem and examples | Dependency and intended boundary |
| --- | --- | --- |
| Belt draft ownership | FSH1-01/02, FC1-01; FT1-01/02 expose weak existing UI proof | First application PR. One ladder owns ranks, term and save lifetime. No SQL change. |
| Student write preservation | OPS2-01/BT5-01 omitted tags; DM2-02 retained membership resets; OPS2-10/BT5-03 old writers | Tags can be fixed independently. Membership semantics need a forward SQL correction and preview parity. Retire old writers only after caller verification. |
| Rank history and replay | OPS1-01/BT1-06, DM2-01/03; repeated transition setup OPS1-14 | Immutable request identity must be independent of nullable history relationships. Requires SQL release preparation. |
| Financial command completion | FSH1-05/FT1-04, BB1-05/BT3-02; FSH1-06/FT1-03; BB1-07/BT2-01 | Preserve unresolved command identity; distinguish saved from refreshed; audit repair must preserve the original actor. Consolidate only after those contracts work. |
| Financial facts and local edits | BB1-01/BT3-01, BB1-04/BT2-05, BB2-05; BB2-02/03/BT3-05 | Stabilize collection timestamps, explicit zero and provider status. Atomic plan edits need SQL. Delinquency and shared-family attribution require product decisions. |
| Read and mutation ownership | FSH2-01/02, FSH3-01/02, FC2-02/03, FR1-02/03, FC3-01 | Reuse validated identity and existing resource revisions. Freeze or retain the submitted draft; old reads cannot replace confirmed writes. Preserve access revocation. |
| Lead and schedule commands | OPS1-03/04/12, FSH2-03/04/07, OPS2-02/03 | Give each command one commit boundary and one refresh owner. Separate lead history atomicity from schedule materialization; do not build a universal workflow engine. |
| Import recovery | OPS2-04/05/06/07, BT5-02, FSH3-04, DC2-02/03 | Keep one run identity through transient row failures and preserve successful row identities. Preview must match supported input facts. Do not replace historic UUID mapping casually. |
| Business dates and metrics | OPS1-07/08/10, BT1-01, FSH2-05/FT2-01, DM3-01, DM1-01 | Align class participation, capacity populations and studio calendar dates. Preserve the separately specified UTC financial cohort. Remove the old dashboard engine only with an independent semantic reference. |
| Database concurrency and workers | DM1-02, DM3-02, DM4-01, DM5-01, DC1-04; DM4-02 | Reproduce actual lock pairs with deterministic sessions. Correct one lock protocol at a time. Never retry an entire provider workflow to hide a database deadlock. |
| Access and recovery | BB2-06/BT4-04, BB1-06, FR1-01/FT2-05, FSH2-11/FT2-06 | Recover complete verified facts and preserve failure categories. Keep current role boundaries and narrow proxy allowlists. |
| Bounded reads and runtime | FSH1-03/09, FSH3-03, BB2-01, OPS1-09, FSH2-12 | Remove unused dependencies, batch known IDs, cancel superseded work and prove completeness. Measure SQL/index changes before accepting added complexity. |
| Release and evidence | OS1-06, DC1-01/02, DC2-01/02, OS1-01/02, OS2-01/02, OS3-01/02 | Repair false-green tests and target checks before relying on them. Preserve exact-head CI, distinct canonical/restored evidence and human production gates. |
| Product truth and documentation | DOC1-01 with CTA1-01/FT1-05/FR1-09; FSH1-10; FC1-08/13 | Distinguish implemented, role-permitted, configured, studio-authorized and commercially offered. Correct unsupported promises without adding features. |
| Presentation and dead interfaces | FC1-07/09, FC2-09/10/11/12, FC3-02/03 and FT1-06 | Repair concrete interaction/accessibility defects and retire proven unused interfaces. Avoid a visual redesign. |
| Test and adapter maintenance | BT1-04/05/08/09, BT2-04/08, FT1-07/11, FT2-07/10 | Reduce wording checks, duplicate fixtures and misleading cases as their subsystem changes. Keep strong behavioral, isolation and contract evidence. |

## First PR

Proposed branch: `codex/remediation-belt-drafts`.

The first change gives the Belt Tracker rank editor one snapshot containing its owning ladder, ranks and sub-rank term. A clean program switch must not carry another program's draft into the first edit. Saving must bind the target to that snapshot and prevent competing edits until the request settles. Add Belt will offer a full belt; the existing Add Tip action owns sub-ranks.

This starts with the strongest destructive frontend path: opening an empty ladder, switching cleanly to a populated ladder, changing only its term, then saving can currently submit an empty rank plan. It requires no new database state and has a clear frontend rollback boundary. The simpler omitted-tags fix is next in priority, but it belongs to a different owner and will not be bundled into this PR merely to increase the finding count.

Acceptance evidence will mount the actual controller and relevant controls with synthetic I/O. It will check both directions of draft contamination, a second save retaining existing rank IDs, and delayed saves with attempted edits. Existing pure rank transformations and durable operation receipt tests remain. Remove incidental source assertions only when equivalent behavior is covered. The old opt-in live belt test is not evidence for this fix until its setup/navigation and persistence assertions are repaired; no live tenant is needed for this initial proof.

The ledger is introduced in this first PR so subsequent merged changes can update it. No product code was changed before this map was written.

## Sequence and replanning

1. Protect ladder drafts and partial student writes. Prepare financial command identity and stable collection facts next.
2. Repair the SQL verification gaps and prepare a coherent forward database release. Do not append unattested migrations or merge an intermediate state that requires a later PR to become healthy.
3. Fix retained memberships, history/replay identity, local atomic writes and demonstrated lock-order faults in bounded releases. Preserve old-backend compatibility across each migration transaction boundary.
4. Consolidate draft/read/refresh ownership and agreed business definitions. Remove obsolete implementations with their implementation-only tests.
5. Reduce verified I/O waste and align current documentation and tooling with the resulting system.

After every merge, fetch `main`, record the merged PR and SHA, inspect the changed contracts, and reassess every affected outstanding finding. Reopen an entry if new evidence invalidates its closure. Choose only the next coherent PR; the original map cannot override current source or test evidence.

Completed: [PR #153](https://github.com/ronchak/Koaryu/pull/153), merged as `c39e50d59a1bac9d7785c925cd4500cfa192852f`. Independent review and the exact-head Release candidate gate passed. Production Render auto-deploy was read back off twice by the guarded merge script. Vercel's tracked `main` deployment rule remains false; the normal PR preview built successfully. No production deployment occurred.

Reassessment at that new `main`: FSH1-01, FSH1-02 and FC1-01 are fixed. FSH2-02 is only partly addressed; staff, program and promotion settlement remain. FT1-01/02 remain pending because their original live test is unchanged. Eligibility loading and duplicate refresh findings still apply. No unrelated cluster was closed by this merge. Current totals are 3 fixed, 263 pending and 12 deliberate deferrals.

[PR #154](https://github.com/ronchak/Koaryu/pull/154) merged as `4af5c13625b1bfc45998e4a3bb8746deba12004e`, after independent review, a completed automatic review without findings and the full exact-head gate. OPS2-01 and BT5-01 are fixed. The local 50,000-row export timing test failed on both the candidate and unchanged base; GitHub's full backend job passed. The timing limit remains unchanged. No production deployment occurred.

Reassessment at `4af5c13`: membership status/date reset, import completion/retry and minor-age staleness still need their own corrections. No other student finding was closed by the tags fix. Current totals are 5 fixed, 261 pending and 12 deliberate deferrals.

Current PR: `codex/remediation-payment-facts`, from that updated main. It preserves established collection timestamps, initializes an unset timestamp without overwriting a concurrent winner, honors explicit zero fees/received amounts, and refuses to project uncaptured authorizations as collected money. The duplicate fee card and its unused value are removed. Existing UTC payment-cohort and refund-adjustment definitions remain. Independent design and implementation reviews are green; 820 billing/webhook/policy tests and 300 subtests, generated contracts, narrow frontend tests/lint and the production build passed. Publication and exact-head CI remain. This correction requires no database migration, new provider operation or historical backfill. Delinquency and family allocation decisions remain separate. No high-consequence product-integrity risk is intentionally accepted.

## Deliberate non-goals and deferrals

The ledger records individual reasons for these initial deferrals:

- Broad CSS/control-token unification, FC1-10/FC2-13, would create a visual blast radius without resolving the main integrity risks.
- Changing stored financial recovery grammar, DM4-06, introduces compatibility work without a demonstrated current protocol mismatch.
- Global Connect lock replacement, roster seek redesign and shared authorization-predicate consolidation, DM2-04/DM3-03/DM3-06, require contention, workload or equivalence evidence. Existing safeguards stay in place.
- Download-task infrastructure, FC2-08, is not justified solely by a requested download surviving navigation.
- Icon tooling, patch-version alignment, the historical pitch and account-wide branding, CTA1-06/08, DOC1-13 and OS1-09, are deferred until their actual use warrants work.
- Commercial offer wording, DOC1-10, has no proven contradictory offer and does not authorize changes to pricing or pilot terms.

Do not create an automation builder, guardian-management product, mailbox, general workflow framework, universal resource store or new monitoring infrastructure to close a finding. Do not remove immutable migrations, generated contracts, financial receipts, authorization checks or justified compatibility solely because they are repetitive.

## Product decisions to settle before dependent changes

These remain pending, not inferred approvals or accepted risks:

- DM2-02: when an administrator explicitly changes the student's overall joining date, should it alter any individual program joining dates? Unrelated edits unequivocally must preserve them.
- BB1-03: define overdue status for open invoices with no due date, due-today invoices and uncollectible balances. Draft and future-due invoices must not be falsely presented as overdue.
- BB2-09: shared family invoices need payer-level attribution or an explicit allocation policy. Selecting the first student is not a policy; equal splitting will not be invented.
- BB2-08: define the supported boundary for reconstructing a provider subscription that has no local group. Coherent provider facts can be derived; incomplete facts must not become monthly USD by default.
- DOC1-05: verify and choose the outage support receiving address before changing mail/DNS policy. No mailbox provisioning is implied.

Prospective code corrections do not authorize historical financial backfills. Moved timestamps, missing actor audits and arbitrary attribution may lack sufficient evidence for truthful reconstruction.

## Verification and release discipline

Each PR must explain what behavior changed, why the boundary is safe, and the value of material test additions, deletions or consolidation. Focused checks precede affected-area verification. A test suite should become more meaningful, not necessarily larger. Negative tests at financial, tenant, destructive-write and migration boundaries must reject the intended failure rather than any exception.

The coordinator owns edits and architectural decisions. Independent subagents inspect actual diffs and evidence. Material review feedback is resolved; out-of-scope or low-value suggestions may be declined with a concise technical reason. Review acceptance is bound to the actual candidate. Every merge still requires the exact-head `Release candidate gate`, resolved review threads, current base and guarded merge script. No ruleset bypass is part of this program.

Production auto-deploy must remain off and be read back before merging. Merge authorization does not grant live billing activation, historical data repair or production migration execution. Production migrations remain human-only in a real terminal. A future database release needs new state-bound approval and backup/restore evidence; historical V38 tokens, approvals and helper mappings are not reusable authority. Prepared production work must remain reviewable and stop at the human-only gate.

All test data and database execution will use explicitly disposable local targets unless a separately authorized hosted proof is necessary. Credentials, dumps and private operator evidence remain outside the repository.
