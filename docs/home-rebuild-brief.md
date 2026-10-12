# Koaryu Home rebuild: brief for the orchestrating agent (Opus)

You are the orchestrator for a from-scratch rebuild of the authenticated home page at `/dashboard`. This brief is the contract. It carries the findings of a ground-up evaluation done on 2026-10-10, the design to build instead, the team and delegation rules, the phases and gates, and the definition of done. Read it fully before you spawn anything.

## 0. Read first, then set up

1. `AGENTS.md` at the repo root, then `frontend/AGENTS.md` (especially the "Horizon is the product design language" bullet and the "Dashboard pages own their cold-load placeholders" bullet), `backend/AGENTS.md`, and `supabase/AGENTS.md`.
2. `frontend/README.md`, sections "Authenticated loading" and "Dashboard loading". These describe the retained-state and placeholder contract every product page honours.
3. `docs/dashboard-redesign-implementation-plan.md` is the previous generation's plan. It is history, not a spec. Note that it argued for an ordered list rather than free x/y placement, and the shipped code did the opposite. Do not repeat that.
4. Branch state at the time of writing: `claude/horizon-dashboard` is 33 commits ahead of `main` and contains the Horizon kit. Create `claude/home-rebuild` from the head of `claude/horizon-dashboard`. Open pull requests against `claude/horizon-dashboard`, or against `main` if that branch has merged by then. Never push to `main`.
5. The worktree may contain unrelated owner changes (for example an untracked `scripts/dojo.mjs`). Leave them alone.
6. Keep a living plan at `docs/home-rebuild-plan.md` with phase status, open decisions, and the subagents you have dispatched. Update it at every gate.

## 1. Why this rebuild

The current page looks good and is carefully coded, but it is built on decisions that fight the product goal. Findings from the evaluation, with the files that prove them:

- **It says each fact up to four times.** The greeting sentence, the stats strip, and the cards all read the same view models. Billing exceptions, follow-ups, promotions, active students, attendance, classes today, and the Add student and Take attendance actions each appear two to four times on the default admin screen. See `frontend/src/components/dashboard/dashboard-horizon.tsx` (the strip) and `frontend/src/components/dashboard/dashboard-home.tsx` (the cards and the brief).
- **Customization is the wrong model.** A thirteen-widget catalog on a free two-dimensional grid with four footprints, continuous resize, holes allowed, a move grip that is invisible to pointer users, and a resize handle that appears only after pressing a card. Layouts live only in this browser's local storage keyed by user, studio, and role, so they never sync and are lost on a role change. Two catalog entries are permanently unavailable stubs. On phones the grid is a flex column and a drag silently rewrites the stored desktop layout. About 2,350 lines serve this. See `frontend/src/lib/dashboard-layout-store.ts`, `dashboard-widget-geometry.ts`, `dashboard-widget-catalog.ts`, and lines 857 to 1770 of `dashboard-home.tsx`.
- **The data pipeline is mostly dead in production.** Five requests on cold load across three dependency levels. Bootstrap pulls two hundred full student rows the page never uses when the summary succeeds. Ladders are fetched twice. Eligibility is refetched on every visit. The local-statistics fallback can never render in live mode. The page's "data ready" flag depends on leads and schedule datasets the page never loads. The catalog's `stateCopy`, `provenanceCopy`, and `windowCopy` have zero consumers. Eight controller output props are never read. The backend carries about 1,300 lines of a pre-RPC Python summary builder kept only for tests. See `frontend/src/lib/dashboard-page-controller.ts`, `dashboard-page-composition.ts`, `dashboard-widget-view-models.ts`, `dashboard-widget-summary-adapter.ts`, and `backend/app/services/dashboard_summary_*.py`.
- **The copy is engineering vocabulary.** Owners read "Open obligations across the current studio summary.", "The billing-safe exception count is still loading.", "Open a source-owned workflow.", and "Only panels entitled for your current role and backed by an available source appear here."
- **The frame drifted from the kit it spawned.** The h1 is the 12px word "Dashboard" and the greeting is a paragraph. The greeting paints "Welcome back" and then swaps to "Good evening" after hydration on every cold load. The time of day uses the viewer's clock beside a studio-timezone date. The brief changes with the widget arrangement and never mentions money. The strip is a fork of `HorizonStats` without tones or filtered links. Local copies of `CalmState`, tag, and chip exist. Class start times render in the warning wash. Six references to the banned cobalt token remain. The week strip is decoration.
- **The phone is the least dense page in the product.** On a 390 by 844 screen the first actionable row is 683 pixels down, the first button is Customize, every card has a forced minimum height, and the page is 2,840 pixels tall for a studio with one billing exception and four follow-ups.
- **Shell and navigation drift** (out of scope for this rebuild unless the owner opts in; see Phase 6): nine nav items in an order that tells no story, "Belt Tracker" and "Belt tests" as two pages, an Automations page whose only action links back to the dashboard, a dead non-Horizon palette and slug band in `frontend/src/components/dashboard-shell.module.css`, and a sidebar collapse state that resets on reload.

## 2. Goal and principles

The owner wants an Apple-like product: everything flows, nothing needs instructions, it makes sense from how it looks. Some customizability is welcome, but not the current form of it. Every decision in this rebuild follows these rules:

1. **Three questions, in order, each answered once.** What needs me. What is happening today. How is the studio doing. Everything else is one click away.
2. **Say it once.** A fact appears in exactly one place on the page. The stats strip summarises; the panels list; neither mirrors the other.
3. **Phone first.** The owner opens this between classes. The first screen on a phone must contain the first actionable row. Panels flow to their content. Nobody drags a canvas on a phone.
4. **Customization is what and in what order, never where.** Show or hide, reorder, and at most a Compact or Expanded choice where it changes content. The system owns geometry.
5. **Plain language.** Every sentence must be something the front-desk person could say aloud to the owner. No "summary", "contract", "bounded", "role-safe", "entitled", "source", "evidence", "snapshot", or "arrangement".
6. **Three states.** Loading, error, ready. Empty is a property of data. The words "Partial" and "Unavailable" never appear in the UI.
7. **Build on the kit, extend the kit.** Use `Header`, `HorizonPage`, `HorizonStats`, `HorizonPanel`, `CalmState`, `ToneTag`, `ToneChip`, and `Button`. When the page needs something the kit lacks, add it to the kit so other pages can use it. Never fork a kit component into a page-local copy.
8. **Delete, do not strand.** Old code that the new page does not use is removed in this rebuild, front and back, with its tests.

## 3. Team and delegation rules

You orchestrate. You do not write large bodies of code yourself. You plan, dispatch, integrate, verify, and report. Use these models for these jobs, and say in each dispatch which role the subagent holds.

**GPT 6.1 Sol subagents: exploration, tests, fixtures, scripts, and tightly scoped tasks.** Use Sol for reading and inventorying code, confirming how an existing page deep-links or how a store slice behaves, writing and rewriting tests, writing the preview-mode fixture payload, writing screenshot and census scripts, CSS-only tweaks against a precise spec, documentation updates, and deleting dead code once a spec names it. Every Sol dispatch gets a bounded file list, a crisp acceptance check, and a sentence saying what it must not touch. Prefer several small Sol tasks run in parallel over one large one.

**Opus 5.5 subagents: production code.** Use Opus 5.5 for the components, hooks, and stores that ship to users, for the backend endpoint, schema, and service, and for the preferences endpoint and migration. One Opus 5.5 subagent per module, each given the relevant spec section verbatim, explicit file ownership, and the tests it must make pass. Two Opus 5.5 subagents never own the same file at the same time.

**Fable 5.1: taste, product decisions, and the big picture.** Consult Fable at every gate listed in Section 5, and whenever a product question arises that this brief does not settle. Fable reviews screenshots, decides between options, writes or approves the owner-facing copy, approves the content model and the Edit Home design, and does the final visual review. Give Fable the screenshots, the question, and the options with your recommendation. Do not give Fable large code tasks.

**GPT 6 Astra: final code safety and quality review.** After a phase's tests pass and before its pull request is marked ready, dispatch Astra to review the diff for correctness, safety, security, and quality. Astra must specifically review the new backend endpoint, the preferences persistence and its row-level security, and any change to proxy or auth-adjacent code. Treat Astra's findings as input, not a mandate: fix real correctness and safety issues, defer polish to a listed follow-up, and cap review rounds at two per pull request to avoid fix loops. Record each finding's disposition in the plan file.

**Rules that bind everyone.**

- Subagents do not receive production or deployment authority. Nobody touches Vercel, Render, Supabase linked-project state, or deployment secrets. Database work runs only against the local ephemeral cluster.
- Parallelize independent tasks in one dispatch. Serialize anything that touches the same file.
- Every subagent reports back with the files it changed, the commands it ran, and their output. You verify before you integrate.
- Commits use the repo's existing style: a sentence-case imperative subject that says what changed and why, no prefixes.

## 4. Specification

### 4.1 Page frame

Use the shared `Header` from `frontend/src/components/header.tsx` with `HorizonPage` beneath it.

- **Title (the h1):** the greeting. "Good morning, Ronak." The period comes from the studio's timezone, which the config store already knows, and must be resolved at the first client render so the text never changes after it appears. If no usable first name exists, "Good morning." Name resolution keeps the current rules: first word of the display name, else the legal first name, never an email.
- **Eyebrow:** the studio business date, "Saturday, October 10". In preview mode append " · Preview data". No "Dashboard", no studio name, no "Live studio data" badge.
- **Description:** one sentence. It subordinates clauses and includes money when money matters: "Three classes today, two follow-ups overdue, and one failed payment to chase." or "Nothing needs you right now. Two classes today." Number words up to ten, then digits. The sentence appears only when its inputs have settled; while loading, the slot is empty. Fable writes or approves the grammar table. The current gating in `buildHorizonBrief` is correct and its tests should carry over in spirit.
- **Actions:** two `Button`s, Add student as secondary and Take attendance as primary, filtered by role exactly as the current quick actions are. Nothing about editing the layout lives in the Header.
- **Hills:** this page keeps the hero hills variant as the single page allowed the wide shot. Apply the band's rules to it: hide the sun on phones, use the same gradient stop and bottom padding so the stats strip sits on the ridge at the kit's offset. Drop the page-only paper grain, or move it into `Header` so every page has it. Fable decides which.

### 4.2 Content model

Three bands, then optional panels. The bands are fixed in this order and cannot be hidden.

**Band one: today's numbers.** The kit's `HorizonStats`, four items, fixed per role, each with a tone and an `href` to the filtered view it summarises.

| Role | Four stats |
| --- | --- |
| admin | Needs attention · Classes today · Follow-ups due · Billing exceptions |
| front_desk | Needs attention · Classes today · Follow-ups due · Active students |
| instructor | Classes today · Ready to promote · Active students · Attendance |

Tones: alert when a count of exceptions or overdue items is above zero, warn for due today or drifting, calm for zero exceptions, neutral for plain counts. Notes carry words: "Oldest 2 days overdue", "All payments clear", "7 of 74 seats, 30 days". Links go to the view that explains the number, for example the Leads board with its due-today focus and the Billing invoices tab. A Sol subagent confirms the exact deep-link forms each page supports before Opus 5.5 wires them. These stats replace the Student Pulse, Attendance, Billing Exceptions, and Emergency Contacts cards. Those cards are not rebuilt.

**Band two: Needs attention.** One worklist panel. Rows, each with a chip, a one-line title with its count, one meta line, one visible action label, and an `href` to the filtered source:

- billing exceptions (admin, front_desk)
- follow-ups overdue or due today (admin, front_desk)
- students inactive fourteen or more days
- students missing a named emergency contact (admin, front_desk)
- setup steps remaining (admin, only until setup is complete; then the row disappears for good)
- promotions awaiting approval (admin, instructor)

Order by severity then age. Show up to six rows. Empty is the kit's `CalmState` with "All clear" and the detail "Nothing needs you right now." The existing worklist pattern in `AttentionContent` is the best-executed "one click opens the thing" in the product; promote it into the kit as `HorizonWorkRow` so Leads and Billing can adopt it later.

**Band three: Today's classes.** The agenda: time, class name, checked-in over expected, and a "Take attendance" action per row that opens the schedule page on that session. Full width on phones. Empty is `CalmState` with "No classes today" and "The mat is quiet. Nothing to check in." The week strip is removed unless Fable decides each day should link to the schedule and mark days with classes; a static row is not kept.

**Optional panels**, each a `HorizonPanel` with a visible source link using the lucide arrow, never a unicode arrow, and never an arrow-only link at any size:

- Follow-ups: the due list with names, due notes, and a lead link. Default on for admin and front_desk.
- Ready to promote: student, current and next belt with swatches, classes at rank, link to the belt tracker. Default on for admin and instructor.
- Recent students: default off, available in Edit Home.

Deleted outright: Quick Actions (the Header and the sidebar already carry those actions), Student Pulse, Attendance, Billing Exceptions, Emergency Contacts, Setup Progress (now a Needs attention row), Revenue Due and Saved Report (stubs), and the week strip unless Fable keeps a linked version.

### 4.3 Edit Home: the customization model

This replaces the grid, the catalog's size system, drag, resize, keyboard move, the panel library, the reset button in the Header, and the local-storage layout store.

- **Trigger:** a ghost icon button labelled "Edit Home" at the top right of the panels region, below the bands. On phones it sits in the same place. It is never in the Header action row.
- **The sheet:** a `role="dialog"` titled "Edit Home". On desktop it is a right-side sheet; on phones a full-height bottom sheet. It lists the fixed bands first, greyed, with the note "Always shown". Then each optional panel as a row: a drag handle, the panel title, a switch. Panels that declare two sizes show a Compact or Expanded segmented control under the title. A "Reset to defaults" link sits at the bottom. A single "Done" closes it. There is no Cancel, because every change is a visible toggle the owner can flip back.
- **Live preview:** changes apply to the page behind the sheet as they are made, animated with the existing position-settle technique, honouring reduced motion.
- **Keyboard:** rows are focusable; with the handle focused, Up and Down move the row; switches are real switches; Escape closes.
- **Data shape:**

```ts
type HomePanelId = "follow_ups" | "ready_to_promote" | "recent_students"; // grows as panels are added
type HomePreferences = {
  version: 1;
  order: HomePanelId[];                  // visible optional panels, in order
  hidden: HomePanelId[];                 // explicit, so later-added defaults still appear
  size: Partial<Record<HomePanelId, "compact" | "expanded">>;
};
```

- **Reconcile on every read:** drop unknown or non-entitled ids, append newly entitled defaults not in `hidden`, clamp sizes to what the panel declares. Keep the hygiene of the current reconcile; lose its coordinates.
- **Persistence:** one row per user and studio on the server, with row-level security that lets a user read and write only their own row for studios they belong to. The client reads it during bootstrap or through one small GET, writes through one PUT debounced by a few hundred milliseconds, keeps a local-storage copy keyed by user and studio for an instant first paint, and purges that copy on sign-out through `clearStoredStudioSessionCookies` in `frontend/src/lib/store-session-cookies.ts`. Role changes keep the row and reconcile it. The migration follows `supabase/AGENTS.md` and is verified on the local ephemeral cluster.
- **Not in version one:** direct-manipulation drag of panels on the canvas. If the owner wants it later, it is insertion-index drag between panels, never cell placement, and it is a separate brief.

### 4.4 Data contract

One endpoint, one typed payload, role-shaped by absence. Build it as a new route, `GET /dashboard/home`, with a new Pydantic schema, and leave the old summary route in place until Phase 5 deletes it.

```
{
  studio:  { id, name, timezone, today },            // the server is the clock authority
  viewer:  { role, first_name },
  needs_attention: { items: [{ kind, count, label, note, href, tone, oldest_date? }] },
  classes_today:   { total, overflow, rows: [{ id, name, starts_at, ends_at, checked_in, expected, capacity }] },
  stats: {
    active_students: { total, active, trialing, on_hold },
    attendance:      { window_days, sessions, seats_filled, capacity },
    follow_ups:      { due_count, overdue_count, oldest_due_date },       // absent for instructors
    billing:         { attention_count },                                  // absent for instructors
    promotions:      { ready_count, needs_approval }
  },
  follow_ups:       { rows: [{ id, name, next_step, follow_up_date }] },   // absent for instructors
  ready_to_promote: { rows: [{ student_id, name, from: { name, color }, to: { name, color }, classes_at_rank }] },
  recent_students:  [{ id, name, status, started_on }]
}
```

Rules:

- A section the role may not see is absent, not flagged. A section the server cannot compute is absent and the client hides its panel.
- Counts and the rows that summarise them come from the same query and are ordered the way the UI says. Follow-ups are oldest first.
- Promotions are computed server-side for the primary ladder, bounded to six rows plus a count, so the page issues no belt requests. If this needs SQL, add a new migration; never edit an old one.
- Keep the fifteen-second per-studio fact cache and its invalidation. Collapse the double Pydantic validation.
- Regenerate the frontend contract types with `npm run generate:api-types` and check them with `npm run check:api-types`.
- Bootstrap for the dashboard view should load at most studio and programs. Students, ladders, and leads are not needed by the new page.

### 4.5 Client architecture

Four layers, each with one job. New files live under `frontend/src/components/dashboard/home/` and `frontend/src/lib/dashboard/` so that old and new coexist until Phase 5 deletes the old.

- `lib/dashboard/use-home.ts`: one hook that owns the fetch, dedupes in-flight requests, revalidates on mount, on window focus, and after a command using the existing `markDashboardFactsChanged` signal that `frontend/src/lib/api.ts` fires from `frontend/src/lib/dashboard-freshness.ts` (keep or move that small module; it is the one piece of the old data layer the new hook still needs), keyed by studio, role class, and the server's `today`. It integrates with `StoreProvider` for identity and with `useRetainedState` for instant revisit paint, keyed explicitly by user, studio, and today.
- `lib/dashboard/home-model.ts`: a pure mapper from payload or error to typed sections with `status: "loading" | "error" | "ready"`. No string metrics; numbers stay numbers. No parsing of strings that another layer joined.
- `lib/dashboard/home-preferences.ts`: the preferences store, reconcile, and persistence described in 4.3.
- `components/dashboard/home/`: `home-page.tsx`, `needs-attention.tsx`, `todays-classes.tsx`, `follow-ups.tsx`, `ready-to-promote.tsx`, `recent-students.tsx`, `edit-home-sheet.tsx`, each a thin typed renderer on kit primitives.
- Preview mode is a fixture payload in the same shape, in `lib/dashboard/preview-home-payload.ts`, selected where `NEXT_PUBLIC_PREVIEW_MODE` is read today in `frontend/src/lib/store.tsx`. No preview branches anywhere in the model or components.
- The route file `frontend/src/app/(dashboard)/dashboard/page.tsx` stays at the same URL and becomes a few lines.

### 4.6 Loading, revisit, error, midnight

- **Cold:** the shell's identity skeleton, then a placeholder that reserves the three bands with their real titles and reveals after 220 milliseconds using `koaryu-skeleton-reveal`, then the whole page flips to ready at once when the single payload lands. No per-panel status stamps, no tinted panels.
- **Revisit:** paint the retained payload instantly, revalidate silently, swap in place.
- **Error:** keep the last known data, show one `CalmState` with alert tone, the sentence "Couldn't refresh. Showing what we had as of 9:41.", and one retry `Button`. If there is no last data, the same state without the "as of" clause.
- **Midnight:** trust `studio.today` from the server. Refetch on focus and on a sixty-second timer. Never blank the page on a client-side date flip.
- **Readiness instrumentation:** keep `markDashboardReadiness` with its identity, useful, and complete stages and keep the `data-koaryu-dashboard-shell-ready` and `data-koaryu-dashboard-data-ready` attributes, because `frontend/scripts/capture-dashboard-performance.mjs`, `frontend/e2e/performance-navigation.spec.ts`, and several mounted tests wait on them. Define useful as "the bands have rendered real data" and complete as "the payload has rendered". Drop `legacyComplete` only in the same pull request that updates `frontend/src/lib/performance.ts`, its tests, and `docs/performance-rollout.md`. The owner decides whether changing stage semantics is acceptable for the performance regression gate; default to keeping the attribute names and meanings stable.

### 4.7 Copy

Every string that an owner can read is written or approved by Fable and collected in one file, `lib/dashboard/home-copy.ts`, so it can be reviewed in one place. Replacements for strings that exist today:

| Today | Instead |
| --- | --- |
| Open obligations across the current studio summary. | (no sentence; the rows speak) |
| No known obligations need action right now. | Nothing needs you right now. |
| Today's bounded class schedule is still loading. | Checking today's classes. |
| Today's class schedule could not be loaded. | Couldn't load today's classes. |
| Waiting for an exact summary or a complete roster. | Counting students. |
| The billing-safe exception count is still loading. | Checking payments. |
| Payment records need review in Billing. | One payment needs a look. |
| Open follow-ups due through today. | Two follow-ups due today. |
| Showing saved eligibility. The latest check failed; retry dashboard data. | Showing the last check. Couldn't refresh. |
| Open a source-owned workflow. | (deleted with the panel) |
| Arrangement changes stay on this browser for this user, studio, and role. Escape cancels an active move; Cancel restores the entry snapshot. | (deleted; the sheet needs no notice) |
| Only panels entitled for your current role and backed by an available source appear here. | (deleted) |
| Your role-safe arrangement is still loading. | (deleted) |
| Some Dashboard data is unavailable | Couldn't refresh |

### 4.8 Phone

- The first actionable row is visible on a 390 by 844 screen without scrolling. Verify this with a Playwright census at the Phase 3 gate.
- Panels flow to content height. No forced minimum heights.
- Edit Home is a bottom sheet. There is no canvas drag.
- The stats strip is a two-by-two grid as today.
- Buttons stay at least forty pixels tall and the Header actions do not wrap into a third row.

### 4.9 Visual and token rules

All rules in the Horizon bullet of `frontend/AGENTS.md` apply, plus these fixes to things the current page gets wrong:

- No `--product-cobalt` anywhere in dashboard files. Use `--product-focus` or `--product-wood`.
- Class start times are plain tabular text, not the warning wash. Tone means state.
- Radii: panels sixteen, controls ten, tags pill. No eight-pixel control-shaped elements.
- Clickable things are at least forty pixels tall.
- Two shadows only, card and lifted. No bespoke shadows.
- Body fourteen, meta thirteen soft ink, panel titles sixteen at seven hundred, numbers tabular and heavy. The h1 uses the Header's scale.
- Check light and dark at 390, 834, 1000 by 614, and 1440 by 900.

### 4.10 Contracts to preserve or migrate deliberately

- The readiness attributes and stages in 4.6.
- The retained-state rules in `frontend/README.md`: retained data never grants access or proves a mutation is safe.
- The landing page's day timeline crops a real "Classes Today" component into `frontend/public/marketing/product/day-dashboard.webp` through `frontend/scripts/capture-landing-day-shots.mjs`. After Phase 3, update that script's selector for the new agenda panel and recapture, then run the landing checks named in `frontend/AGENTS.md`.
- The sign-out purge in `frontend/src/lib/store-session-cookies.ts` must drop the new preferences cache key and may drop the old layout key.
- `frontend/e2e/dashboard-widget-interactions.spec.ts` tests the grid. Replace it with an Edit Home spec in Phase 4.
- Mounted tests that merely wait for the dashboard to be ready keep working if the attributes stay. The fifteen `frontend/tests/dashboard-*.test.mjs` files test the old design; rewrite or delete each one deliberately, listed in the plan file.

## 5. Phases and gates

Each phase ends with the verification in Section 6 for the areas it touched, an Astra review, and one pull request. Do not start a phase's production code before its gate has passed.

**Phase 0: inventory and decisions.** Sol subagents, in parallel: confirm the deep-link forms for Leads, Billing, Schedule, and Belt Tracker; inventory every consumer of the old dashboard modules and tests; list what the schedule page needs to open a specific session for attendance; measure the current phone and desktop first-screen metrics with a Playwright census against a preview-mode server started with `NEXT_PUBLIC_PREVIEW_MODE=true npx next dev -p 4115` from `frontend/`. You then write the plan file and put the open decisions in Section 9 to the owner. **Gate:** Fable approves the content model in 4.2, the per-role stats and defaults, the Edit Home design in 4.3, and the copy table in 4.7, with any changes recorded in the plan file.

**Phase 1: backend contract.** Opus 5.5 builds the `GET /dashboard/home` route, schema, and service, including server-side promotions and the trimmed bootstrap for the dashboard view. Sol writes the backend tests and the API-type regeneration. If a migration is needed, Opus 5.5 writes it and Sol runs `npm run check:supabase-contracts-local`. **Gate:** tests green, `npm run check:api-types` green, Astra review done.

**Phase 2: client data layer.** Opus 5.5 builds `use-home.ts`, `home-model.ts`, and the preview fixture selection. Sol writes `preview-home-payload.ts` with the demo studio's data and unit tests for the mapper covering loading, error, ready, role absence, and empty sections. **Gate:** tests green, Astra review done.

**Phase 3: frame and bands on the kit.** Opus 5.5 builds the page, the three bands, the optional panels, and the `HorizonWorkRow` kit primitive. Sol handles CSS adjustments against the spec, the placeholder, and the screenshot script. **Gate:** Fable reviews screenshots at all four sizes in both themes plus the phone census; the first actionable row is on the phone's first screen; no fact appears twice; the greeting never changes after first paint. Astra review done.

**Phase 4: Edit Home.** Opus 5.5 builds the preferences store, the sheet, the server endpoint, and the migration with row-level security. Sol writes the store and reconcile tests and the replacement end-to-end spec. **Gate:** Fable tries the sheet on desktop and phone screenshots and approves the interaction; Astra reviews persistence and security specifically.

**Phase 5: delete and document.** Sol removes the old components, libraries, catalog, layout store, geometry, old tests, the old summary route and its Python builder modules once nothing references them, and the dead non-Horizon palette if the owner agrees. Opus 5.5 confirms no live path remains before each deletion batch. Sol updates `frontend/README.md`, `frontend/AGENTS.md`, `docs/performance-rollout.md` if stages changed, recaptures the landing crop, and runs the full verification. **Gate:** full build green, Astra review of the deletion diff.

**Phase 6, only with explicit owner approval:** shell and navigation. Rename Dashboard to Home, Belt Tracker to Belts, Settings to Studio; reorder to Home, Schedule, Students, Leads, Billing; move Reports, Automations, and Studio behind the account menu or a More item; add a five-slot phone bottom bar; persist the sidebar collapse state; delete the slug band and the dead palette; settle the typeface. This touches every page and its tests. Do not start it inside this rebuild without a written yes from the owner.

## 6. Verification

Run the narrowest checks first and the broad ones at phase ends.

- Frontend lint on touched files: `cd frontend && npm run lint -- <paths>`
- Frontend tests: `cd frontend && npm run test`
- Frontend formatting: `cd frontend && npm run format:check`
- Frontend build, required for routing, auth, and environment-sensitive changes: `cd frontend && npm run build`
- Backend tests: `cd backend && venv/bin/python -m pytest <tests>`
- Backend formatting: `cd backend && venv/bin/python -m ruff format --check .`
- Contract types: `npm run generate:api-types` then `npm run check:api-types`
- Database, if a migration is added: `npm run check:supabase-contracts-local`, plus `supabase migration up --local` and `supabase db lint --local --fail-on error` per `supabase/AGENTS.md`
- Preview smoke: `cd frontend && npm run test:e2e:preview-smoke` against a running preview-mode frontend
- Landing checks after recapturing the dashboard crop, as named in `frontend/AGENTS.md`
- Screenshots: a Sol-written Playwright script against the preview server at 390 by 844, 834 by 1112, 1000 by 614, and 1440 by 900, light and dark, including the Edit Home sheet open

## 7. Definition of done

- The page answers the three questions in order and no fact appears twice.
- The greeting is the h1, computed on the studio clock, and never changes after first paint.
- Cold load issues at most three requests for an admin; a revisit issues one.
- Loading, error, and ready are the only states; no "Partial" or "Unavailable" text exists in the dashboard files.
- Edit Home works with pointer, touch, and keyboard; preferences persist on the server and survive a role change and a new device.
- On a 390 by 844 phone the first actionable row is visible without scrolling and no panel has a forced minimum height.
- No dashboard file references `--product-cobalt`, a unicode arrow, or a page-local copy of a kit primitive.
- Every owner-facing string lives in `home-copy.ts` and reads as plain speech.
- The old components, libraries, tests, summary route, and Python builder are deleted, and nothing in the repo references them.
- Readiness attributes still satisfy `capture-dashboard-performance.mjs` and `performance-navigation.spec.ts`, or those were migrated in the same change with their docs.
- `day-dashboard.webp` is recaptured and the landing checks pass.
- `frontend/README.md` and `frontend/AGENTS.md` describe the new page, and the plan file records every Astra finding and its disposition.
- All pull requests have passed Astra review and the full verification in Section 6.

## 8. Out of scope, and things never to do

- Do not change navigation, the shell, or other pages except where this brief names them (the kit primitive, the sign-out purge, the landing capture script, and Phase 6 if approved).
- Do not build canvas drag, resize handles, or any coordinate-based layout.
- Do not keep the old page behind a flag. The new page replaces it in the same pull request series.
- Do not edit old Supabase migrations. Add new ones.
- Do not touch deployment configuration, secrets, linked Supabase state, or production data.
- Do not merge to `main` or release anything. Release is the owner's call under `docs/cutover-gates.md`.

## 9. Decisions for the owner, with the recommended default

Put these to the owner at the end of Phase 0. Proceed with the defaults if the owner does not object.

1. Keep the URL at `/dashboard` and the nav label "Dashboard" for now. Default: yes; renaming belongs to Phase 6.
2. Persist Home preferences on the server with a new table and migration. Default: yes.
3. Keep the readiness attribute names and stage meanings stable for the performance gate. Default: yes.
4. Remove the week strip rather than rebuild it with links. Default: remove; Fable may overrule with a linked design.
5. Delete the Quick Actions panel. Default: yes.
6. Move the paper grain into `Header` for every page, or drop it. Default: Fable decides at the Phase 3 gate.
7. Phase 6 shell and navigation changes. Default: no, not in this rebuild.
