# Koaryu remediation program

Owner: the coordinating remediation task. Started September 7, 2026.

The goal is reliable daily operations and clearer ownership while preserving Koaryu's existing architecture, tenant boundaries, financial safeguards and release controls. This is a rolling program of independently reviewed PRs. It is not a commitment to implement every audit recommendation.

The [finding ledger](docs/remediation/ledger.json) accounts for all 278 retained observations. Test gaps and repeated manifestations travel with their production root cause. A finding is closed only with a reason and evidence, or an explicit deliberate deferral. A partially repaired finding remains pending and records what remains.

## Initial normalization

Remote `main`, fetched before planning, is `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`, the audited commit. The worktree was clean. The audit covers 1,128 other paths plus `CHANGELOG.md`, a Git symlink. Its 21-byte blob points to `frontend/CHANGELOG.md`; the target is the audited 3,535 bytes / 68 lines with SHA256 `83ad742cde26c593890a49cefc8ddb1fe41c9c4cca1b374a50ec18f6a1dd90bd`. Both the audit commit and main `9988c62` contain that same link and target. Direct Git object comparison matches 1,128 of 1,129 audited paths, including four binary icons. The remaining path matches only after resolving the symlink; no audited changelog content is missing. This establishes source correspondence only; it did not establish that each finding remains valid. The initial per-finding normalization was incomplete and must be replaced with individual verification and dispositions after PR162.

The coordinator read the executive review, all 4,973 lines of the findings catalogue, the cross-system analysis and coverage report. Current root/package instructions, both README files, services, cutover, verification, billing and operator guidance were read. Three existing reviewer threads rechecked the integrity, billing and release clusters. The environment's total thread limit led to reuse of the audit threads, which limited review independence. Their reports were read and reconciled, but that process did not replace individual normalization. From PR162 onward, each PR uses a fresh reviewer with a bounded diff and plan. Findings require their named verification before closure.

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

[PR #155](https://github.com/ronchak/Koaryu/pull/155) merged as `46131d470592e735641adff19e3aefd217e64e82`, after independent review, a completed automatic review without findings and the full exact-head gate. It preserves payment timestamps and zero fees/received amounts, refuses uncaptured reconciliation, and removes the duplicate fee card. BB1-01/BT3-01, BB1-04/BT2-05, BB2-05 and FC1-05 are fixed within the recorded scope. No historical backfill or production deployment occurred.

Reassessment at `46131d4`: external-payment request identity, audit atomicity and refund refresh still need distinct fixes. The payment-facts change does not resolve them or all projection races. Current totals are 11 fixed, 255 pending and 12 deliberate deferrals.

External-payment browser recovery is designed but held for the owner's data-retention choice about the original free-text note. While that decision is pending, the next independent PR is `codex/remediation-contract-assurance`, from current main. It restricts linked contract SQL to the pinned staging destination, fixes the comp and bulk-archive false-positive assertions, and gives worker contracts their own fixture. This is prerequisite assurance for later SQL changes, with no business migration or readiness relaxation. The baseline local replay passed 133 migrations and 50 contracts but explicitly skipped import-worker behavior; that observed gap must be closed. No high-consequence product-integrity risk is intentionally accepted.

[PR #156](https://github.com/ronchak/Koaryu/pull/156) merged as `f8af4f4a66316e4d254f901cdeaf6571c4b6949c`. Independent and automatic reviews completed without material findings; all exact-head checks passed. OS1-06, DC1-01, DC2-01, DC2-02 and CTA1-02 are fixed. The local suite now executes the import-worker cases. Separate negative controls proved that the old comp/archive tests passed falsely and the repaired tests reject the same mutations. No hosted SQL or production deployment occurred.

Reassessment at `f8af4f4`: remaining nullable SQL assertions, release evidence collectors and attestation tooling still need their own work. Current totals are 16 fixed, 250 pending and 12 deliberate deferrals. The next PR, `codex/remediation-refund-completion`, addresses FSH1-06/FT1-03. Generic Billing refresh both absorbs failures and reloads only the active tab's first page, so it cannot certify an older refunded payment's current balance. The correction will keep payment confirmation, that payment's refreshed state and recovery-key release under explicit ownership. Program/staff read ownership and an ordinary student-membership preservation migration have been independently investigated for subsequent selection. The date-policy and browser-note choices remain pending.

[PR #157](https://github.com/ronchak/Koaryu/pull/157) merged as `50f0f4796f941383d1507b2229ac58e1e3e71427`, after independent review and the final head's complete release gate. FSH1-06 and FT1-03 are fixed. Automated review prompted an explicit no-store response for direct payment reads; its aggregate balance-subtraction suggestion was declined because it would reject valid remounted or concurrent recovery. The explanation is recorded in the resolved review thread and verification document. No production deployment occurred.

Reassessment at `50f0f47`: generic financial commands, external-payment receipts, audit atomicity and other store owners remain open. Current totals are 18 fixed, 248 pending and 12 deliberate deferrals. Next is `codex/remediation-student-memberships`, for ordinary edits that reactivate paused memberships or overwrite per-program dates. One forward database migration will pair the narrow private-writer correction with its affected attestations and old-backend compatibility, plus preview parity and real SQL proof. Existing explicit changed-date behavior remains provisional pending the owner decision. A fresh disposable V38 replay matches the existing manifests. Read-only production health identifies the audited `c5742fe` backend as the current V19 compatibility consumer; the existing V18 rollback path will also remain protected. No production migration or historical membership repair is authorized by this implementation step.


[PR #158](https://github.com/ronchak/Koaryu/pull/158) merged as
`342d545ae4edf0d8b1c27ab31736614f296f7c16`. DM2-02 is fixed. Independent review
and automated review completed on the final commit, all exact-head CI passed, and
the full local suite verified 134 migrations, 50 contracts, restored business-data
continuation and concurrency. The initially failing older version selectors were
corrected without changing historical pins. The guarded merge read production
Render auto-deploy off twice. No production migration, deployment or backfill occurred.

Reassessment at `342d545`: the ledger has 19 fixed, 247 pending and 12 deliberate
deferrals. The explicit date-policy choice, rank replay identity, obsolete student
write paths and other workflow owners remain open. The V39 correction does not
resolve them. Verification is recorded in
[student membership verification](docs/remediation/student-membership-verification.md).

[PR #159](https://github.com/ronchak/Koaryu/pull/159) merged as
`ec48501163a55481e28bd109c3adee06b49bc79f`. Program reads, confirmed writes,
bootstrap, import reconciliation and data replacement now share ownership. Six
mounted groups fail unchanged main and pass the correction; the full frontend
suite passed 928 tests. Independent and automated reviews completed on the exact
head, and every release check passed. One unchanged 150-millisecond billing
runtime test failed the first CI attempt; its 15-test suite passed locally and the
failed job passed one rerun without changing deadlines, assertions or backend code.
The guarded merge again verified production auto-deploy off. No deployment occurred.

Reassessment at `ec48501`: program portions of FSH2-01/02 and FT2-04 are corrected;
the broader findings remain pending for staff and promotion work. Counts remain
19 fixed, 247 pending and 12 deliberate deferrals. See
[program ownership verification](docs/remediation/program-ownership-verification.md).

[PR #160](https://github.com/ronchak/Koaryu/pull/160) merged as
`b5ec8fff6ef3b4a7011212e3b942fdf01f6586d2`. Staff reads, writes and self-profile
acknowledgements share ownership, and Settings has one pending command. FSH2-01,
FT2-04 and FC2-03 are fixed. Seventeen source-text tests were replaced by eleven
mounted groups. Eight groups fail unchanged main at the intended assertions;
three preserve existing safeguards. All eleven pass the correction, and the full
frontend suite passed 922 tests. Independent and automated reviews completed on
the exact head; every release check passed on its first attempt. The guarded
merge verified production auto-deploy off twice. No deployment occurred.
See [staff ownership verification](docs/remediation/staff-ownership-verification.md).

Reassessment at `b5ec8ff`: 22 findings are fixed, 244 pending and 12 deliberately
deferred. FSH2-02 remains pending for promotion/demotion ownership. Rank history
snapshots and effective-command replay remain defective in the unchanged backend
and SQL. OPS1-01, BT1-06 and DM2-03 describe one replay responsibility; DM2-01
shares its immutable history boundary. The next branch is
`codex/remediation-rank-history`. Its plan must establish one transactional
transition owner and a fully attested forward migration before implementation.
It preserves existing permissions, rank rules, old backend interfaces and the
intentional history-deletion lifecycle. No historical identity will be guessed.
The separate frontend command owner and unanswered financial/date choices remain
pending. No unrelated findings were closed by the staff merge.

[PR #161](https://github.com/ronchak/Koaryu/pull/161) implements the rank-history correction.
The [rank-history plan](docs/remediation/rank-history-plan.md) passed independent
review before implementation. Implementation and independent reviews are complete.
The candidate passes 135 migrations and 50 SQL contracts, genuine legacy upgrades,
logical restores, five observed concurrent lock cases, 16 raw metadata negatives,
the full backend/frontend suites and 130 release-workflow tests. Review exposed
unobserved FK drift and a permissive pre-apply fingerprint check; both now reject
their demonstrated counterexamples. Exact-head CI and guarded merge remain required.
See [rank-history verification](docs/remediation/rank-history-verification.md).

Candidate dispositions are 26 fixed, one resolved indirectly, 239 pending and 12
intentional deferrals. OPS1-01, BT1-06, DM2-01 and DM2-03 are fixed; OPS1-14 is
resolved indirectly by removing the duplicated Python transition state machines.
FSH2-02 remains pending for the frontend promotion/demotion owner. These are source
corrections, not a claim that the new backend or database has been deployed.


PR #161 merged as `9988c6265c04ab6621dda4c468de6d21af143bc4` after all exact-head
CI checks passed on `9196e0d`. Independent review verified the final commit.
Automated review completed without findings on the implementation commit; its
final documentation-only rerun reached the bot usage limit. The guarded merge
verified production auto-deploy off twice. No migration or production deployment
occurred. Main's tree equals the reviewed candidate.

Reassessment at `9988c62`: counts remain 26 fixed, one resolved indirectly,
239 pending and 12 deliberately deferred. The ledger now distinguishes partial
release-tool/test improvements from the historical-state, older concurrency and
runbook problems they do not fix. Frontend rank ownership needs its own captured
command, receipt, history and reconciliation boundary; its investigation is ready.

Next is `codex/remediation-invoice-closeout`, for BB1-07/BT2-01. Reproduced create
and payment-retry failures leave an operation completed while a stale payer
balance survives same-key replay. A bounded local closeout correction will finish
audit/balance work before completion and repair historical completed replay,
without another provider mutation or changing delinquency definitions. Review
identified a necessary acquired-lease check for projected retry replays. This
financial integrity correction takes priority over the larger frontend owner.

[PR #162](https://github.com/ronchak/Koaryu/pull/162) has one local-closeout owner
and one database command for current payer-balance recomputation. Material
review comments were reproduced and corrected: concurrent replay can no
longer overwrite a newer balance through the old split read/update, and completed
creation and saved projected closeout remain replayable after later payment or voiding. All 135 historical
migrations remain byte-identical; V41 is additive and preserves the existing formula.

The complete local runner passes 136 migrations, 51 SQL contracts, real restores,
observed concurrency and drift negatives. Full backend, generated-contract and
release-workflow checks pass. One fresh independent reviewer approved the actual
implementation and documentation without prior reviewer history. Final commit
binding, exact-head CI and guarded merge are still required. PR162 remains unmerged.

Candidate counts are 31 fixed, one resolved indirectly, 234 pending and 12
intentional deferrals. BB1-07/BT2-01 share the corrected completion responsibility;
BT2-03/06/07 cover associated test corrections. Two duplicate service tests, two
source-text tests and a broken fake hook were removed; arithmetic assurance moved
to real SQL. Broader test reduction is unfinished. These counts are not the promised
individual re-triage: that pass follows this merge against updated main. See
[invoice-closeout verification](docs/remediation/invoice-closeout-verification.md).

PR162's first complete CI exposed a dependency-audit blocker in unchanged
frontend dependencies. The independent [PR #163](https://github.com/ronchak/Koaryu/pull/163)
merged as `6901f715bd7edd1ea27a8a3d626f66757590f212` after fresh review and all
exact-head checks passed. It updates Next/ESLint to 16.3.3 and Sharp to 0.35.4,
fixes ESM handling in the existing fixture packer, and removes two wording/metadata
tests. Production auto-deploy was verified off; no production deployment occurred.

Reassessment at 6901f71: CTA1-08 is resolved indirectly because the justified update
also aligns runtime and lint versions. FT1-07 remains pending for broader fixture
consolidation. Candidate counts are 31 fixed, two resolved indirectly, 234 pending
and 11 deferred; PROGRAM-SECURITY-01 is separately fixed. PR162 was rebased without
conflict; its invoice/V41 source and tests remain byte-identical to reviewed
0eeed52. It still requires fresh review binding and exact-head CI before merge.
The full individual triage remains the next program step after PR162.

## Deliberate non-goals and deferrals

The ledger records individual reasons for these initial deferrals:

- Broad CSS/control-token unification, FC1-10/FC2-13, would create a visual blast radius without resolving the main integrity risks.
- Changing stored financial recovery grammar, DM4-06, introduces compatibility work without a demonstrated current protocol mismatch.
- Global Connect lock replacement, roster seek redesign and shared authorization-predicate consolidation, DM2-04/DM3-03/DM3-06, require contention, workload or equivalence evidence. Existing safeguards stay in place.
- Download-task infrastructure, FC2-08, is not justified solely by a requested download surviving navigation.
- Icon tooling, the historical pitch and account-wide branding, CTA1-06, DOC1-13 and OS1-09, are deferred until their actual use warrants work.
- Commercial offer wording, DOC1-10, has no proven contradictory offer and does not authorize changes to pricing or pilot terms.

Do not create an automation builder, guardian-management product, mailbox, general workflow framework, universal resource store or new monitoring infrastructure to close a finding. Do not remove immutable migrations, generated contracts, financial receipts, authorization checks or justified compatibility solely because they are repetitive.

## Settled product decisions

The owner settled these requirements on September 9. They are authorized work;
implementation status remains in the ledger.

- DM2-02: overall joining-date edits must never alter any per-program joining date.
- BB1-03: no grace period. Drafts and future-due invoices are never overdue. Overdue starts the day after the due date. No due date means outstanding, not overdue. Uncollectible remains separately identified.
- BB2-09: shared family invoices stay at family level; no first-student selection or invented split.
- BB2-08: derive only confirmed provider facts. Unknown fields remain empty; incomplete facts never default to monthly USD.
- FSH1-05: retain the unresolved external-payment request, including its note, in browser storage scoped to the signed-in staff member and studio until the server confirms.
- DOC1-05: defer pending owner action. Document the future support-address steps only; no mail/DNS changes or mailbox provisioning.

After PR162, individually triage every placeholder finding against updated main
before choosing further implementation. Use balanced calibration: reject clearly
low-value recommendations with evidence and retain plausible issues. Classify all
findings into Astra (money, access, tenant, concurrency, migrations and workflow
ownership) or Sol (bounded low-risk documentation, presentation, dead interfaces,
test consolidation and evidence cleanup). Write standalone Sol batch recipes in
`docs/remediation/delegated/` before dispatch.

The next structural priority is a release-attestation generator from declared
schema state. Repeated handwritten preflight bodies and restore scripts are a
verified program-level gap absent from the original audit. The ledger will track
it separately from the 278 imported observations. Old attested versions must
regenerate byte-identically; replace existing restore scripts only with demonstrated
equivalence. PR162's already-written V41 migration stays outside that restructuring.
There is no arbitrary cap on subsequent schema remediation.

Prospective code corrections do not authorize historical financial backfills. Moved timestamps, missing actor audits and arbitrary attribution may lack sufficient evidence for truthful reconstruction.

## Verification and release discipline

Each PR must explain what behavior changed, why the boundary is safe, and the value of material test additions, deletions or consolidation. Focused checks precede affected-area verification. A test suite should become more meaningful, not necessarily larger. Negative tests at financial, tenant, destructive-write and migration boundaries must reject the intended failure rather than any exception.

The coordinator owns architectural decisions and integration; bounded low-risk legwork is delegated to Sol. Each PR receives one fresh independent reviewer with only its diff and relevant plan, plus source and verification evidence needed to assess them. Prior cumulative reviewer threads are not reused. Material review feedback is resolved; out-of-scope or low-value suggestions may be declined with a concise technical reason. Review acceptance is bound to the actual candidate. Every merge still requires the exact-head `Release candidate gate`, resolved review threads, current base and guarded merge script. No ruleset bypass is part of this program.

Production auto-deploy must remain off and be read back before merging. Merge authorization does not grant live billing activation, historical data repair or production migration execution. Production migrations remain human-only in a real terminal. A future database release needs new state-bound approval and backup/restore evidence; historical V38 tokens, approvals and helper mappings are not reusable authority. Prepared production work must remain reviewable and stop at the human-only gate.

All test data and database execution will use explicitly disposable local targets unless a separately authorized hosted proof is necessary. Credentials, dumps and private operator evidence remain outside the repository.
