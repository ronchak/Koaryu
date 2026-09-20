# Seven queued findings, September 20

All seven requested corrections are merged in code main `7d7308afe8c77578094db8ffb81ee0c9a9e37fe2`. The release candidate is `dce52efff1d28358eca421769d00791b60045c6c`; its tree is identical to that main merge. Production status is recorded separately in the release verification, not inferred from a merge.

| PR | Findings | Reviewed head | Merge | Exact-head release CI |
| --- | --- | --- | --- | --- |
| 222 | FC1-04 | `879d8cf52fb81c95beedb873353ad5197415b3f3` | `8da1980ffe588bd699548b923bf935ec2cc4200a` | 35518177613 |
| 223 | FSH2-02, FC2-02 | `58f8d73911f1603a343d3f14168ce00c133d6c84` | `a68d33bb046314de55d9f1360a409a72aba1ee4c` | 35519176035 |
| 224 | OPS1-02 | `fc68f5a1fcaf7a12efcded06d774b9fb1733171c` | `8a7c582d08945cd5d496c4cc29c9c52c75dd8830` | 35519601271 |
| 225 | OPS2-03 | `0c068c138bda4d1d0948477723357a5eccdffd22` | `cb806f38443253614132ca080b27f99f344f39c8` | 35519980889 |
| 226 | BB1-03 | `f9683f1acbfda3d5dd485c8851032fc6a2c94006` | `f62a45fcf9c85a4b98f29c086620b22277859432` | 35529825571 |
| 227 | DM1-01 | `dce52efff1d28358eca421769d00791b60045c6c` | `7d7308afe8c77578094db8ffb81ee0c9a9e37fe2` | 35531096941 |

All listed candidate runs passed. Every PR received a fresh independent reviewer; same-PR corrections stayed in that review task. Application implementation used fresh Sol tasks per item, with two sequential item owners for the shared save PR. Astra reviewed every result and personally implemented and executed database work. Production auto-deploy was read back off before every guarded merge.

## Changes and verification

- Billing availability now reaches the lower totals and usage cards. Missing facts remain unavailable; confirmed zero stays zero. Real component rendering and the actual currency formatter replace two weak source assertions.
- Confirmed rank commands settle through token renewal for the same staff/studio identity. Operation-owned receipt cleanup and read-only recovery avoid replaying a committed mutation. Program and student forms lock draft-changing controls while saving and retain drafts on rejection.
- Eligibility retains full attendance when any requested program context lacks a promotion boundary. A two-program regression failed on the previous implementation and passed after the fix; canceled, deleted, foreign and credited attendance remain covered.
- Legacy weekly session generation honors inclusive template start/end dates. Seven boundary scenarios extend the existing audit/tenant case, without adding a new named case.
- [Current invoice facts](current-invoice-facts-plan.md) put overdue policy in one read-time SQL calculation. Billing and both Dashboard paths use it, including unassigned invoices. Payer serialization, overflow failure and financial/idempotency safeguards remain. V50 makes no customer-row update; its guarded expectation-checksum update is release metadata only.
- [Current minor status](current-minor-status-plan.md) uses DOB and studio business date in API, cached roster/detail/attendance, preview and student/hygiene exports. Stored columns, guardian policy, null behavior and the eighteen-year boundary remain compatible. New required date reads precede profile/photo side effects. Export reads retain budget accounting.

Coordinator checks included 55 save-workflow tests, 16 eligibility tests, 17 schedule tests with 17 subtests, 1,917 backend tests at the invoice candidate with 5,501 subtests, 33 focused billing frontend checks, 70 rollout cases and eight generator tests. The minor candidate passed 157 targeted backend tests, 41 frontend model checks and five mounted checks. Independent review found the cached attendance projection and missing export-budget accounting; both were fixed and re-reviewed. Coordinator reruns included 79 backend tests/115 subtests and, after those fixes, 26 export tests/111 subtests and 15 schedule checks. Final candidate CI passed all 1,930 backend tests and 904 frontend tests, plus build, lint, security, API and database gates.

## Test cost

Counts below cover touched files, not the entire repository. They are separate scopes and should not be added as a repository-wide total.

| Change | Test lines before → after | Cases before → after |
| --- | --- | --- |
| Billing availability | 918 → 1,114 | 12 → 13 |
| Save ownership, including mounted helper | 2,437 → 2,965 | 41 → 46 named; 50 → 55 executed |
| Eligibility | 312 → 426 | 6 → 6 |
| Legacy week bounds | 700 → 747 | 17 → 17 |
| Invoice application tests | 4,125 → 4,420 | +4 backend, +2 frontend |
| Current minor, excluding JSON fixtures | 3,835 → 4,462 | 87 → 102 named |

This batch grows behavioral coverage; it does not claim a smaller total suite. Pure calendar tests and duplicated rendering loaders introduced during implementation were consolidated before merge. No source-text wiring assertion was added. The database tamper gate still checks every metadata mutation against current full readiness and independent raw facts. Each routine's missing-function case also proves propagation through every immutable compatibility reader. Repeating those same forwarding branches for every other metadata attribute was removed; all historical positive and restore checks remain. The coordinator's focused gate passed all 99 routine mutations. The final complete local replay also passed the four subscription-term mutations, all 145 migrations, 54 contracts, historical restore continuations and concurrency proofs. Its database and verifier source are identical to the release candidate; both owned local clusters were removed.

## Dispositions and limits

Seven original findings moved from pending to fixed, producing 139 fixed and 123 pending out of 278. Program findings did not change. BT4-05 remains pending: the legacy date-boundary portion is now covered, but its paired-write/null contracts are not. FR1-02 and FC1-06 cover other forms and remain pending. No neighboring umbrella was closed merely because a related path improved.

The earlier live-measurement limits and USD-only production query remain as recorded in [the measurement report](live-measurement-20260920.md). This follow-up did not invent missing browser measurements, activate billing, convert currencies, rewrite historical financial records, or change mail/DNS.
