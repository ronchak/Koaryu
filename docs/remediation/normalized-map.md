# Normalized remediation map

Verified against main `66e8240a5d4ed3a21af74e60ee6aa8574cd9c703` after PR162. This replaces the initial placeholder triage. The [ledger](ledger.json) is the per-finding authority; [REMEDIATION.md](../../REMEDIATION.md) records current totals and decisions.

## What changed in the assessment

Every retained observation was assessed individually by a fresh, bounded analyst or the coordinator, then checked by the coordinator against current implementation, callers, replacements and relevant tests. All 278 now have distinct reasons, source evidence, an Astra/Sol track and a bounded next action or completed/deferred explanation. No finding was closed merely because another pending finding shares its cause.

The corrected counts are 31 fixed, 2 resolved indirectly, 232 pending, 11 intentionally deferred, 1 awaiting owner action and 1 rejected. DM2-02 is reopened: V39 fixed ordinary edits, but explicit overall joining-date changes still propagate into program dates. The owner's settled decision now requires a forward correction. BT4-08 is fixed: PR158 consolidated the readiness matrix, and PR162 corrected the current boundary names. CTA1-08 was resolved indirectly by PR163's justified runtime/lint update.

The scope contracted mainly inside recommendations. A stale copy claim does not authorize a timezone editor, guardian-management feature or automation builder. Test observations do not require separate implementation projects. Unused wrappers do not justify a new service architecture. Plausible unresolved defects remain pending rather than being rejected to improve the count.

## Shared responsibilities and dependencies

These groups describe ownership, not a fixed PR quota. The original 16 cluster labels remain in the ledger for audit correspondence. The links below identify findings to resolve together or reassess together; some groups need several safe PRs.

| Responsibility | Findings that travel together | Dependency and bounded correction |
| --- | --- | --- |
| Release attestation authority | PROGRAM-ATTESTATION-01, OS2-01/02, OS3-01, DM4-08; BT4-08 is historical supporting evidence already fixed | Next primary implementation. Generate repeated release bodies/check plumbing from declared state. Preserve historical bytes and distinct canonical/restored evidence. Update active version instructions DOC1-03 afterward. |
| Independent student program dates | DM2-02 | After generator, forward SQL correction plus preview parity. Preserve paused status, rank and explicit program editing. Update tests that deliberately preserved the now-rejected date propagation. |
| External-payment command lifetime | FSH1-05, FT1-04, BB1-05, BT3-02; related FSH1-07/FT1-12 | Keep exact staff/studio-scoped request and note until confirmation. Repair original-actor audit/replay durability. Consolidate only identical storage mechanics; retain workflow-specific key policies. |
| Invoice local completion | BB1-07, BT2-01/03/06/07 | PR162 owns the corrected local closeout and balance calculation. Preserve its proof; reassess remaining invoice claims separately. V41 does not fix the V34 lock inversion DM5-01 or overdue policy BB1-03. |
| Truthful financial facts | BB1-03, BB2-08/09, PROGRAM-CURRENCY-01 | Apply settled overdue, unknown-provider-fact, family attribution and USD-only-new-write rules. Coordinate shared projection/aggregate readers, preserve historical facts/replay, and do not backfill guessed facts. |
| Atomic plan edits and useful billing structure | BB2-02/03, BT3-05; BB1-09/10, BB2-04 | Make local plan/program edits atomic before consolidating orchestration and audit policy. Remove proven unused money writers under Astra review. No dependency-injection or generic audit framework. |
| Rank transitions and eligibility | OPS1-01/14, BT1-06, DM2-01/03 are closed; FSH2-02, OPS1-02, DM2-05 remain | Keep V40's immutable receipt owner. Finish frontend promotion completion ownership separately. Correct unfiltered eligibility context narrowing; measure receipt lookup indexes before adding them. |
| Lead command and row ownership | OPS1-03, BT3-06, FSH2-03/04; lead portion OPS1-05 | One transaction owns truthful stage history; one keyed follow-up command owns contact plus advancement. Track pending state per lead. Keep conversion authorization and atomicity. Remove lossy schema-write retries. |
| Program and schedule write semantics | OPS1-04, OPS2-02/03, BT4-05, OPS1-12, FSH2-07/08 | Paired program/ladder writes need one transaction. Preserve explicit null versus omission. Existing legacy week generation must respect template bounds. Bulk attendance needs a truthful batch outcome. Confirmed class creation must not become retryable because refresh failed. |
| Import eligibility and recovery | OPS2-04/05/06/07/11, BT5-02, FSH3-04, DC2-03 | Align archive/setup eligibility before writes; retain run/row identities across transient failure and lost response. Keep diagnostic source positions separate from identity/hash inputs. Preserve legacy SQL UUID mapping; document it honestly. Dead writers OPS2-10/BT5-03 can be removed independently after caller proof. |
| Workflow state ownership | FSH3-01/02/05, FC3-01/08, FR1-02/03; FSH2-01 and FT2-04 are closed | Each submitted draft, pending operation, persisted result and refresh has an owner. Photo/file completion travels with its profile write. Bulk prop cleanup waits for the bulk owner. Do not replace the store architecture. |
| Cross-path lock order | DM1-02, DM3-02, DM4-01, DM5-01 with DC1-04 | Separate small repairs for series deletion, payer setup, revocation and invoice closeout. Reproduce intended interleavings with observed lock barriers; assert valid serial outcomes. Never retry provider workflows to conceal deadlocks. |
| Due-worker progress and evidence | DM4-02/03/05/07, BB1-11, BT1-02, BT2-02; DM1-04 monitoring | Fix claimable work hidden behind blocked prefixes. Unify only equivalent schedule evidence predicates. Correct fake lease/state behavior with the existing clock. Measure indexes after the final query. Preserve legacy revoke support and privacy-safe diagnostics; do not enable workers or alerts. |
| Consistent dates and metrics | DM1-01, DM3-01, OPS1-07/08/10, BT1-01, FSH2-05, FT2-01, FC2-06/07, FSH1-04 | Use the existing studio business date where applicable and preserve the separately specified UTC financial cohort. Match attendance/capacity populations; exclude known canceled sessions. Derive current age/minor facts without inventing a new age policy. |
| Bounded reads and access recovery | FSH1-03/09, FSH3-03, BB2-01, OPS1-09, FSH2-12, ACS1-04, FR1-07; BB2-06/BT4-04, BB1-06, FSH2-11/FT2-06 | Remove repeated reads and unused dependencies, retain completeness/cursor guards, and use one request deadline. Preserve auth failure categories and exact provider identity. Do not widen the staff directory to fix lead assignment UI. |
| Product truth and low-risk presentation | DOC1-01, CTA1-01, BB2-10, FR1-09, FT1-05; FSH1-10, FC1-08/13, FR1-06, FC2-04 | Correct consumers from actual configuration, workflow, role and studio-grant boundaries. Link the existing catalog, not another matrix. Remove false health/export/feature claims. Sol owns copy, accessibility, genuinely dead interfaces and the associated test reduction. |
| Assurance quality and release evidence | FT1-07/11/12, FT2-02/03/07/08/10, BT1-04/05/08/09, BT2-04/08; OS1-01/02/03/07, OS3-02/03 | Reuse existing test helpers and strong behavioral contracts. Remove copied algorithms and incidental source assertions. Evidence must report observed behavior, reject wrong scope/shape, and distinguish shell readiness from complete data. Preserve immutable-artifact checks. |

The generator comes first because each later schema correction currently requires repeated manual attestation work. It must reduce that work without changing the trust model. Generator acceptance requires actual regeneration and diff proof, not a source-copy template that merely moves the duplication. Current V41 business SQL and historical attested versions remain untouched.

Several findings need assessment after their owner lands rather than standalone work. BT5-02 follows the import corrections; BT3-06 follows lead atomicity; BT4-05 follows its program/template writers; BT4-06 follows upload buffering; BT5-05 follows selected-user Auth hydration; FC3-08 follows bulk workflow ownership. Release documentation follows the generator's final interface. Keep these pending until their conditions are satisfied.

## Recommendations deliberately not implemented

| Finding or recommendation | Decision and reason |
| --- | --- |
| CTA1-04, competing changelogs | Rejected. Root CHANGELOG.md is a symlink to frontend/CHANGELOG.md, so there is one editing source. |
| CTA1-06, icon-tool dependency | Deferred. Checked-in assets serve runtime; the optional generator is not a product path. |
| ACS1-06, rename active identity aliases | Deferred. Current consumers and compatibility agree; no contradictory emitted identities were established. |
| OS1-09, account-wide branding optimization | Deferred. This is a one-off operator mutation with no currently justified run. |
| DOC1-05, support mailbox | Deferred pending owner address. Documentation note only. |
| DOC1-10, unify commercial pilot offers | Deferred. The documents do not establish contradictory approved offers. |
| DOC1-13, historical prototype null dereference | Deferred. The offline artifact has no product runtime caller. |
| FC1-10/FC2-13, broad design/token consolidation | Deferred. Large visual regression radius without an identified functional failure. |
| DM2-04/DM3-03, broad lock/roster-query redesign | Deferred pending contention or workload evidence. Existing cross-table authorization consistency and exact same-snapshot counts provide value. |
| DM3-06, merge repeated authorization predicates | Deferred. No divergent decisions established; bootstrap exceptions and exact financial identity checks matter. |
| DM4-06, change persisted recovery grammar | Deferred. Current writers, readers and SQL agree; migration cost has no demonstrated payoff. |
| Add timezone editing, guardian management, automation builder or billing export history | Not needed to repair the audited promises. Correct copy or remove the unsupported interface. |
| Consolidate all sign-out paths, replace service architecture, add universal fixture/workflow frameworks | No demonstrated benefit proportionate to the ownership and regression cost. Narrow identical helpers and proven dead code remain in scope. |
| Replace historical UUID mapping with standard UUIDv5 | Do not change persisted identities. Add independent vectors and document the legacy mapping accurately. |
| Add indexes because a predicate looks expensive | Measure the actual post-fix query first on disposable synthetic data. No speculative indexes or production benchmark. |

These deferrals do not accept any known unintended mutation, payment, authorization, tenant or destructive-retry defect. Such findings remain pending. No high-consequence integrity finding may silently move into a cosmetic-debt bucket.

## Rigor and limits

The coordinator read the four audit deliverables in full, including the 4,973-line catalogue, repository guidance and relevant operator documentation. Fresh analysts received bounded findings/source packets, without cumulative review memory. The coordinator read their conclusions, checked material cited paths, narrowed unsupported recommendations and retained evidence limits. Pure offline counterexamples confirmed the workflow checker, provider evidence validator and historical readiness-list defects. No hosted data was queried to claim production occurrence during normalization.

The initial claim of normalization by tree correspondence was insufficient. Direct Git-object matching covers 1,128 of 1,129 audited paths. The remaining path, CHANGELOG.md, is a 21-byte symlink to frontend/CHANGELOG.md. Resolving it yields the audited 3,535 bytes / 68 lines and SHA256 `83ad742cde26c593890a49cefc8ddb1fe41c9c4cca1b374a50ec18f6a1dd90bd`, present at both the audit commit and current main. No lost changelog content was found. CTA1-04 therefore has a verified rejection rather than an evidence-missing disposition.

This pass is current-state normalization of all retained findings, not a new claim that every current code line was reread. Original line coverage remains the audit's documented method. Static lock-cycle analysis identifies credible mechanisms, not reproduced incidents or evidence of duplicate charges. Each owning correction must reproduce its relevant interleaving on a disposable database.

The frontend test inventory independently counted tracked Git blobs: 22,911 audit-baseline lines versus 23,979 at current main, an increase of 1,068. The process has not yet met the intended test reduction. Thirty-seven files read source through synchronous or asynchronous helpers; thirty-three contain source assertions. Four are loaders or behavior-only tests. The eighty literal readFileSync call sites are a discovery measure, not the owner's source-assertion count, and are not compared as equivalent metrics. Mixed files retain meaningful behavior and safety assertions. See [cleanup ownership](source-test-cleanup.md).

A fresh reviewer per PR, exact candidate checks and a bounded verification record replace the reused reviewer process. Review comments are evaluated on technical merit. Optional abstractions or more tests are not automatic scope additions.
