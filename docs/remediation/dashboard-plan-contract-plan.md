# Dashboard contract correction

Base: `c98834ee2fefb998950c40d4cf34e5cf7622510d`. The owner authorized correcting or requalifying the failed plan assertion with evidence, without changing fixture rows, forcing planner settings, skipping a contract file or optimizing an already fast query without cause.

## Why the gate was wrong

The hosted V47 rehearsal stopped on `dashboard_summary_facts_contract.sql`. Its small-profile schedule fragment returned the right result but used one studio-scoped Index Only Scan of two attendance rows. The test allowed only one row of scan work. Execution was 0.111 ms. The fixture deliberately contains one selected attendance row and one outside the window. Input rows visited are not the number of output rows.

The problem extends beyond this one threshold. The contract builds three copied SQL fragments and checks their EXPLAIN shapes/work counts. It does not capture plans of the actual RPC. A source-string check connects two join spellings to those copies, but cannot prove that a changed RPC shares their behavior or performance.

A private disposable PostgreSQL 17 probe replayed all 142 unchanged migrations, seeded the contract's exact fixture statements, and compared those exact query fragments before and after ordinary `ANALYZE` on students, sessions and attendance. No planner settings were forced and no fixture rows were changed. The first probe setup missed per-migration transactions and failed on an ON COMMIT temporary table; the corrected setup used the repository's transaction boundary and cleaned up both disposable clusters. No hosted retry was involved.

After ordinary statistics collection:

| Profile | Fragment | Reported attendance work | Old maximum | Execution ms |
| --- | --- | ---: | ---: | ---: |
| small | student_inactivity | 2 | 1 | 0.265 |
| small | schedule_projection | 0 | 1 | 0.224 |
| small | session_attendance | 2 | 1 | 0.234 |
| medium | student_inactivity | 240 | 240 | 0.769 |
| medium | schedule_projection | 242 | 6 | 0.392 |
| medium | session_attendance | 242 | 240 | 0.611 |
| large | student_inactivity | 1526 | 1280 | 3.499 |
| large | schedule_projection | 10 | 10 | 0.339 |
| large | session_attendance | 1526 | 1280 | 1.908 |

Six of nine analyzed plans violate the old limits. The large operational fragment falls from 73.287 ms with 640 index probes to 1.908 ms with a single scan, yet the old gate rejects it for scanning 1526 rather than 1280 rows. The hosted small schedule plan remains the captured failure evidence; the local probe demonstrates the same invalid assumption across normal alternative plans, not a claim to have reproduced that exact hosted plan. EXPLAIN also rounds per-loop row averages: the five-probe small schedule plan reports zero work despite returning the selected attendance. These numbers cannot be treated as exact logical cardinality.

## Chosen change

Remove the copied EXPLAIN queries, their plan assertions and the join-spelling source check. Keep the actual RPC calls, result/cardinality checks, date/window and tenant checks, invalid-input checks, financial visibility rules, service-only ACL and SECURITY INVOKER checks unchanged. Keep the 63 timed RPC calls as diagnostics; do not turn wall-clock samples into a release threshold.

This fix belongs in the verification contract because the failing assumptions describe optimizer choices for copied fragments, not incorrect product behavior. No application query, schema, migration, fixture row or planner configuration changes. No claim of a general database I/O budget replaces the deleted assertions. Index/catalog attestation and the separate performance CI remain in force; neither is presented as proof of an unmeasured large-history workload.

## Validation and limits

The SQL file shrinks 703→416 lines; explicit `RAISE EXCEPTION` checks fall 27→20. Seven removed checks concern copied-plan presence/work or source spelling. Fixture insertion statements and the complete real-RPC behavioral section are byte-identical to the base. No new test file or framework is added; the inventory remains 53 files.

The private probe and 18-plan results are under `/Users/openclaw/Koaryu Releases/20260914-refund-release/dashboard-plan-probe*`. They contain synthetic data only. Full local verification, fresh independent review and exact-head CI must pass before the guarded merge. Then repin the merged candidate, inspect staging read-only, and run every hosted contract from a clean state. The original 19-pass/one-failure result does not count as a complete gate.

Staging authentication is now unblocked: the original approved password was paired with the wrong account during the failed attempt. Its original transfer record identifies the existing staging owner, and a single attempt with that proved pairing succeeded. The credential and existing provider/backup credentials were copied to the Home Server login Keychain and read back without exposing values. Source files used by operator tools remain intact. The production shared-test account's password was not recovered; do not claim authenticated production UI verification. Exact references and sensitive evidence remain private.
