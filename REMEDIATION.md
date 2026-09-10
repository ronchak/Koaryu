# Koaryu remediation program

Owner: the coordinating remediation task. Started September 7, 2026.
Original normalization base: `66e8240a5d4ed3a21af74e60ee6aa8574cd9c703`, after PR162.

Koaryu's working architecture and safeguards stay. This program corrects verified product defects and removes accidental complexity through bounded, independently reviewed PRs. It does not promise to implement every audit recommendation.

## Current position

All 278 retained audit observations now have an individual disposition, reason, source evidence and execution track in the [ledger](docs/remediation/ledger.json). There are no repeated placeholder reasons. The [normalized map](docs/remediation/normalized-map.md) explains shared causes, dependencies, deliberate exclusions and verification limits. [Sol batches](docs/remediation/delegated/README.md) contain the delegated recipes.

| Disposition | Audit findings |
| --- | ---: |
| Fixed | 72 |
| Resolved indirectly | 2 |
| Pending | 191 |
| Deferred intentionally | 11 |
| Deferred pending owner action | 1 |
| Rejected after verification | 1 |
| Total | 278 |

Pending work is split between 136 Astra and 55 Sol observations. Across all dispositions, 183 are Astra and 95 Sol. These are observations, not ticket or PR counts. Supporting tests and repeated manifestations travel with their owning correction. Grouping pending work does not resolve it.

The ledger separately records the authorized release-attestation generator, a newly verified mixed-currency reporting defect, and dependency maintenance discovered during this program. [PR166](https://github.com/ronchak/Koaryu/pull/166), merged as `84ac2a8`, patches the dependency advisories with a compatible Python lock compiler; see [verification](docs/remediation/dependency-maintenance-verification.md). Those entries do not inflate the original 278.

[PR165](https://github.com/ronchak/Koaryu/pull/165), merged as `9785f13`, removes the unused parallel model, duplicate cloud generator and ineffective hero props. Five scoped observations are fixed; the four touched test files shrink by 326 lines and seven cases. See [verification](docs/remediation/marketing-scene-verification.md). Broader test cleanup remains pending.

PR162 is merged. Its final head `6ce90feffcf0bfa341ae71a7176bffe7b0c2317d` received fresh independent review and all eleven release checks passed. The full disposable database verification passed 136 migrations and 51 contracts, including payer-balance concurrency and restore continuation. No production migration, deployment or backfill occurred.

[PR169](https://github.com/ronchak/Koaryu/pull/169), merged as `e4ab4fc`, closes six shared UI findings. It combines identical views, removes dead options and fixes Button and System theme behavior. The associated tests shrink by 6 lines and one case; [verification](docs/remediation/shared-ui-verification.md) records scope and limits. [PR168](https://github.com/ronchak/Koaryu/pull/168), merged as `8c96132`, corrected the generator permission flag across supported Node releases.

## Next work

1. New verification raises import retry ownership, OPS2-05, ahead of expanding financial reads. Failed-run recovery can repeat student, membership, guardian and setup writes over later staff edits. There is no per-row completion receipt. The [import plan](docs/remediation/import-retry-ownership-plan.md) now records verified row/setup receipts, lock order and finalization boundaries. Implementation and revised disposable proofs are in progress; the finding stays pending until the completed change merges. Avoid rewriting a growing 10,000-row JSON document on every row. This needs a forward database correction, not an existence check.
2. Billing and dashboard still disagree about overdue status, and stored event-driven status cannot handle midnight rollover. A subsequent shared read correction should apply the settled day-after-due rule and explicit unavailable amounts where currencies cannot be combined. Preserve the UTC payment cohort, tenant access, current concurrency guards and historical records. Check reporting/export consumers before closing BB1-03 or PROGRAM-CURRENCY-01.
3. Provider unknown-fact recovery, shared-family invoice attribution and prospective provider currency guards have separate ownership boundaries. Keep them separate from read aggregation and retain historical replay. Due-worker and other lock-order findings also remain pending. Local plan listing round trips and unused legacy provider synchronization were not part of PR175.
4. Continue bounded Sol batches from the current ledger. [PR177](https://github.com/ronchak/Koaryu/pull/177) removes 178 lines and seven cases from the records UI source-test file, retaining five narrow policies. Together with PR176, those test/helper changes net 63 fewer lines. This is partial FT1-11 progress; the broader source-test inventory remains open. See the [accounting and limits](docs/remediation/records-test-reduction-plan.md).

This is a rolling next-step plan. Each merge changes the evidence for subsequent work. Recheck affected pending findings, close only what is actually resolved, and discard future work made unnecessary by the new implementation.

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

Astra owns money, authorization, tenant boundaries, concurrency, migrations and workflow ownership. Sol owns bounded documentation, presentation, proven dead interfaces and test/evidence legwork. The coordinator owns architecture and integration. Parallelize reading; do not let implementations overlap.

Use short-lived `codex/` branches from current main, one coherent rollback boundary per PR. Review every substantive automated comment on its merits. Explain declined material suggestions. Require a fresh independent reviewer, current-head evidence, resolved material feedback, and the exact-head `Release candidate gate`. Merge with `scripts/merge-release-pr.sh` using recorded head and base SHAs. Never merge a broken intermediate state.

When a subsystem changes, remove or consolidate its brittle source assertions, copied algorithms, duplicate fixtures and obsolete tests. Preserve strong financial, destructive-write, authorization, tenant and migration assurance. Report material test additions/deletions and why the resulting coverage is stronger. The [test cleanup inventory](docs/remediation/source-test-cleanup.md) assigns every identified source-assertion file an owner; it is not a demand for one new mounted test per old grep.

Production auto-deploy must remain off and be verified before merging. No production deployment, production migration, historical financial backfill or live billing activation is authorized. Follow current repository and private operator guidance. Production apply remains human-only in a real interactive terminal. Old approvals, inspection tokens, provider/image mappings and restore evidence are historical, not reusable release authority. Credentials, dumps and private evidence stay outside the repository.
