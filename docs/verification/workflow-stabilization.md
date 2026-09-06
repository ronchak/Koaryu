# Core workflow stabilization — September 2026

This task uses the attached September 6 architecture audit as evidence to revalidate, not as proof of production incidents. The reviewed audit SHA was `675848eeb09649e8bd8c2a6d2702e1d1b70349b7`; implementation started from clean `main` at `d9f16b8` on `codex/workflow-stabilization`. Node 22.23.2, Python 3.11.16, Next 16.2.12, and React 19.2.4 were installed. No dependencies or hosting configuration were changed.

The owner selected **Core release; keep automations explicitly planned** during the task. Automations remains a direct-linkable roadmap, reachable through the account menu's Help links, rather than an ordinary primary-navigation feature. This change does not implement an automation builder.

## Findings and decisions

| Finding | Revalidation and implemented behavior |
| --- | --- |
| F1: lightweight students treated as complete | Confirmed in the current detail controller. Both cached and uncached live students now ensure an independent full detail read. Identity can display immediately; guardians, photo and record actions wait for complete data. Failure offers retry, without claiming the student does not exist. Summary updates cannot replace the hydrated detail. Guardian fields remain read-only. |
| F2: stale dashboard projections | Confirmed. Explicit exported business-command wrappers invalidate older summary requests and revalidate after settlement while Dashboard is active. Other routes defer the summary read until Dashboard entry. Summary failure retains the saved entity and last known totals, with scoped retry. Dashboard entry covers billing commands outside the shared store. Complete-studio totals still come from the server for a partial roster. |
| F3: lead refresh ordering | Confirmed and reproduced in helper and mounted tests. A bounded resource scope tracks read sequence, mutation revision and pending writes. Reads wait for pending writes and retry invalidated snapshots at most three times. Older GETs and deleted rows cannot overwrite later accepted state. Bootstrap uses the same scope. |
| F4: token renewal versus identity | Confirmed. Confirmed lead/student writes can commit across credential renewal only while the authoritative user/studio/role epoch remains unchanged. Reads use current credentials when replay is safe. No write is replayed. Roster reset depends on identity, not token. Auth, archive and subscription boundaries remain enforced. |
| F5: lost roster context | Confirmed. Bounded canonical query parameters retain search, status, program and sort. One session-storage return record retains page, signed cursor history (20 entries), scroll and originating control, scoped to user/studio/role/identity generation, expiring after 30 minutes and consumed after restoration. Return URLs accept only `/students` and allowed query keys. Existing signed-cursor recovery remains in use. Selection and whole records are deliberately not persisted. |
| F6: competing business dates | Confirmed. Authoritative workspace timezone drives the shared business day, roster and dashboard filters, lead defaults, student-form defaults and schedule date selection/ranges. A 30-second check plus focus/visibility events updates the day without replacing an open form's chosen values. Backend conversion defaults use the same timezone policy as dashboard facts. Browser inspection also reproduced a roster/detail date-display discrepancy, fixed by treating roster membership dates as calendar dates. |
| F7: ambiguous command failures | Confirmed transport/UI ambiguity; no duplicate production transaction was demonstrated. Aborted/disconnected commands, server 5xx outcomes and lost success bodies produce typed `CommandOutcomeUnknown` rather than generic replay advice. Safe `x-request-id` values are retained when response headers arrived. Student and lead creation forms retain error/draft context and disable repeated submission while outcome is unknown. Known HTTP rejections keep their status; reads keep their existing timeout behavior. |
| F8: roadmap in primary navigation | Confirmed product-scope mismatch, addressed for the owner's selected Core scope. Primary lead/billing links respect the existing authoritative roles; backend authorization remains the enforcement boundary. |
| F9: preview coverage limitation | Confirmed for the cited preview suite, not a claim that the repo lacked mounted tests. New Chromium tests mount the real provider, actions and controllers in live mode with synthetic auth and controlled I/O, including a real form and calendar rollover. Existing preview and auth-boundary tests are retained. |

No finding was already fixed by the intervening Browserslist patch. The work does not assert a production incident, comprehensive security certification, or measured hosted latency improvement.

## Small shared contracts

- **Identity:** the existing authoritative profile and identity epoch own response authority. A JWT change alone is not a new operator. Summary payloads must also match the captured studio. Feature bootstrap is rejected if membership/role differs from the preceding workspace response.
- **Completeness:** roster presence is not detail completeness. A route-local full resource owns guardian/photo detail and edit readiness. Signed photo URLs refresh with detail reads; URL failure does not redefine the underlying entity as having no photo.
- **Freshness:** explicit business commands reconcile dashboard facts; their results do not depend on successful revalidation. Read/read ordering and read/write revision checks are separate. This is not a new event bus or general entity framework.
- **Workspace:** `/dashboard/workspace` reuses `AuthService`, subscription enforcement and the studio metadata read. It does not load students, leads, programs or belts. The protected shell opens after this response and the existing legal-name gate. Students' feature bootstrap omits leads/belts; Billing does not request the combined bootstrap. Other relevant resources load on route entry. Feature failures stay local.
- **Dates:** a business date is a calendar date, distinct from an instant. Forms snapshot defaults when opened; midnight does not overwrite a draft.

## Server cache and command inventory

The existing dashboard cache is process-local, bounded to 128 entries and 15 seconds, with authorization before lookup and role-sensitive keys. The pre-existing invalidation call in `students.py` covers bulk archive. Its process-local nature cannot establish cross-worker read-your-writes.

The new `fresh=true` summary option bypasses both cached facts and older single-flight work **after authorization**, using the normal interactive provider lane. Thus reconciliation does not depend on which worker accepted the command. API callers that omit `fresh=true` retain the bounded cache. The frontend deliberately requests fresh facts on Dashboard entry and reconciliation. Tests exercise a warm cache and a deliberately blocked older flight; no distributed cache, schema change or migration is introduced. A fresh database read reports persisted application facts, not a guarantee that asynchronous provider/webhook work has completed.

| Command family | Existing protection retained | Recovery policy in this change |
| --- | --- | --- |
| Student create/update/archive | Atomic profile and soft-delete RPCs | Confirmed response updates local state; unknown create result is not replayed. Atomicity alone is not duplicate-request prevention. |
| Lead conversion | Atomic conversion RPC and deterministic student/guardian identities | Preserve confirmed result through token renewal; read reconciliation, never automatic write replay. |
| CSV import | Durable import-run key and request fingerprint; stable caller key | Existing same-key recovery and refresh warnings remain intact. |
| Schedule/attendance | Existing materialization and mutation coordinator | Preserve existing semantics; summary reconciliation follows completion. |
| Billing/provider operations | Existing operation claims, body-bound keys and provider idempotency | No new payment capability, header, charge or retry semantics. Returning to Dashboard refreshes persisted facts. |

Ordinary reads and writes keep their 12-second transport budget; workspace has 35 seconds to accommodate the existing 30-second provider budget, and summary has 30 seconds. No provider lane is bypassed. There is no new durable general-purpose command-status endpoint. Where a record lookup cannot establish an unknown result, the UI must not claim definite failure or automatically replay the write. A durable, cross-session generic command ledger would be separate migration-scoped work.

## Verification and release boundary

Baseline: `cd frontend && npm test` passed 825 tests; `cd backend && venv/bin/python -m pytest tests` passed 1,817 tests. The integrated validation results are recorded below. Commit-bound deterministic performance output is retained with the local task evidence after the clean commit.

All stateful UI work used explicit synthetic loopback configuration. Preview ran at `localhost:4010`; an unmodified detached baseline at `localhost:4011` supplied comparison screenshots. Live-mode mounted tests intercept external I/O and block non-fixture network access. They do not use a production backend, Supabase project or customer records.

The fixture proves dependency ordering, not a percentage speedup: the Students roster reaches a usable 251-row paged result while feature bootstrap is deliberately unresolved; Billing's authorized shell does not request combined bootstrap or schedule. `workspace.identity_ready` is recorded before those feature dependencies settle. The deterministic performance gate is separate from this browser fixture and from hosted latency measurement.

Visual evidence is kept in the task's local visualization directory under `workflow/`: before/after roster screenshots for desktop and 390px mobile, plus the mobile edit dialog. The comparison retains the brand and existing layout. Browser checks cover saved detail → explicit Back, canonical search/sort, Escape/focus behavior and mobile overflow. The mounted roster fixture separately exercises a later signed-cursor page, credential renewal and restoration.

No database migration is required. Ship the additive backend endpoints before the corresponding frontend through the normal release process. Rollback is the application commits; the additive endpoint can remain while rolling back the frontend. No push, PR, merge, deploy, hosted mutation or real message/payment was performed. The unfiltered exact-head Release candidate gate and separately authorized staging/release checks remain prerequisites for a release claim.


## Integrated results

| Command (repository root unless noted) | Result |
| --- | --- |
| `cd frontend && npm test` | Exit 0; **857 passed**, 152 suites, zero skipped/failed. Includes mounted production/development lifecycle cases. |
| `cd backend && venv/bin/python -m pytest tests` | Exit 0; **1,821 passed**. Ten existing dependency/deprecation/test-key warnings. |
| `cd frontend && npm run lint` | Exit 0; no warnings/errors. |
| `cd frontend && npx tsc --noEmit` | Exit 0. |
| `cd frontend && npm run build` with explicit synthetic loopback values and `NEXT_PUBLIC_PREVIEW_MODE=false` | Exit 0; production compilation, type checking and route generation passed. |
| `npm run generate:api-types` followed by `npm run check:api-types` | Exit 0; only the new workspace response contract was added. |
| `cd frontend && KOARYU_E2E_FRONTEND_URL=http://localhost:4010 KOARYU_E2E_DATA_PLANE=disposable-preview npm run test:e2e:core-ui -- --workers=1` | Exit 0; **5 passed**. |
| `cd frontend && node --experimental-strip-types --test tests/workflow-stabilization-mounted.test.mjs` | Exit 0; **21 passed**. Includes strict development-mode restoration, unknown transport coverage in the separate API suite, and actual mounted form failure/draft/keyboard behavior. |
| `git diff --check` | Exit 0. |
| `npm run check:performance-regression -- --expected-sha "$(git rev-parse HEAD)"` | Run on the clean task commit; exact SHA and profile metrics are in the accompanying `performance-evidence.json`. |

The final workflow trace records `/dashboard/workspace` → `workspace.identity_ready` → the Students-specific bootstrap and paged roster read. The fixture deliberately never settles feature bootstrap while asserting that the roster becomes usable. The Billing trace contains only the workspace read before shell readiness. These timings include test/browser scheduling and are **not** a production latency benchmark or a claimed speedup.

Local evidence directory:
`/Users/openclaw/.codex/visualizations/2026/09/06/01a077d7-6403-7ec0-ac03-4b6291983ac9/workflow/`.
It contains matching 1440×1000 desktop and 390×844 mobile before/after screenshots, mobile edit-dialog evidence, final command logs, synthetic startup traces, and the commit-bound performance output. Actual browser Back and the explicit Back button both restored the Maya filter and focused `Open Maya Chen profile`; mobile dialog Escape focused `Edit`; neither inspected viewport had horizontal page overflow.

The initial baseline comparison's Webpack attempt hit an existing pure-selector CSS error. The comparison was rerun successfully using the repository's normal Turbopack path; no baseline source was modified. The temporary baseline checkout and preview servers were removed/stopped afterward. No test unavailability is being counted as a pass.

## PR #147 review follow-up

Codex and an independent `claude -p --model claude-opus-5` review checked the original implementation. Their actionable findings were addressed before merge:

- Archive confirmation now advances the roster mutation epoch, including when credentials renewed during the write. A mounted overlapping-read regression prevents archived rows from reappearing.
- Restoring profile return context consumes the saved record, so a later unrelated roster visit cannot reuse an old page or cursor.
- Add class snapshots the selected studio calendar day for both one-off and recurring forms. Crossing midnight leaves an open draft unchanged.
- Leads, Reports, Schedule, Belt Tracker and student subroutes load omitted program/lead data on entry. The legacy roster fallback can acquire its first complete roster after a Billing entry. The latter problem requires the paged-roster flag to be disabled; ordinary live filters remain server-owned.
- Business commands refresh summary facts immediately only while Dashboard is active. Other routes invalidate old summary requests and rely on the fresh read at Dashboard entry, avoiding an uncached summary request for every attendance action.
- Uncertain lead saves block only the current form. Dismissal permits a new form, and uncertainty is separate from an in-progress request. Mounted tests use the real `CommandOutcomeUnknown` class for both lead and student forms.
- Command-specific timeout/network recovery copy survives the typed unknown outcome, including CSV import's same-key retry instructions. Generic read retry copy is not applied to unknown writes.
- Cached detail loading uses the existing record skeleton. Summary retry returns a rejected promise rather than throwing synchronously, stale reload instructions were corrected, and rejected photo actions no longer invalidate detail reads.
- A real Next.js browser test reproduced rapid typing being erased by delayed `useSearchParams` updates. URL synchronization now compares against the browser's synchronous address. The test covers rapid input, filter changes, profile return and a same-route navigation that clears filters.

The remaining low-priority Opus suggestions are deferred for this merge. Preview retains its fixture clock; a null authoritative role keeps navigation closed; workspace metadata failure keeps the retryable access gate closed because the studio clock is unavailable; and focus returns to the matching roster row even when the record was opened from its reading rail. Compatibility with an IANA zone accepted by the server but absent from an older browser's Intl database remains a follow-up. These do not change the current supported live workflows verified here.

The legacy combined-bootstrap adapter remains only for older lifecycle tests. New independent workspace/feature fixtures cover route transitions and authority changes, and the added browser test checks the actual Next.js URL behavior. Reviewer results, final-head CI and thread resolutions are recorded on [PR #147](https://github.com/ronchak/Koaryu/pull/147).
