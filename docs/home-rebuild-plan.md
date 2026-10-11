# Koaryu Home rebuild: living plan

Contract: [`docs/home-rebuild-brief.md`](home-rebuild-brief.md). This file records phase status,
decisions, dispatched subagents and review dispositions. It is updated at every gate.

- Orchestrator: Claude Opus 5.5 (this session).
- Branch: `claude/home-rebuild`, cut from `claude/horizon-dashboard` at `28f09c1`.
- Pull requests: one per phase, stacked on `claude/horizon-dashboard` (which must be pushed
  first; it was local-only when this plan started).
- Model roster as wired on this machine: Sol = `gpt-6.1-sol` through `codex exec`; Astra =
  `gpt-6-astra` through `codex exec review`; Opus 5.5 and Fable 5.1 = Claude subagents.

## Pull requests

| PR | Branch | Base | Status |
| --- | --- | --- | --- |
| [#275](https://github.com/ronchak/Koaryu/pull/275) Phase 1 backend contract | `claude/home-rebuild-p1` | `claude/horizon-dashboard` | Ready |
| [#276](https://github.com/ronchak/Koaryu/pull/276) Schedule and Leads deep links | `claude/home-rebuild-links` | `claude/home-rebuild-p1` | Ready; Astra: SAFE TO MERGE |
| [#277](https://github.com/ronchak/Koaryu/pull/277) Phase 2 client data layer | `claude/home-rebuild-p2` | `claude/home-rebuild-links` | Ready; Astra round 2: SAFE TO MERGE |

## Phase status

| Phase | Status | Gate evidence |
| --- | --- | --- |
| 0. Inventory and decisions | Gate passed 2026-10-10 | Sol reports 0A to 0F; Fable decisions in [`home-rebuild-decisions.md`](home-rebuild-decisions.md) |
| 1. Backend contract | Gate passed; PR #275 ready | Backend suite 11,112 passed, 1 pre-existing failure (below); `check:api-types` green; ruff format clean |
| 2. Client data layer | Gate passed; PR #277 ready | Frontend suite 2,373/2,374 (one schedule-summary load flake, passes alone); 102 Home tests green; lint, tsc, Prettier clean |
| 3. Frame and bands on the kit | Fable gate passed; tests green; Astra review pending | Frontend suite 2,440/2,441 (workflow-canvas load flake, 18/18 alone); build green; lint, tsc, Prettier clean |
| 4. Edit Home | Not started | |
| 5. Delete and document | Not started | |
| 6. Shell and navigation | Not in scope (owner default: no) | |

## Phase 0 findings

### Baseline census (preview mode, 2026-10-10)

Script: `/tmp/home-rebuild/tools/home-census.mjs` (Sol, outside the repo). Preview mode makes no
API requests, so request counts come from the mounted synthetic-I/O tests instead.

| Size | First attention row Y | First button | Page height |
| --- | --- | --- | --- |
| 390x844 | 683 | Customize at 291 | 2840 |
| 834x1112 | 685 | Customize at 295 | 2598 |
| 1000x614 | 692 | Customize at 301 | 2605 |
| 1440x900 | 413 | Customize at 34 | 1446 |

The h1 is the eyebrow word "Dashboard"; phone panels carry 160px and 332px minimum heights. The
same screen shows "Oldest 2 days overdue" in the attention row and "1 day overdue" in the stats
strip, because the strip reads the newest five follow-ups, not the oldest.

### Cold-load requests today (live mode, admin, promotions visible)

1. `GET /dashboard/workspace`
2. `GET /dashboard/bootstrap?view=dashboard&bounded_dashboard=true` (studio, programs, 200
   students, ladders), `GET /dashboard/summary?include_follow_ups=true`, `GET /belts/ladders`
3. `GET /belts/eligibility?ladder_id=…`

Target: workspace, bootstrap (studio and programs only), `GET /dashboard/home`; revisit issues
only `GET /dashboard/home`.

### Deep links (0A)

| Target | Form | Status |
| --- | --- | --- |
| Billing exceptions | `/billing?tab=invoices` (tab shows the failed/past-due payer queue) | works |
| Inactive 14+ days | `/students?inactiveDays=14` | works |
| Student status | `/students?status=active` / `trialing` / `paused` | works (Home's active count includes trialing) |
| Student profile | `/students/<id>` | works |
| Ready to promote | `/belt-tracker#belt-ready-title` | works as an anchor |
| Belt test event | `/belt-tests?event=<uuid>` | works |
| Schedule date / session | none | missing: add `?date=YYYY-MM-DD&session=<class_sessions.id>` |
| Leads due / overdue / one lead | none | missing: add `?focus=overdue\|today` and `?lead=<id>` |
| Missing emergency contact | none | missing: needs a roster filter, front and back |
| Promotions awaiting approval | none | missing: `/belt-tracker` focus |
| Attendance report | `/reports` (no anchor) | partial |
| Setup steps | each step's own page | works per step |

### Data sources (0C, 0D)

- `dashboard_summary_facts` (current body in V53, pinned by V57) already returns studio,
  today, student counts, attendance window facts, today's sessions (five rows, with session
  UUIDs), the 14-day inactivity count, the missing-contact count, setup flags, billing attention
  count and recent students. It must not be edited.
- No "expected attendance" exists anywhere. Rows have `attendance_count` (non-absent) and
  `capacity`.
- Leads have no `next_step` column.
- Promotions can be computed server-side by reusing `BeltService.get_eligibility` for the first
  ladder (the bootstrap's "primary" ladder); no new SQL needed.
- Follow-up rows today are the newest five by creation date; the new contract needs oldest
  first, with counts from the same query.
- "Setup disappears for good" has no latch today; flags are recomputed existence checks.
- The attendance window labelled "30 days" spans 31 dates (`today-30` to `today`).
- The fact cache keys on billing visibility only; role shaping must happen after the cache.

### Migration cost after V57 (0F)

V57 attests the complete `public`/`private` catalog: every table, function signature and
definition, ACL, policy and index, plus the migration count (152) and head. Any new table or
function, even read-only, fails `check:supabase-contracts-local`, `check:release-attestation`
and hosted `/health/ready` unless it ships as a new release version, V58. That means a new full
preflight, declarations, regenerated readiness metadata and restore scripts, a V57-to-V58
restore proof, rollout-tool support, contract inventory and docs: about 40 to 55 files, most of
them generated. A production V58 apply is an owner-run cutover under `docs/cutover-gates.md`;
until it runs, a preferences endpoint backed by the table would fail in production.

The backend reads and writes every table with the service-role client and enforces tenancy in
the service layer, so row-level security would not be what protects a preferences PUT either
way. Browser table grants are revoked repo-wide.

The no-migration alternative is a studio-keyed namespace in the user's Auth metadata, read and
written only by the backend through the Auth admin API, with the backend resolving membership,
validating size and shape, and reconciling on every read. It persists across devices and role
changes. It is not a table and has no row-level security.

Also found: `node scripts/generate-release-attestation.mjs --check` fails locally because
`scripts/verify-v38-v39-restore-contract.py` has mode 0600 in this working tree (expected
0644). It predates this work and is left alone.

### Phase 3 census (preview, after Fable's fixes)

| Size | First actionable row Y | Page height |
| --- | --- | --- |
| 390x844 | 571 | 1752 (actions stack under text on phones, per M1) |
| 834x1112 | 609 | 1581 |
| 1000x614 | 609 | 1581 |
| 1440x900 | 395 | 932 |

### Phase 3 census (preview, before Fable's review)

| Size | First actionable row Y | Page height |
| --- | --- | --- |
| 390x844 | 571 (was 683) | 1580 (was 2840) |
| 834x1112 | 609 | 1533 |
| 1000x614 | 609 (at the fold) | 1533 |
| 1440x900 | 395 | 995 |

The h1 is the greeting and never changed after first paint; no panel has a minimum height; preview
mode makes no API requests.

### Inventory (0B)

Shared code the deletion phase must preserve or move first:

- `lib/dashboard-horizon.ts` ridge paths are imported by the kit's `ui/horizon-hills.tsx`.
- `lib/dashboard-brief-greetings.ts` is used by the account name section.
- `lib/dashboard-freshness.ts` is a timestamp check, not a subscription; the new hook needs an
  explicit after-command signal.
- `frontend/scripts/capture-dashboard-performance.mjs` and `scripts/check-performance-regression.mjs`
  name the bootstrap and summary resources and run the backend summary fixture.
- `e2e/preview-smoke.spec.ts` asserts the exact heading "Dashboard".
- `capture-landing-day-shots.mjs` finds the crop by the text "Classes Today" and "Adult No-Gi".

Frontend test dispositions (from 0B; Phase 3 actuals noted; revisited in Phase 5):

| Test | Disposition |
| --- | --- |
| `dashboard-billing-summary` | Rewrite against `home-model.ts` |
| `dashboard-brief-greetings` | Keep |
| `dashboard-home-mounted` | Deleted in Phase 3; its revisit coverage moved to `home-page-mounted` |
| `dashboard-horizon` | Rewrite against `home-model.ts`; keep ridge checks for the kit |
| `dashboard-identity-gate` | Keep |
| `dashboard-layout-store` | Rewrite against `home-preferences.ts` |
| `dashboard-loading-contract` | Keep |
| `dashboard-loading-regions` | Home cases rewritten in Phase 3; other pages' cases kept |
| `dashboard-page-model` | Rewrite against `home-model.ts` |
| `dashboard-performance-mounted` | Rewritten in Phase 3: cold admin load is workspace + bootstrap (home) + `/dashboard/home`; revisit is `/dashboard/home` only |
| `dashboard-shell-home-contract` | Rewritten in Phase 3; shell, readiness and purge assertions kept |
| `dashboard-widget-catalog` | Rewrite against `home-preferences.ts` and `home-model.ts` |
| `dashboard-widget-composition` | Delete |
| `dashboard-widget-geometry` | Delete |
| `dashboard-widget-view-models` | Rewrite against `home-model.ts` and the preview payload |

## Decisions

### For the owner (brief Section 9, plus decisions surfaced in Phase 0)

Proceeding with the defaults unless the owner objects.

| # | Decision | Default |
| --- | --- | --- |
| 1 | Keep `/dashboard` and the nav label "Dashboard" | Yes |
| 2 | Persist Home preferences on the server with a new table | Yes (see 0F) |
| 3 | Keep readiness attribute names and stage meanings stable | Yes |
| 4 | Remove the week strip | Remove unless Fable designs a linked one |
| 5 | Delete Quick Actions | Yes |
| 6 | Paper grain into `Header` or drop | Fable decides at the Phase 3 gate |
| 7 | Phase 6 shell and navigation | No |
| 8 | Add small, additive URL readers to Schedule (`date`, `session`) and Leads (`focus`, `lead`) so Home rows open the exact view | Yes; brief 4.2 calls for these views, and no other behaviour on those pages changes |
| 9 | Preferences persistence path (see "Migration cost" below): (a) the brief's `home_preferences` table, which makes this a V58 release; (b) a studio-keyed namespace in the user's Auth metadata, written only by the backend, no migration | **Asked 2026-10-10.** Only Phase 4 depends on it. Orchestrator recommendation: (b) now, with (a) as a follow-up if the owner wants a table |
| 10 | No new SQL anywhere else in this rebuild (no roster filter for missing emergency contacts, no promotions RPC) | Yes; every new function or table is release work after V57 |

### Product decisions (Fable, Phase 0 gate)

Full text: [`home-rebuild-decisions.md`](home-rebuild-decisions.md). Changes to the brief:

- **Stats (4.2):** the strip never repeats a Needs attention kind, and "Classes today" is dropped
  because the agenda shows it. Admin: Follow-ups due · Ready to promote · Active students ·
  Attendance. Front desk: Follow-ups due · Active students · Attendance. Instructor: Ready to
  promote · Active students · Attendance.
- **Needs attention (4.2):** four kinds in fixed order: payments, setup, away (14+ days), missing
  emergency contact. Follow-ups and promotion approvals are a stat plus a list panel instead.
- **Agenda (4.2):** no "expected" (it does not exist). Rows show "4 checked in", "12 spots" or a
  "No check-ins" tag once started; "Take attendance" on started classes, "Open" otherwise. Week
  strip removed (owner decision 4 default holds).
- **Panels (4.2, 4.3):** Follow-ups, Ready to promote, New students (renamed from Recent
  students, default off). No Compact/Expanded in version one. Follow-up rows carry `stage` and
  reuse `getLeadNextAction` from Leads.
- **Edit Home (4.3):** approved with amendments: icon plus text trigger below Today's classes;
  "Always shown" said once; `order` holds hidden panels too; Reset disabled at defaults; flush the
  debounced PUT on Done and on `visibilitychange`.
- **Header (4.1):** grammar table for the sentence (anchor plus up to two needs clauses);
  description slot reserves one line while loading.
- **Copy (4.7):** full string set approved; per-panel loading and error strings are dropped
  because there is one loading and one error state.
- **Paper grain:** dropped (owner decision 6, delegated to Fable).
- **Orchestrator amendment:** belt pairs use a lucide arrow icon, not a Unicode arrow.

### Product decisions (Fable, Phase 3 gate)

- Confirmed: three questions in order, no fact twice below the header, first actionable row on the
  phone's first screen, plain speech, both themes read as one system.
- **M1** One row shape on phones: every work-row action under the title and meta.
- **M2** The sun never sits under words: right edge or hidden at 641–1023px; description capped
  before the sun at desktop widths.
- **M3** Bands and panels never vanish: a section the server could not compute keeps its title and
  link with a neutral "Couldn't check …" line; the sentence drops unknown clauses and never claims
  "nothing needs you" while anything visible is unknown.
- **M4** The refresh-error notice sits below the stats strip so the strip stays on the ridge.
- **S1** "Couldn't refresh" uses the warn tone; "Couldn't load Home" stays alert.
- Ruling: with the class count unknown and every visible needs input known and zero, the sentence is
  "Nothing needs you."; it is empty only when a needs input is unknown and no clause remains.
- Kept: the engineer's empty-state icons, header button icons and the moved sun; both "Take
  attendance" actions on desktop (same class, an action echo, not a fact).

### Technical decisions (orchestrator)

- `needs_attention` items carry facts (`kind`, `count`, kind-specific fields), not `label`,
  `note`, `href` or `tone`. The client maps them through `home-copy.ts` so every string lives in
  one file (brief 4.4 and 4.7 conflict; 4.7 wins).
- Agenda rows carry studio-local `start_time` and `end_time` wall-clock strings, as the facts RPC
  stores them, rather than instants.
- `GET /dashboard/home` materializes today's recurring sessions once when the facts RPC cannot
  list today's classes, using the same idempotent RPC and permission check as
  `POST /schedule/window/materialize`. Otherwise "Take attendance" would have no session to open
  early in a month, because only the Schedule page materializes sessions today.
- A failed or denied materialization write never fails Home; it only leaves today's classes
  absent. Reading Home does not require write access.
- `useHome` clears the shown payload and its retained copy on 401, 402 or 403, because retained data
  never grants access (README "Dashboard loading"); ordinary errors keep the last payload.
- Retained Home snapshots carry their identity scope (generation, user, studio, role) and never
  serve another identity.
- Deep-link record ids are UUIDs only in live mode; preview mode also accepts the demo's short
  ids (`sess-1`, `lead-1`) so demo links work.
- The trimmed bootstrap is a new `view=home`, not a change to `view=dashboard`, so a backend
  deployed ahead of the frontend keeps serving the current page. Phase 5 removes the old view.

## Dispatch log

| ID | Model / role | Task | Result |
| --- | --- | --- | --- |
| 0A | Sol / explorer | Deep-link forms | Done; see Deep links |
| 0B | Sol / explorer | Module and test inventory | Done; see Inventory |
| 0C | Sol / explorer | Schedule session identity and today's classes | Done |
| 0D | Sol / explorer | Backend data sources for the payload | Done |
| 0E | Sol / tools | Playwright census, preview mode | Done; see Baseline census |
| 0F | Sol / explorer | Migration path after V57; lead stages; roster filters | Done; see Migration cost |
| G0 | Fable / product | Phase 0 gate: D1 to D8 | Done; approved with changes, see `home-rebuild-decisions.md` |
| 1A | Opus 5.5 / backend | `GET /dashboard/home` route, schema, service; bootstrap `view=home` | Done (resumed once after an API rate limit) |
| 2B | Sol / fixtures | `preview-home-payload.ts` and its tests | Done; 14 tests green |
| 2A | Opus 5.5 / frontend | `use-home.ts`, `home-model.ts`, store loader, freshness subscription | Done; fixed both 2D bugs (page-wide read order; date in the flight key) |
| 2C | Sol / tests | `home-model` and `dashboard-freshness` Node tests | Done; 60 tests green, no bugs |
| 2D | Sol / tests | Mounted `useHome` tests on the StoreProvider harness | Done; 28 tests, found two bugs (retained ordering after unmount; date flip joining a stale read) |
| 3K | Opus 5.5 / kit | `Header` hero hills and reserved description, `HorizonWorkRow`/`HorizonWorkList`, `HorizonPanelLink`, ridge geometry moved into the kit, 3-stat phone rule | Done (`624e9f1`); band pixel-identical on other pages; stats 40px over the ridge at all sizes |
| 3KT | Sol / tests | Kit tests | Done; 18 tests green, no bugs |
| 3P | Opus 5.5 / page | `home-copy.ts`, `components/dashboard/home/*`, route swap, bootstrap `home` view, readiness | Done; build green; 13 old-page test failures handed to 3T |
| G3 | Fable / product | Phase 3 visual gate | GATE PASSES after M1–M4 and S1 (confirmed from re-shot screenshots) |
| 3T | Sol / tests | Fix the 13 old-page failures; home-copy and home-page tests; rewrite old Home tests; preview smoke heading | Done; 13 failures dispositioned; the orchestrator updated two sentence assertions to Fable's M3 ruling |
| 1B | Sol / tests | Backend suite for `/dashboard/home`; regenerate API types | Done; found one bug (a transient error could mask a 403 between the two follow-up reads), fixed by the orchestrator |
| 3A | Opus 5.5 / frontend | Schedule `date`/`session` and Leads `focus`/`lead` URL readers (decision 8; independent of Phases 1 and 2, so run in parallel) | Done; build green, preview browser check 24/24 |
| 3B | Sol / tests | Tests for the deep-link readers | Done; found two Schedule races, fixed by 3A; 112 tests green |

## Review log (Astra)

### Phase 1, round 1 (`ad32002`): MERGE AFTER P0/P1 FIXES

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | Concurrent requests that each materialize and invalidate can exhaust the cache's retry and fail good requests | P1 | Accepted: serialize recovery per studio and date; re-check the cache after acquiring |
| 2 | Follow-up counts and rows come from two snapshots and can contradict each other after an intervening edit | P1 | Accepted: derive counts from rows when they cover the boundary; otherwise validate, retry once, or omit |
| 3 | The outer gather raises the first failure in section order, so a facts error can mask a 403 | P1 | Accepted: access failure wins, as in the inner gather |

Fixed in `7f8e5e0`.

### Phase 1, round 2 (`7f8e5e0`): SAFE TO MERGE

No new findings. Astra confirmed each fix, including cancellation safety of the per-day lock and that
billing-visible and billing-hidden reads stay separate.

Round 1 also confirmed studio scoping, identity before cache, billing separation, role omission,
the shared promotions entry, setup ordering, the missing-contact predicate, and unchanged legacy
summary and bootstrap behaviour.

### Deep links (#276): SAFE TO MERGE

No P0 or P1 findings. Astra's read-only sandbox could not resolve Playwright for the mounted tests or
run the build; both ran locally (112 tests green, build green).

### Phase 2, round 1 (`c963842`): MERGE AFTER P0/P1 FIXES

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| 1 | After a newer read is refused (403) and the page unmounts, an older successful read can repopulate the retained entry, so a revisit paints data before access is re-verified | P1 | Accepted: a refusal watermark per scope that survives unmount rejects older completions |
| 2 | A facts-triggered read after a command can join a fresh read that started before the command and show pre-command counts until the next trigger | P2 | Accepted (cheap and user-visible after taking attendance): fact-change generation; queue one follow-up read |

Astra's sandbox could not run the mounted suite (ESM Playwright through `NODE_PATH`); it reviewed its source.
The model, preview and freshness suites passed (74 tests). Both fixed in `300b854`.

### Phase 2, round 2 (`300b854`): SAFE TO MERGE

No new findings; refusal ordering and fact generations confirmed, and a later successful read still
recovers Home after a refusal.

## Follow-ups (deferred polish)

- Fable L1: at 1000x614 the first row sits at the fold because the strip is 2x2 below 1024px;
  consider a single-row strip from 768px (kit breakpoint, affects other pages).
- Fable L2: the loading placeholder could draw the role's default panel frames so the page does not
  grow on arrival.
- Fable L3: three ink buttons on one desktop screen; if heavy after Phase 4, tint the band-level
  emphasis and keep the header's ink.
- Fable: at 1440 the longest D6 sentence wraps to a lone "weeks."; cosmetic.
- Fable L5: preview "Red Tip" ranks render white swatches; confirm rank colours with live data.
- A real "missing emergency contact" roster filter (front and back), in a later release (Fable D2).
- Pre-existing, unrelated: `backend/tests/test_billing_landing_runtime.py::test_membership_and_projections_share_one_total_budget`
  fails on `claude/horizon-dashboard` as well (HTTP 504 within its 0.4s budget on this machine).
- Load flake, unrelated: `frontend/tests/workflow-graph-mounted.test.mjs` "real canvas preserves finite
  geometry…" fails occasionally in the full suite and passes alone (18/18).
- Load flake, unrelated: `frontend/tests/schedule-visible-summary-mounted.test.mjs` "rendered recurring total
  matches cancellation…" failed once in the full suite (`fixture.setDate is not a function`, its own fixture
  not mounted yet) and passes alone.
- Pre-existing, unrelated: `generate-release-attestation --check` mode mismatch on
  `scripts/verify-v38-v39-restore-contract.py` in this working tree.
