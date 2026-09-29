# Everyday correctness verification

This candidate corrects ordinary studio workflows and report facts. It adds V52 atomic lead commands and V53 participation-date inactivity reads. The changes are not deployed merely because they are merged. Hosted release identity, backup and migration evidence must be recorded separately.

| Findings | Result |
| --- | --- |
| FR1-02 | Settings and support forms retain submitted drafts, reject same-tick duplicate submits and keep editing controls locked until settlement. |
| FSH3-02, FC3-01 | Student photo, profile, archive and bulk tag/status commands share per-student ownership. Roster commands capture selection and payload, preserve partial/failure context, and cannot publish into a replacement identity. Detail completion cannot navigate after unmount. |
| OPS2-02 | Template and studio patches distinguish omission from explicit clears. Required nulls are rejected; template time/date validation uses the merged record. Owner-transfer and tenant checks remain. |
| OPS1-03, FSH2-03, FSH2-04, BT3-06 | Lead edits/history and keyed follow-up effects commit atomically. A per-lead provider owner retains the original command through ordinary page remount and token renewal. Recovery reconciles the current row; absence returns HTTP 404 without disguising provider failures. |
| FSH2-05, FT2-01 | Report and affected export utilization count attendance from the same positive-capacity sessions as the denominator. Total visits and genuine over-capacity percentages remain. |
| FSH2-06, OPS1-10 | Report fetch/display dates follow the studio calendar, lead overdue labels survive daylight-saving transitions, and exports resolve one authorized, budgeted studio calendar for timestamp-derived windows. Date-only fields stay date-only. |
| OPS1-07, OPS1-08, BT1-01 | Intelligence excludes known canceled/deleted visits. Belt export shares operational credit rules, program scope and exact promotion boundaries. General missing-session visit fallback remains; nonexistent-session belt credit does not. Goldens have independent semantic assertions. |
| DM3-01 | Dashboard and roster inactivity use the class participation date, UTC check-in fallback and future-date exclusion. The retained Python reference matches. Existing status, hold and student-start gates remain. |

PROGRAM-IMPORT-01 follows the September29 owner-authorized choice. Preview requires Program when a resolved Current Belt belongs to a program, including a unique belt name or UUID. Explicit matching Program and unscoped belts remain valid. Invalid execution records only its existing run claim/result and makes no student or membership write. The unresolved-belt option cannot bypass this rule for a known scoped rank.

## Evidence

Meaningful old-code failures cover draft reentry, mixed-capacity ratios, daylight-saving labels, studio-day rollover, invalid-session visits, belt credit boundaries, absent-lead HTTP behavior, provider-preserving lead page remount, and dashboard/roster date disagreement. The DST regression configures its own timezone. Lead absence tests use provider-shaped zero/one/multiple-row behavior and the real HTTP error handler.

The combined frontend at `8579637cf97c87ff0cf7ed91632a79ff20f72c57`, frontend tree `1ec6bcba76f5b8999e1d14249961a69b8882d06b`, passed 1,033 tests, lint, formatting and production build with example environment values. A fresh independent Opus review passed. Its two SQL-dependent retry advisories were resolved by source and SQL proof: permission checks can reject a retry after an earlier commit, so a general 4xx does not release an unknown key; an authorized same-key receipt replays before conversion/state checks.

An earlier lead-only full frontend run had one timing failure in an untouched quiet-interval test under concurrent load. The file passed alone, and the combined full run passed unchanged. No threshold was relaxed.

V52 passed strict canonical and logical V51-to-V52 restore, atomic lead and release UI contracts, and 67 real-session concurrency cases. One generated whitespace change changed the v33 definition digest. Complete canonical/restored observation found no other mismatch; only that current V52 pin changed, and strict proof then passed. Historical migrations stayed immutable.

The final V53 focused canonical/logical restore passed 41 pinned checks per copy, retained-row preservation and exact 14/30/90-day dashboard/roster parity. Release manifest `22:acb4b6baf973ebfd0294455fc1391e9dc87423605902cab228602a562e459198:0` matches both copies. Earlier whitespace-only v34 output was invalidated and the final file was retested.

V53's focused pilot compares independent named IDs and scaled roster totals with Dashboard counts, including delayed entry, future classes, old check-in/recent class, old visit/recent enrollment, UTC fallback and tenant separation. Existing dashboard, roster, payer, security and RLS checks also passed on disposable canonical/restored copies. The Python reference has a 1,001-row proof whose recent participation is on the second bounded page.

Fresh independent Opus backend/business-SQL review at `ea95a2463b424dd252d7572b19bafa0424c28bb1` and release-metadata review at `4d279736b55209de837f47f44003ca2386360728` passed. The latter independently checked generated source/ACL fingerprints and rollout classification. The app-only import correction is integrated as `151066c47710e18922fd2ea111e05a0eb56f10b3`; root reviewed its planner, executor and issue-rendering path and independently checked four combinations, including the unresolved-belt override. SQL tooling, Supabase, generated readiness and frontend Git objects stayed byte-identical across that integration.

The combined backend at `151066c47710e18922fd2ea111e05a0eb56f10b3` passed all 2,052 tests, full formatting and generated API types. Release-workflow, generated-attestation, environment-example and support-privacy gates passed at `4d279736b55209de837f47f44003ca2386360728`; their inputs are unchanged by the import correction.

Release acceptance also requires the complete strict V53 local chain, deterministic performance gate and exact-head Release candidate gate. The PR and private run record bind those results to the delivery candidate. Focused or diagnostic runs do not replace them. The complete local chain started at `4d279736b55209de837f47f44003ca2386360728`; later app-only and documentation changes preserve the exact scripts, Supabase and generated-readiness Git objects.

## Limits

Client ownership is scoped to a mounted provider and identity. It does not promise cross-tab or server write serialization, hard-reload command storage, or automatic retry of uncertain writes. Known rejected photo previews and stale completions are handled; this is not a claim that every old transient notice is scoped.

Raw SQL timings are diagnostic. On the retained local fixtures, median V52-to-V53 time was 39.8-to-44.7 ms for medium, 50.5-to-69.0 ms for large, and 89.9-to-253.8 ms for the extra-large 10,000-student/410,000-attendance stress case. The last plan used a parallel scan where one studio dominated the table. These are not hosted navigation measurements, and the unchanged deterministic fake-provider gate does not measure SQL/network latency.

No live billing activation, historical financial backfill, provider-secret change or production contract execution belongs to this correctness work. The owner reaffirmed autonomous root-coordinator production migration authority on September29 and removed the stale human-only terminal rule. Global and private operator instructions now match the repository policy. All inspection, dry-run, backup/restore, exact-candidate, one-migration checkpoint and 30-second announce-and-pause gates remain; subagents have no production authority.
