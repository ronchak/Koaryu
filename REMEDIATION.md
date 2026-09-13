# Koaryu remediation program

Owner: the coordinating remediation task. Started September 7, 2026.
Original normalization base: `66e8240a5d4ed3a21af74e60ee6aa8574cd9c703`, after PR162.

Koaryu's working architecture and safeguards stay. This program corrects verified product defects and removes accidental complexity through bounded, independently reviewed PRs. It does not promise to implement every audit recommendation.

## Current position

Pending integrity risk: [PROGRAM-REFUND-01](docs/remediation/refund-completion-risk.md) records a refund whose own projection can block same-key receipt completion recovery. It was reproduced on unchanged main and confirmed against the SQL source. Its database correction is outside this run; the risk is not accepted or fixed.

All 278 retained audit observations now have an individual disposition, reason, source evidence and execution track in the [ledger](docs/remediation/ledger.json). There are no repeated placeholder reasons. The [normalized map](docs/remediation/normalized-map.md) explains shared causes, dependencies, deliberate exclusions and verification limits. [Sol batches](docs/remediation/delegated/README.md) contain the delegated recipes.

| Disposition | Audit findings |
| --- | ---: |
| Fixed | 103 |
| Resolved indirectly | 2 |
| Pending | 160 |
| Deferred intentionally | 11 |
| Deferred pending owner action | 1 |
| Rejected after verification | 1 |
| Total | 278 |

Pending work is split between 29 Astra and 131 Sol observations. Across all dispositions, 56 are Astra and 222 are Sol. Tracks now describe the owner’s wind-down assignment: Sol owns all application work; Astra personally owns database work. Mixed findings name Astra for the database portion and Sol for application files. Historical normalization tracks remain in the ledger. These are observations, not ticket or PR counts.

The ledger separately records the authorized release-attestation generator, a newly verified mixed-currency reporting defect, and dependency maintenance discovered during this program. [PR166](https://github.com/ronchak/Koaryu/pull/166), merged as `84ac2a8`, patches the dependency advisories with a compatible Python lock compiler; see [verification](docs/remediation/dependency-maintenance-verification.md). Those entries do not inflate the original 278.

[PR165](https://github.com/ronchak/Koaryu/pull/165), merged as `9785f13`, removes the unused parallel model, duplicate cloud generator and ineffective hero props. Five scoped observations are fixed; the four touched test files shrink by 326 lines and seven cases. See [verification](docs/remediation/marketing-scene-verification.md). Broader test cleanup remains pending.

PR162 is merged. Its final head `6ce90feffcf0bfa341ae71a7176bffe7b0c2317d` received fresh independent review and all eleven release checks passed. The full disposable database verification passed 136 migrations and 51 contracts, including payer-balance concurrency and restore continuation. No production migration, deployment or backfill occurred.

[PR169](https://github.com/ronchak/Koaryu/pull/169), merged as `e4ab4fc`, closes six shared UI findings. It combines identical views, removes dead options and fixes Button and System theme behavior. The associated tests shrink by 6 lines and one case; [verification](docs/remediation/shared-ui-verification.md) records scope and limits. [PR168](https://github.com/ronchak/Koaryu/pull/168), merged as `8c96132`, corrected the generator permission flag across supported Node releases.

[PR179](https://github.com/ronchak/Koaryu/pull/179), merged as `7113d13`, enforces USD at new tuition financial writes and retires the unused pricing path. Historical financial attempts, exact replay and provider references remain protected. Empty provider headers do not authorize new non-USD amounts. Mixed-currency reporting, unknown provider facts and family attribution remain pending. See [verification](docs/remediation/tuition-currency-verification.md).

## Current bounded run

[The final enrollment ownership change](docs/remediation/enrollment-ownership-verification.md) removes the private facade and closes BB1-09. Billing components have concrete owners and no dependency cycle back into BillingService. Financial and database findings remain separately tracked.

The owner resumed work on September 12 with a 50-point weekly usage cap and a 45-point stop-new-batches threshold. [The run plan](docs/remediation/budget-refactor-plan.md) records scope, order, ownership and wind-down requirements. Sol implements one batch per fresh thread; the coordinator reviews and integrates; each PR gets a separate fresh reviewer. Database implementation and proofs are excluded from this run.

[PR182](https://github.com/ronchak/Koaryu/pull/182) merged as `d6bab29209d2ee4650b8f01e0ece474ff519f422`. It pins Ruff/Prettier and separates mechanical formatting from future behavior changes. It closes no audit observation. [Formatter verification](docs/remediation/formatter-verification.md) records tests, mechanical equivalence and fifteen explicit source-test exceptions.

[PR180](https://github.com/ronchak/Koaryu/pull/180) was rebased and revalidated for the six-interface closeout; see [verification](docs/remediation/dead-ui-interface-verification.md). The owner redirected this run to billing architecture, adding BB1-09 ahead of the original 55 delegated findings. The prior display worker stopped before implementation. Four blocked prerequisites remain explicitly excluded. The paused [HANDOFF](docs/remediation/HANDOFF.md) is historical context until this run's final refresh. The [production packet](docs/remediation/PRODUCTION-RELEASE.md) remains preparation for a human operator, not execution authority for this run.

PR183 merged as `91184e762f99be7e3ebb26d959701d365797e57b`. Plans now have one concrete owner; the separate sync workflow and three facade aliases are deleted. Production shrinks by 35 lines and ten definitions, and tests by 48 lines with unchanged cases. This began the BB1-09 ownership remediation. See [plan ownership verification](docs/remediation/billing-plan-ownership-verification.md).

PR184 merged as `0559911b4c6fd7c57095ffcfbff73a7c2bbb49ba`, deleting 35 facade methods and four unused enrollment forwarders. All remaining methods and test assertions are unchanged. The facade has 33 methods left; BB1-09 remains pending. Across PR183/184, affected billing test files are 14 lines smaller with unchanged cases.

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

Production auto-deploy must remain off and be verified before merging. No production deployment, production migration, historical financial backfill or live billing activation is authorized. Follow current repository and private operator guidance. Production apply remains human-only in a real interactive terminal. Old approvals, inspection tokens, provider/image mappings and restore evidence are historical, not reusable release authority. Credentials, dumps and private evidence stay outside the repository.
