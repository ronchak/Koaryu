# Koaryu remediation program

Owner: the coordinating remediation task. Started September 7, 2026.
Original normalization base: `66e8240a5d4ed3a21af74e60ee6aa8574cd9c703`, after PR162.

Preserve working behavior and safeguards while removing verified accidental complexity through bounded, independently reviewed changes. This program does not promise to implement every audit recommendation.

## Current position

The production release completed September15. All nine V39–V47 migrations and original-row comparisons passed, backed by a fresh verified backup/restore. Both production applications serve `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`. PR215 enables the owner-authorized production path without per-migration GitHub comments; all other guarded-runner checks remain. See [verification](docs/remediation/production-release-verification.md) and [the handoff](docs/remediation/HANDOFF.md).

V46 and the V47 completion-locking follow-up correct [PROGRAM-REFUND-01](docs/remediation/refund-completion-risk.md) at the database resource-version boundary. Its own verified refund projection no longer prevents receipt completion recovery. The application refund workflow and stored claim fingerprints stay unchanged. The production release completed through the ordered hosted rehearsal, verified backup/restore and owner-authorized execution. The remaining 132 pending audit observations are outside this run.

All 278 retained audit observations now have an individual disposition, reason, source evidence and execution track in the [ledger](docs/remediation/ledger.json). There are no repeated placeholder reasons. The [normalized map](docs/remediation/normalized-map.md) explains shared causes, dependencies, deliberate exclusions and verification limits. [Sol batches](docs/remediation/delegated/README.md) contain the delegated recipes.

| Disposition | Audit findings |
| --- | ---: |
| Fixed | 130 |
| Resolved indirectly | 2 |
| Pending | 132 |
| Deferred intentionally | 11 |
| Deferred pending owner action | 1 |
| Rejected after verification | 1 |
| Obsolete | 1 |
| Total | 278 |

Pending work is split between 28 Astra and 104 Sol observations. Across all dispositions, 56 are Astra and 222 are Sol. Tracks now describe the owner’s wind-down assignment: Sol owns all application work; Astra personally owns database work. Mixed findings name Astra for the database portion and Sol for application files. Historical normalization tracks remain in the ledger. These are observations, not ticket or PR counts.

The ledger separately records the authorized release-attestation generator, a newly verified mixed-currency reporting defect, and dependency maintenance discovered during this program. [PR166](https://github.com/ronchak/Koaryu/pull/166), merged as `84ac2a8`, patches the dependency advisories with a compatible Python lock compiler; see [verification](docs/remediation/dependency-maintenance-verification.md). Those entries do not inflate the original 278.

[PR165](https://github.com/ronchak/Koaryu/pull/165), merged as `9785f13`, removes the unused parallel model, duplicate cloud generator and ineffective hero props. Five scoped observations are fixed; the four touched test files shrink by 326 lines and seven cases. See [verification](docs/remediation/marketing-scene-verification.md). Broader test cleanup remains pending.

PR162 is merged. Its final head `6ce90feffcf0bfa341ae71a7176bffe7b0c2317d` received fresh independent review and all eleven release checks passed. The full disposable database verification passed 136 migrations and 51 contracts, including payer-balance concurrency and restore continuation. No production migration, deployment or backfill occurred.

[PR169](https://github.com/ronchak/Koaryu/pull/169), merged as `e4ab4fc`, closes six shared UI findings. It combines identical views, removes dead options and fixes Button and System theme behavior. The associated tests shrink by 6 lines and one case; [verification](docs/remediation/shared-ui-verification.md) records scope and limits. [PR168](https://github.com/ronchak/Koaryu/pull/168), merged as `8c96132`, corrected the generator permission flag across supported Node releases.

[PR179](https://github.com/ronchak/Koaryu/pull/179), merged as `7113d13`, enforces USD at new tuition financial writes and retires the unused pricing path. Historical financial attempts, exact replay and provider references remain protected. Empty provider headers do not authorize new non-USD amounts. Mixed-currency reporting, unknown provider facts and family attribution remain pending. See [verification](docs/remediation/tuition-currency-verification.md).

## Current release run

The four-phase release completed under the owner's revised instructions. PR207/209 fixed refund recovery with V46/V47; PR208/210 established owner-authorized, one-file execution; PR212/213 corrected hosted test defects; PR215 made production GitHub comments optional under direct owner authorization. All 53 hosted contracts passed. The staging alias was repaired, the fresh production backup restored successfully, all nine production migrations preserved the tracked original rows, and both production applications now serve the reviewed PR215 head.

Authenticated staging write/UI rehearsal was explicitly waived and not claimed. No live billing activation or historical financial backfill occurred. Audit dispositions remain unchanged after PR215 and this closeout. DC1-03 was fixed by PR212; DM3-04 and OPS1-06 remain pending. The final run cap is 45 points from the original 51%-used baseline, with no mid-chain budget stop. See the verification record for exact evidence and the final report for the last meter.

## Previous bounded run, September 13

The September 13 run stopped implementation after PR202–205. Its budget began at 45% weekly usage, with a 10-point hard cap and an 8-point stop-new-work threshold. No further implementation is planned. [HANDOFF](docs/remediation/HANDOFF.md) records the preparation SHA, measured usage, remaining work and release traps; the closing report records the final merge SHA and meter read.

PR202 normalizes billing calendar inputs before UTC formatting. PR203 makes the three reported timing-sensitive tests deterministic without changing production limits. PR204 shares the existing packing/compiler and storage fixtures, replaces preference source checks with real behavior and removes incidental constraints. PR205 limits staff-export Auth reads to selected users and propagates provider failures.

Four original findings are newly fixed: FT1-07, FT1-12, OPS1-09 and BT5-05. FT1-11 and FT2-08 are partially addressed and remain pending because protected workflow/source-shape claims still exist. Of the original 55 selected delegated findings, 49 are fixed, one obsolete and five pending: those two umbrellas plus three excluded prerequisites. [The batch index](docs/remediation/delegated/README.md) records the remainders.

This run reduces test source by 240 lines: frontend/e2e −316, backend +76. Frontend cases fall 902→894; backend remains 1,904. PR204's changed scope has 123 fewer assertion calls. Raw readFileSync occurrences fall 103/33 files→101/32, including retained loaders and policy checks. These are different metrics. [Verification](docs/remediation/bounded-refactor-verification.md) records exact revisions and limits.

The earlier billing ownership collapse remains intact: no opaque service/manager owners, no private forwarding facade, and no reverse import cycle. Billing modules remain 27. Relative to the formatter baseline, non-generated application Python/TypeScript is 1,192 lines smaller and test source/JSON fixtures across the recorded scopes are 87 lines smaller. The earlier run's test growth has been offset; the broader cleanup is still incomplete.

Each item used a fresh Sol implementer, coordinator review and a fresh independent reviewer. Every implementation PR passed exact-head CI and the guarded merge with production auto-deploy read back off. No Supabase source, migration, deployment, live billing, historical financial backfill, mail or DNS was changed. That run left PROGRAM-REFUND-01 as a release gate; PR207 subsequently corrected it.

## Completed changes

| PR | Result | Merge | Evidence |
| --- | --- | --- | --- |
| [153](https://github.com/ronchak/Koaryu/pull/153) | Ladder-owned drafts and save lifetime | `c39e50d` | [Belt drafts](docs/remediation/belt-draft-verification.md) |
| [154](https://github.com/ronchak/Koaryu/pull/154) | Omitted student tags preserve stored values | `4af5c13` | [Student tags](docs/remediation/student-tags-verification.md) |
| [155](https://github.com/ronchak/Koaryu/pull/155) | Stable collection timestamps, explicit zero, uncaptured-payment rejection | `46131d4` | [Payment facts](docs/remediation/payment-facts-verification.md) |
| [156](https://github.com/ronchak/Koaryu/pull/156) | Contract target safety and false-positive test repairs | `f8af4f4` | [Contract assurance](docs/remediation/contract-assurance-verification.md) |
| [157](https://github.com/ronchak/Koaryu/pull/157) | Refund confirmation and refresh recovery ownership | `50f0f47` | [Refund completion](docs/remediation/refund-completion-verification.md) |
| [158](https://github.com/ronchak/Koaryu/pull/158) | V39 preserves program status/dates on ordinary edits; explicit date change remains open | `342d545` | [Memberships](docs/remediation/student-membership-verification.md) |
| [159](https://github.com/ronchak/Koaryu/pull/159) | Program read/write ownership | `ec48501` | [Programs](docs/remediation/program-ownership-verification.md) |
| [160](https://github.com/ronchak/Koaryu/pull/160) | Staff read/write ownership and Settings command lifetime | `b5ec8ff` | [Staff](docs/remediation/staff-ownership-verification.md) |
| [161](https://github.com/ronchak/Koaryu/pull/161) | V40 immutable rank history and effective-command replay | `9988c62` | [Rank history](docs/remediation/rank-history-verification.md) |
| [163](https://github.com/ronchak/Koaryu/pull/163) | Patched release-blocking frontend dependencies and fixture ESM handling | `6901f71` | [Dependency prerequisite](docs/remediation/framework-security.md) |
| [162](https://github.com/ronchak/Koaryu/pull/162) | Invoice local completion and V41 serialized payer balances | `66e8240` | [Invoice closeout](docs/remediation/invoice-closeout-verification.md) |
| [164](https://github.com/ronchak/Koaryu/pull/164) | Individual normalization and Sol recipes | `0f86853` | [Normalized map](docs/remediation/normalized-map.md) |
| [165](https://github.com/ronchak/Koaryu/pull/165) | Removed parallel marketing scene model and duplicate cloud work | `9785f13` | [Marketing scene](docs/remediation/marketing-scene-verification.md) |
| [166](https://github.com/ronchak/Koaryu/pull/166) | Dependency and lock-compiler maintenance | `84ac2a8` | [Dependencies](docs/remediation/dependency-maintenance-verification.md) |
| [167](https://github.com/ronchak/Koaryu/pull/167) | Generated release attestations and restore checks | `5d88823` | [Attestation](docs/remediation/release-attestation-verification.md) |
| [168](https://github.com/ronchak/Koaryu/pull/168) | Supported Node permission flag | `8c96132` | [Attestation](docs/remediation/release-attestation-verification.md) |
| [169](https://github.com/ronchak/Koaryu/pull/169) | Shared UI contracts and stable composed controls | `e4ab4fc` | [Shared UI](docs/remediation/shared-ui-verification.md) |
| [170](https://github.com/ronchak/Koaryu/pull/170) | Independent retained program dates | `d9d2766` | [Program dates](docs/remediation/independent-program-dates-verification.md) |
| [171](https://github.com/ronchak/Koaryu/pull/171) | Removed unused backend code and redundant fixtures | `cb897e2` | [Backend maintenance](docs/remediation/backend-maintenance-verification.md) |
| [172](https://github.com/ronchak/Koaryu/pull/172) | Durable browser payment recovery and atomic payment/audit ownership | `08b1e77` | [External payments](docs/remediation/external-payment-recovery-verification.md) |
| [174](https://github.com/ronchak/Koaryu/pull/174) | Corrected export memory and time measurement | `648e27c` | [Export fixture](docs/remediation/export-test-metrics-verification.md) |
| [173](https://github.com/ronchak/Koaryu/pull/173) | Shared schedule rendering and real component tests | `9b4df61` | [Schedule](docs/remediation/schedule-rendering-verification.md) |
| [175](https://github.com/ronchak/Koaryu/pull/175) | Atomic local plan writes and unchanged-save preservation | `a2f0057` | [Local plans](docs/remediation/local-plan-ownership-verification.md) |
| [176](https://github.com/ronchak/Koaryu/pull/176) | Mobile roster sorting, shared badge contrast and hidden-rail hover suppression | `ddacde1` | [Roster](docs/remediation/roster-presentation-verification.md) |
| [177](https://github.com/ronchak/Koaryu/pull/177) | Removed redundant records UI source tests | `18b64e9` | [Test reduction](docs/remediation/records-test-reduction-plan.md) |
| [179](https://github.com/ronchak/Koaryu/pull/179) | USD for new tuition financial writes and retired legacy pricing | `7113d13` | [Currency](docs/remediation/tuition-currency-verification.md) |
| [178](https://github.com/ronchak/Koaryu/pull/178) | Durable import outcomes, safe retry and removed broad ladder repair | `f942dad` | [Import ownership](docs/remediation/import-retry-ownership-verification.md) |
| [182](https://github.com/ronchak/Koaryu/pull/182) | Pinned formatters and mechanical code baseline | `d6bab29` | [Formatters](docs/remediation/formatter-verification.md) |
| [183](https://github.com/ronchak/Koaryu/pull/183) | Concrete billing plan ownership and deleted facade aliases | `91184e7` | [Plan ownership](docs/remediation/billing-plan-ownership-verification.md) |
| [184](https://github.com/ronchak/Koaryu/pull/184) | Deleted 39 dead billing forwarding/helper definitions | `0559911` | [Facade pruning](docs/remediation/billing-facade-pruning-verification.md) |
| [185](https://github.com/ronchak/Koaryu/pull/185) | Concrete payer ownership and removed reverse service import | `b219fd0` | [Payer ownership](docs/remediation/payer-ownership-verification.md) |
| [186](https://github.com/ronchak/Koaryu/pull/186) | Concrete provider projection ownership and deleted forwarding routes | `27eddf0` | [Projection ownership](docs/remediation/projection-ownership-verification.md) |
| [187](https://github.com/ronchak/Koaryu/pull/187) | Concrete Connect/autopay ownership and shared ordinary audit/redirect rules | `32b1ff3` | [Connect/autopay ownership](docs/remediation/connect-autopay-ownership-verification.md) |
| [188](https://github.com/ronchak/Koaryu/pull/188) | One concrete invoice owner and real projection/consent fixtures | `9d99ad5` | [Invoice ownership](docs/remediation/invoice-ownership-verification.md) |
| [189](https://github.com/ronchak/Koaryu/pull/189) | Concrete payment/reconciliation ownership and real refund/RPC fixtures | `df2cced` | [Payment/reconciliation ownership](docs/remediation/payment-reconciliation-ownership-verification.md) |
| [190](https://github.com/ronchak/Koaryu/pull/190) | Concrete enrollment records/workflows; private billing facade removed | `c13b8bf` | [Enrollment ownership](docs/remediation/enrollment-ownership-verification.md) |
| [191](https://github.com/ronchak/Koaryu/pull/191) | Calendar age, truthful student read states and unique CSV controls | `d14a1ba` | [Student display](docs/remediation/student-display-truth-verification.md) |
| [192](https://github.com/ronchak/Koaryu/pull/192) | UTC-stable billing calendar dates with local timestamp display preserved | `76ea418` | [Billing dates](docs/remediation/billing-calendar-display-verification.md) |
| [193](https://github.com/ronchak/Koaryu/pull/193) | Usable signed-out password recovery guidance | `c40215d` | [Recovery guidance](docs/remediation/password-recovery-guidance-verification.md) |
| [194](https://github.com/ronchak/Koaryu/pull/194) | One guarded backup owner and corrected release guidance | `04d7efe` | [Operator documentation](docs/remediation/operator-docs-verification.md) |
| [195](https://github.com/ronchak/Koaryu/pull/195) | One billing product authority and reduced stale copy tests | `bb7a0ae` | [Billing product truth](docs/remediation/billing-product-truth-verification.md) |
| [180](https://github.com/ronchak/Koaryu/pull/180) | Retired dead UI interfaces and misleading live belt smoke | `5f34e21` | [Dead interfaces](docs/remediation/dead-ui-interface-verification.md) |
| [196](https://github.com/ronchak/Koaryu/pull/196) | Correct API fixtures and remove incidental UI test claims | `234e46b` | [Test truth](docs/remediation/frontend-test-truth-verification.md) |
| [197](https://github.com/ronchak/Koaryu/pull/197) | Removed unused dashboard analytics and lead/belt interfaces | `37e8086` | [Unused state](docs/remediation/unused-state-verification.md) |
| [198](https://github.com/ronchak/Koaryu/pull/198) | Corrected product promises and removed fabricated error diagnostics | `ae96269` | [Customer product truth](docs/remediation/customer-product-truth-verification.md) |
| [199](https://github.com/ronchak/Koaryu/pull/199) | Accurate cursor error contract and export-limit guidance | `6ab6ad3` | [Backend contract truth](docs/remediation/backend-contract-truth-verification.md) |
| [200](https://github.com/ronchak/Koaryu/pull/200) | Accurate request diagnostics and meaningful performance gates | `74cd8f4` | [Performance evidence](docs/remediation/performance-evidence-truth-verification.md) |
| [202](https://github.com/ronchak/Koaryu/pull/202) | Normalize billing calendar inputs | `11367a9` | [Bounded run](docs/remediation/bounded-refactor-verification.md) |
| [203](https://github.com/ronchak/Koaryu/pull/203) | Deterministic export and provider deadline tests | `308c569` | [Bounded run](docs/remediation/bounded-refactor-verification.md) |
| [204](https://github.com/ronchak/Koaryu/pull/204) | Shared fixtures and fewer incidental source checks | `a6cf758` | [Bounded run](docs/remediation/bounded-refactor-verification.md) |
| [205](https://github.com/ronchak/Koaryu/pull/205) | Selected-user staff Auth hydration | `4244384` | [Bounded run](docs/remediation/bounded-refactor-verification.md) |

Earlier PRs reused cumulative review threads. Their recorded checks remain evidence, but the review process was not sufficiently independent. From PR162 onward, each PR has one fresh reviewer with a bounded diff and relevant plan. No earlier reviewer is reused for a subsequent PR.

## Settled product decisions

- Overall student joining-date edits never change existing per-program joining dates. Explicit program dates remain independent.
- An invoice is overdue the day after its due date, without a grace period. Drafts, future-due and undated invoices are not overdue. Undated balances remain outstanding; uncollectible remains separate.
- Shared family invoices remain attributed to the family. No first-student selection or invented split.
- Only confirmed provider facts are projected. Unknown facts remain empty, never invented as monthly USD.
- An unresolved external-payment request, including its free-text note, stays in browser storage scoped to the signed-in staff member and studio until server confirmation.
- New tuition and external-payment writes are USD-only. Preserve confirmed historical non-USD records and prevent misleading mixed-currency totals. Exact historical replay remains protected.
- DOC1-05 waits for an owner-approved support address. The [operations note](docs/koaryu-operations.md) describes the future work. No mail, DNS or mailbox provisioning is authorized.

## Working and release rules

The latest owner instruction supersedes the original risk-based split: Sol owns all frontend/backend implementation, including financial and authorization application logic. Astra personally owns every Supabase change, migration, SQL contract and database concurrency proof. Sol also owns documentation and other maintenance. Safety and independent review requirements are unchanged. The coordinator owns architecture and integration. Parallelize reading; do not let implementations overlap.

Use short-lived `codex/` branches from current main, one coherent rollback boundary per PR. Review every substantive automated comment on its merits. Explain declined material suggestions. Require a fresh independent reviewer, current-head evidence, resolved material feedback, and the exact-head `Release candidate gate`. Merge with `scripts/merge-release-pr.sh` using recorded head and base SHAs. Never merge a broken intermediate state.

When a subsystem changes, remove or consolidate its brittle source assertions, copied algorithms, duplicate fixtures and obsolete tests. Preserve strong financial, destructive-write, authorization, tenant and migration assurance. Report material test additions/deletions and why the resulting coverage is stronger. The [test cleanup inventory](docs/remediation/source-test-cleanup.md) assigns every identified source-assertion file an owner; it is not a demand for one new mounted test per old grep.

Production auto-deploy must remain off and be verified before merging. The owner has explicitly authorized coordinating Astra to execute this release through the [announce-and-pause protocol](docs/cutover-gates.md#owner-authorized-release-execution). All technical gates remain mandatory. Live billing activation and historical financial backfill remain outside scope. Old approvals, inspection tokens, provider/image mappings and restore evidence are historical, not reusable release authority. Credentials, dumps and private evidence stay outside the repository.
